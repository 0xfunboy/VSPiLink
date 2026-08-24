import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const MANAGED_CLOUDFLARED_VERSION = "2026.7.2";
export const MAX_CLOUDFLARED_DOWNLOAD_BYTES = 128 * 1024 * 1024;

const DOWNLOAD_ROOT = `https://github.com/cloudflare/cloudflared/releases/download/${MANAGED_CLOUDFLARED_VERSION}`;
const MAX_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1_000;
const VERSION_PROBE_TIMEOUT_MS = 10_000;
const ALLOWED_RELEASE_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);

export interface ManagedCloudflaredAsset {
  readonly assetName: string;
  readonly downloadUrl: string;
  readonly expectedSha256: string;
  readonly version: string;
}

export interface ManagedCloudflaredBootstrapOptions {
  /** Absolute path in a private extension-host directory. */
  readonly destination: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly detectVersion?: (executable: string) => string;
  readonly report?: (message: string) => void;
}

export interface ManagedCloudflaredBinary {
  readonly executable: string;
  readonly version: string;
  readonly installed: boolean;
}

export interface ManagedCloudflaredCandidateFacts {
  readonly sha256: string;
  readonly detectedVersion: string;
  readonly mode: number;
}

/** Select the release-pinned Cloudflare binary supported by the extension host. */
export function managedCloudflaredAsset(platform: NodeJS.Platform, arch: string): ManagedCloudflaredAsset {
  if (platform !== "linux" || (arch !== "x64" && arch !== "arm64")) {
    throw new Error(
      `Automatic cloudflared ${MANAGED_CLOUDFLARED_VERSION} provisioning is unsupported on ${platform}/${arch}. ` +
      "Install that exact version manually and configure its explicit path.",
    );
  }
  const assetName = `cloudflared-linux-${arch === "x64" ? "amd64" : "arm64"}`;
  return {
    assetName,
    downloadUrl: `${DOWNLOAD_ROOT}/${assetName}`,
    expectedSha256: arch === "x64"
      ? "ec905ea7b7e327ff8abdde8cb64697a2152de74dbcdbf6aec9db8364eb3886cd"
      : "405df476437e027fc6d18729a5a77155c0a33a6082aeee60a799a688f3052e66",
    version: MANAGED_CLOUDFLARED_VERSION,
  };
}

/**
 * Pure reuse decision shared by the filesystem inspection and focused tests.
 * The caller must establish that the candidate is a regular, non-symlink file.
 */
export function managedCloudflaredCandidateMatches(
  asset: ManagedCloudflaredAsset,
  facts: ManagedCloudflaredCandidateFacts,
): boolean {
  return facts.sha256 === asset.expectedSha256 &&
    (facts.mode & 0o100) !== 0 &&
    (facts.mode & 0o022) === 0 &&
    detectedVersionMatches(facts.detectedVersion, asset.version);
}

/**
 * Provision the release-pinned cloudflared binary on the extension host.
 *
 * The destination directory must be an owner-private real directory. The
 * verified payload is written there under a unique name and atomically renamed
 * only after its bounded HTTPS download, SHA-256 check, and version probe pass.
 */
