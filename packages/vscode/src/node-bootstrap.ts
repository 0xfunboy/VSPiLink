import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { REQUIRED_NODE_VERSION } from "./security.js";

const DOWNLOAD_ROOT = `https://nodejs.org/dist/v${REQUIRED_NODE_VERSION}`;
const MAX_ARCHIVE_BYTES = 96 * 1024 * 1024;

export interface ManagedNodeAsset {
  archiveName: string;
  expectedSha256: string;
  archiveKind: "tar.xz" | "tar.gz";
  extractedDirectory: string;
}

export interface ManagedNodeBootstrapOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  dataHome?: string;
  fetch?: typeof globalThis.fetch;
  extractArchive?: (archivePath: string, destination: string, kind: ManagedNodeAsset["archiveKind"]) => void;
  detectVersion?: (executable: string) => string;
  report?: (message: string) => void;
}

export interface ManagedNodeRuntime {
  executable: string;
  version: string;
  installed: boolean;
}

/** Selects the pinned official Node archive supported by this release. */
export function managedNodeAsset(platform: NodeJS.Platform, arch: string): ManagedNodeAsset {
  const key = `${platform}:${arch}`;
  const assets: Record<string, Omit<ManagedNodeAsset, "extractedDirectory">> = {
    "linux:x64": {
      archiveName: `node-v${REQUIRED_NODE_VERSION}-linux-x64.tar.xz`,
      expectedSha256: "55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742",
      archiveKind: "tar.xz",
    },
    "linux:arm64": {
      archiveName: `node-v${REQUIRED_NODE_VERSION}-linux-arm64.tar.xz`,
      expectedSha256: "58c9520501f6ae2b52d5b210444e24b9d0c029a58c5011b797bc1fe7105886f6",
      archiveKind: "tar.xz",
    },
    "darwin:x64": {
      archiveName: `node-v${REQUIRED_NODE_VERSION}-darwin-x64.tar.gz`,
      expectedSha256: "dfd0dbd3e721503434df7b7205e719f61b3a3a31b2bcf9729b8b91fea240f080",
      archiveKind: "tar.gz",
    },
    "darwin:arm64": {
      archiveName: `node-v${REQUIRED_NODE_VERSION}-darwin-arm64.tar.gz`,
      expectedSha256: "e1a97e14c99c803e96c7339403282ea05a499c32f8d83defe9ef5ec66f979ed1",
      archiveKind: "tar.gz",
    },
  };
  const selected = assets[key];
  if (!selected) {
    throw new Error(`Automatic Node ${REQUIRED_NODE_VERSION} provisioning is unsupported on ${platform}/${arch}. Install that exact version manually and set vspilink.nodeExecutable.`);
  }
  return {
    ...selected,
    extractedDirectory: selected.archiveName.replace(/\.tar\.(?:xz|gz)$/u, ""),
  };
}

/**
 * Installs the exact pinned Node runtime in per-user application data. The
 * archive is accepted only from nodejs.org over HTTPS and only after its
 * release-specific SHA-256 matches. Existing runtimes are preserved as a
 * backup before the verified staging directory is promoted.
 */
export async function provisionManagedNodeRuntime(
  options: ManagedNodeBootstrapOptions = {},
): Promise<ManagedNodeRuntime> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const asset = managedNodeAsset(platform, arch);
  const dataHome = path.resolve(options.dataHome || process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"));
  const managedParent = path.join(dataHome, "vspilink");
  const managedRoot = path.join(managedParent, `node-v${REQUIRED_NODE_VERSION}`);
  const binary = path.join(managedRoot, "bin", "node");
  const detectVersion = options.detectVersion ?? detectNodeVersion;
  if (detectVersion(binary) === `v${REQUIRED_NODE_VERSION}`) {
    return { executable: binary, version: `v${REQUIRED_NODE_VERSION}`, installed: false };
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  const report = options.report ?? (() => undefined);
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "vspilink-node-"));
  try {
    const sourceUrl = `${DOWNLOAD_ROOT}/${asset.archiveName}`;
    report(`Downloading verified Node ${REQUIRED_NODE_VERSION} runtime…`);
    const response = await fetchImpl(sourceUrl, {
      method: "GET",
      redirect: "error",
      headers: { accept: "application/octet-stream" },
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok || response.url && response.url !== sourceUrl) {
      throw new Error(`Node runtime download failed with HTTP ${response.status}.`);
    }
    const declaredLength = Number(response.headers.get("content-length") || "0");
    if (declaredLength && (!Number.isSafeInteger(declaredLength) || declaredLength > MAX_ARCHIVE_BYTES)) {
      throw new Error("The Node runtime archive exceeds the safe download limit.");
    }
    const archive = Buffer.from(await response.arrayBuffer());
    if (archive.length === 0 || archive.length > MAX_ARCHIVE_BYTES) {
      throw new Error("The Node runtime archive is empty or exceeds the safe download limit.");
    }
    const actualSha256 = createHash("sha256").update(archive).digest("hex");
    if (actualSha256 !== asset.expectedSha256) {
      throw new Error("The downloaded Node runtime failed pinned SHA-256 verification.");
    }
    const archivePath = path.join(temporaryDirectory, asset.archiveName);
    fs.writeFileSync(archivePath, archive, { mode: 0o600, flag: "wx" });
    const extractionRoot = path.join(temporaryDirectory, "extracted");
    fs.mkdirSync(extractionRoot, { mode: 0o700 });
    (options.extractArchive ?? extractArchive)(archivePath, extractionRoot, asset.archiveKind);
    const extractedRoot = path.join(extractionRoot, asset.extractedDirectory);
    const extractedBinary = path.join(extractedRoot, "bin", "node");
    if (detectVersion(extractedBinary) !== `v${REQUIRED_NODE_VERSION}`) {
      throw new Error(`The verified archive did not contain Node ${REQUIRED_NODE_VERSION}.`);
    }

    fs.mkdirSync(managedParent, { recursive: true, mode: 0o700 });
    const stagingRoot = path.join(managedParent, `.node-v${REQUIRED_NODE_VERSION}.staging-${randomUUID()}`);
    fs.cpSync(extractedRoot, stagingRoot, { recursive: true, errorOnExist: true, force: false });
    if (fs.existsSync(managedRoot)) {
      fs.renameSync(managedRoot, `${managedRoot}.backup-${Date.now()}-${randomUUID()}`);
    }
    fs.renameSync(stagingRoot, managedRoot);
    if (detectVersion(binary) !== `v${REQUIRED_NODE_VERSION}`) {
      throw new Error("Managed Node verification failed after installation.");
    }
    report(`Node ${REQUIRED_NODE_VERSION} installed and verified.`);
    return { executable: binary, version: `v${REQUIRED_NODE_VERSION}`, installed: true };
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function extractArchive(archivePath: string, destination: string, kind: ManagedNodeAsset["archiveKind"]): void {
  const flag = kind === "tar.xz" ? "-xJf" : "-xzf";
  const result = spawnSync("tar", [flag, archivePath, "-C", destination], {
    shell: false,
    stdio: "pipe",
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const detail = (result.stderr || result.error?.message || "archive extraction failed").replace(/[\r\n\0]+/gu, " ").slice(0, 500);
    throw new Error(`The verified Node archive could not be extracted: ${detail}`);
  }
}

function detectNodeVersion(executable: string): string {
  const result = spawnSync(executable, ["--version"], {
    shell: false,
    stdio: "pipe",
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
  });
  return (result.stdout || result.stderr || "").trim();
}