export async function provisionManagedCloudflared(
  options: ManagedCloudflaredBootstrapOptions,
): Promise<ManagedCloudflaredBinary> {
  const asset = managedCloudflaredAsset(options.platform ?? process.platform, options.arch ?? process.arch);
  const destination = validateDestination(options.destination);
  const directory = ensurePrivateRealDirectory(path.dirname(destination));
  assertSafeDestinationEntry(destination);

  const detectVersion = options.detectVersion ?? detectCloudflaredVersion;
  const existing = await inspectExistingCandidate(destination, asset, detectVersion);
  if (existing) {
    return { executable: destination, version: asset.version, installed: false };
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  const report = options.report ?? (() => undefined);
  const temporary = path.join(directory.path, `.cloudflared.staging-${randomUUID()}`);
  try {
    report(`Downloading verified cloudflared ${asset.version}…`);
    const sha256 = await downloadPinnedRelease(fetchImpl, asset, temporary);
    if (sha256 !== asset.expectedSha256) {
      throw new Error("The downloaded cloudflared binary failed pinned SHA-256 verification.");
    }
    fs.chmodSync(temporary, 0o700);
    const temporaryStat = fs.lstatSync(temporary);
    if (!isOwnedRegularFile(temporaryStat) || temporaryStat.nlink !== 1) {
      throw new Error("The staged cloudflared binary is not a safe regular file.");
    }
    if (!detectedVersionMatches(detectVersion(temporary), asset.version)) {
      throw new Error(`The verified cloudflared payload is not version ${asset.version}.`);
    }

    assertSamePrivateDirectory(directory);
    assertSafeDestinationEntry(destination);
    fs.renameSync(temporary, destination);
    report(`cloudflared ${asset.version} installed and verified.`);
    return { executable: destination, version: asset.version, installed: true };
  } finally {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Best-effort cleanup must not replace the original security failure.
    }
  }
}

interface PrivateDirectoryIdentity {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
}

function validateDestination(value: string): string {
  if (!value || value.includes("\0") || !path.isAbsolute(value)) {
    throw new Error("The managed cloudflared destination must be an absolute path.");
  }
  const normalized = path.normalize(value);
  if (normalized !== value || normalized === path.parse(normalized).root) {
    throw new Error("The managed cloudflared destination must be a normalized file path.");
  }
  return normalized;
}

function ensurePrivateRealDirectory(directory: string): PrivateDirectoryIdentity {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !isOwned(stat)) {
    throw new Error("The managed cloudflared directory must be a real directory owned by the current user.");
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error("The managed cloudflared directory must not be accessible by group or other users.");
  }
  if (fs.realpathSync(directory) !== directory) {
    throw new Error("The managed cloudflared directory must not traverse symbolic links.");
  }
  return { path: directory, device: stat.dev, inode: stat.ino };
}

function assertSamePrivateDirectory(expected: PrivateDirectoryIdentity): void {
  const current = ensurePrivateRealDirectory(expected.path);
  if (current.device !== expected.device || current.inode !== expected.inode) {
    throw new Error("The managed cloudflared directory changed during installation.");
  }
}

function assertSafeDestinationEntry(destination: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(destination);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return;
    throw new Error("The managed cloudflared destination could not be inspected safely.");
  }
  if (stat.isSymbolicLink() || !stat.isFile() || !isOwned(stat) || stat.nlink !== 1) {
    throw new Error("The managed cloudflared destination must be an owned, non-symlink regular file.");
  }
}

async function inspectExistingCandidate(
  destination: string,
  asset: ManagedCloudflaredAsset,
  detectVersion: (executable: string) => string,
): Promise<boolean> {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(destination);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return false;
    throw new Error("The managed cloudflared destination could not be inspected safely.");
  }
  if (stat.isSymbolicLink() || !stat.isFile() || !isOwned(stat) || stat.nlink !== 1) {
    throw new Error("The managed cloudflared destination must be an owned, non-symlink regular file.");
  }
  if (stat.size <= 0 || stat.size > MAX_CLOUDFLARED_DOWNLOAD_BYTES) return false;
  const sha256 = await sha256RegularFile(destination);
  if (sha256 !== asset.expectedSha256) return false;
  return managedCloudflaredCandidateMatches(asset, {
    sha256,
    detectedVersion: detectVersion(destination),
    mode: stat.mode,
  });
}

async function downloadPinnedRelease(
  fetchImpl: typeof globalThis.fetch,
  asset: ManagedCloudflaredAsset,
  destination: string,
): Promise<string> {
  let current = new URL(asset.downloadUrl);
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    assertAllowedReleaseUrl(current, asset, redirects === 0);
    let response: Response;
    try {
      response = await fetchImpl(current.href, {
        method: "GET",
        redirect: "manual",
        headers: { accept: "application/octet-stream" },
        signal,
      });
    } catch {
      throw new Error("The cloudflared download could not be completed securely.");
    }

    if (isRedirect(response.status)) {
      const location = response.headers.get("location");
      await cancelResponseBody(response);
      if (!location || redirects === MAX_REDIRECTS) {
        throw new Error("The cloudflared download exceeded the safe redirect policy.");
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new Error("The cloudflared download returned an invalid redirect.");
      }
      assertAllowedReleaseUrl(next, asset, false);
      current = next;
      continue;
    }

    const finalUrl = response.url ? safeResponseUrl(response.url) : current;
    assertAllowedReleaseUrl(finalUrl, asset, false);
    if (!response.ok || !response.body) {
      await cancelResponseBody(response);
      throw new Error(`The cloudflared download failed with HTTP ${response.status}.`);
    }
    assertDeclaredLength(response.headers.get("content-length"));
    return writeBoundedResponse(response.body, destination);
  }
  throw new Error("The cloudflared download exceeded the safe redirect policy.");
}

function assertAllowedReleaseUrl(url: URL, asset: ManagedCloudflaredAsset, initial: boolean): void {
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) {
    throw new Error("The cloudflared download attempted to leave the approved HTTPS release boundary.");
  }
  const hostname = url.hostname.toLowerCase();
  if (!ALLOWED_RELEASE_HOSTS.has(hostname)) {
    throw new Error("The cloudflared download attempted to leave the approved release hosts.");
  }
  if ((initial || hostname === "github.com") && url.href !== asset.downloadUrl) {
    throw new Error("The cloudflared download attempted to change the pinned GitHub release URL.");
  }
}

function safeResponseUrl(value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error("The cloudflared download returned an invalid final URL.");
  }
}

function assertDeclaredLength(value: string | null): void {
  if (!value) return;
  if (!/^\d+$/u.test(value) || BigInt(value) > BigInt(MAX_CLOUDFLARED_DOWNLOAD_BYTES)) {
    throw new Error("The cloudflared download exceeds the 128 MiB safety limit.");
  }
}

async function writeBoundedResponse(body: ReadableStream<Uint8Array>, destination: string): Promise<string> {
  const descriptor = fs.openSync(destination, "wx", 0o600);
  const hash = createHash("sha256");
  const reader = body.getReader();
  let received = 0;
  try {
    while (true) {
      let item: ReadableStreamReadResult<Uint8Array>;
      try {
        item = await reader.read();
      } catch {
        throw new Error("The cloudflared download stream ended unexpectedly.");
      }
      if (item.done) break;
      const chunk = item.value;
      received += chunk.byteLength;
      if (received > MAX_CLOUDFLARED_DOWNLOAD_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("The cloudflared download exceeds the 128 MiB safety limit.");
      }
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.byteLength) {
        const written = fs.writeSync(descriptor, chunk, offset, chunk.byteLength - offset);
        if (written <= 0) throw new Error("The cloudflared download could not be written safely.");
        offset += written;
      }
    }
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  if (received === 0) throw new Error("The cloudflared download was empty.");
  return hash.digest("hex");
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Response cleanup is deliberately silent and contains no remote output.
  }
}

async function sha256RegularFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function detectCloudflaredVersion(executable: string): string {
  const result = spawnSync(executable, ["--version"], {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer: 16 * 1024,
    timeout: VERSION_PROBE_TIMEOUT_MS,
    killSignal: "SIGKILL",
    windowsHide: true,
  });
  if (result.error || result.signal || result.status !== 0) return "";
  return `${result.stdout || ""}\n${result.stderr || ""}`.trim();
}

function detectedVersionMatches(output: string, expected: string): boolean {
  const escaped = expected.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:^|\\s)${escaped}(?:$|\\s|\\()`, "u").test(output.trim());
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isOwned(stat: fs.Stats): boolean {
  return typeof process.getuid !== "function" || stat.uid === process.getuid();
}

function isOwnedRegularFile(stat: fs.Stats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && isOwned(stat);
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
