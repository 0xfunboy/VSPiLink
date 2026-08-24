import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export const DEFAULT_CLOUDFLARE_LOGIN_TIMEOUT_MS = 10 * 60 * 1_000;
export const MAX_CLOUDFLARE_LOGIN_TIMEOUT_MS = 15 * 60 * 1_000;
export const MAX_CLOUDFLARE_LOGIN_OUTPUT_BYTES = 64 * 1_024;

const DEFAULT_POLL_INTERVAL_MS = 250;
const MAX_LOGIN_URL_LENGTH = 4_096;
const MAX_PENDING_LINE_LENGTH = 8_192;
const MAX_CERTIFICATE_SIZE = 1024 * 1024;

export type CloudflareLoginErrorCode =
  | "invalid-request"
  | "credential-file-unsafe"
  | "credential-inspection-failed"
  | "spawn-failed"
  | "output-limit"
  | "ambiguous-login-url"
  | "open-failed"
  | "process-error"
  | "process-exit"
  | "login-url-missing"
  | "certificate-missing"
  | "timeout";

export class CloudflareLoginError extends Error {
  constructor(readonly code: CloudflareLoginErrorCode, message: string) {
    super(message);
    this.name = "CloudflareLoginError";
  }
}

export interface CloudflareLoginRequest {
  /** Executable resolved on the extension host, never on the local UI host. */
  readonly executable: string;
  /** Absolute extension-host path where cloudflared writes cert.pem. */
  readonly certificatePath: string;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly signal?: AbortSignal;
}

export type CloudflareLoginResult =
  | { readonly status: "reused"; readonly certificatePath: string }
  | { readonly status: "authenticated"; readonly certificatePath: string }
  | { readonly status: "canceled" };

export interface CloudflareLoginFileStat {
  readonly size: number;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface CloudflareLoginFileSystem {
  lstat(filePath: string): PromiseLike<CloudflareLoginFileStat>;
}

export interface CloudflareLoginOutput {
  onData(listener: (chunk: string | Uint8Array) => void): () => void;
}

export interface CloudflareLoginProcess {
  readonly stdout?: CloudflareLoginOutput;
  readonly stderr?: CloudflareLoginOutput;
  onError(listener: () => void): () => void;
  onClose(listener: (exitCode: number | null) => void): () => void;
  kill(): void;
}

export interface CloudflareLoginSpawnOptions {
  readonly shell: false;
  readonly windowsHide: true;
  readonly stdio: readonly ["ignore", "pipe", "pipe"];
}

export type CloudflareLoginSpawn = (
  executable: string,
  args: readonly ["tunnel", "login"],
  options: CloudflareLoginSpawnOptions,
) => CloudflareLoginProcess;

export interface CloudflareLoginTime {
  now(): number;
  sleep(delayMs: number, signal?: AbortSignal): PromiseLike<void>;
}

export interface CloudflareLoginDependencies {
  readonly openExternal: (url: string) => PromiseLike<boolean | void> | boolean | void;
  readonly spawn?: CloudflareLoginSpawn;
  readonly fs?: CloudflareLoginFileSystem;
  readonly time?: CloudflareLoginTime;
}

/**
 * Run Cloudflare's supported interactive login on the extension host.
 *
 * The authorization URL exists only long enough to pass to `openExternal`.
 * This function never reads, returns, copies, or logs certificate contents or
 * captured process output.
 */
export async function loginCloudflare(
  request: CloudflareLoginRequest,
  dependencies: CloudflareLoginDependencies,
): Promise<CloudflareLoginResult> {
  const normalized = normalizeRequest(request);
  const fileSystem = dependencies.fs ?? defaultCloudflareLoginFileSystem;
  const time = dependencies.time ?? defaultCloudflareLoginTime;
  const spawnProcess = dependencies.spawn ?? spawnCloudflareLogin;

  if (request.signal?.aborted) return { status: "canceled" };
  const initialCertificate = await inspectCertificate(fileSystem, normalized.certificatePath);
  if (initialCertificate === "valid") {
    return { status: "reused", certificatePath: normalized.certificatePath };
  }
  if (initialCertificate === "unsafe") throw unsafeCertificateError();

  const startedAt = safeNow(time);
  const deadline = startedAt + normalized.timeoutMs;
  if (!Number.isSafeInteger(deadline)) {
    throw new CloudflareLoginError("invalid-request", "The Cloudflare login deadline is invalid.");
  }

  let child: CloudflareLoginProcess;
  try {
    child = spawnProcess(
      normalized.executable,
      ["tunnel", "login"],
      { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch {
    throw new CloudflareLoginError("spawn-failed", "Could not start cloudflared on the extension host.");
  }

  const output = new BoundedCloudflareLoginOutput();
  const disposables: Array<() => void> = [];
  let stopped = false;
  let terminal: { kind: "error" } | { kind: "close"; exitCode: number | null } | undefined;
  let fatalError: CloudflareLoginError | undefined;
  let authorizationUrl: string | undefined;
  const browser = { state: "idle" as "idle" | "opening" | "opened" | "failed" };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    try {
      child.kill();
    } catch {
      // The process may already have exited. There is nothing else to clean up.
    }
  };

  const fail = (error: CloudflareLoginError): void => {
    if (fatalError) return;
    fatalError = error;
    stop();
  };

  const openOfficialUrl = (url: string): void => {
    if (authorizationUrl) {
      if (authorizationUrl !== url) {
        fail(new CloudflareLoginError(
          "ambiguous-login-url",
          "cloudflared emitted more than one Cloudflare authorization URL.",
        ));
      }
      return;
    }
    authorizationUrl = url;
    browser.state = "opening";
    void Promise.resolve()
      .then(() => dependencies.openExternal(url))
      .then((opened) => {
        if (opened === false) throw new Error("The external browser declined the URL.");
        browser.state = "opened";
      })
      .catch(() => {
        browser.state = "failed";
        fail(new CloudflareLoginError("open-failed", "Could not open the Cloudflare authorization page."));
      });
  };

  const acceptOutput = (stream: "stdout" | "stderr", chunk: string | Uint8Array): void => {
    if (fatalError) return;
    try {
      for (const url of output.push(stream, chunk)) openOfficialUrl(url);
    } catch (error) {
      fail(error instanceof CloudflareLoginError
        ? error
        : new CloudflareLoginError("output-limit", "cloudflared produced too much login output."));
    }
  };

  if (child.stdout) disposables.push(child.stdout.onData((chunk) => acceptOutput("stdout", chunk)));
  if (child.stderr) disposables.push(child.stderr.onData((chunk) => acceptOutput("stderr", chunk)));
  disposables.push(child.onError(() => {
    terminal ??= { kind: "error" };
  }));
  disposables.push(child.onClose((exitCode) => {
    if (!terminal) terminal = { kind: "close", exitCode };
    try {
      for (const url of output.finish()) openOfficialUrl(url);
    } catch (error) {
      fail(error instanceof CloudflareLoginError
        ? error
        : new CloudflareLoginError("output-limit", "cloudflared produced too much login output."));
    }
  }));

  try {
    while (true) {
      if (request.signal?.aborted) return { status: "canceled" };
      if (fatalError) throw fatalError;

      const certificate = await inspectCertificate(fileSystem, normalized.certificatePath);
      if (certificate === "unsafe") throw unsafeCertificateError();
      if (certificate === "valid" && browser.state === "opened") {
        return { status: "authenticated", certificatePath: normalized.certificatePath };
      }

      if (fatalError) throw fatalError;
      if (terminal?.kind === "error") {
        throw new CloudflareLoginError("process-error", "cloudflared failed before login completed.");
      }
      if (terminal?.kind === "close") {
        if (terminal.exitCode !== 0) {
          throw new CloudflareLoginError("process-exit", "cloudflared exited before login completed.");
        }
        if (browser.state !== "opening") {
          if (!authorizationUrl) {
            throw new CloudflareLoginError("login-url-missing", "cloudflared did not provide an official authorization URL.");
          }
          throw new CloudflareLoginError("certificate-missing", "Cloudflare login finished without creating cert.pem.");
        }
      }

      if (safeNow(time) >= deadline) {
        throw new CloudflareLoginError("timeout", "Cloudflare login timed out before cert.pem was created.");
      }
      await time.sleep(normalized.pollIntervalMs, request.signal);
    }
  } finally {
    stop();
    for (const dispose of disposables) {
      try {
        dispose();
      } catch {
        // Listener cleanup is best effort after the child has been stopped.
      }
    }
  }
}

export const defaultCloudflareLoginFileSystem: CloudflareLoginFileSystem = {
  lstat: (filePath) => fs.lstat(filePath),
};

export const defaultCloudflareLoginTime: CloudflareLoginTime = {
  now: () => Date.now(),
  sleep: (delayMs, signal) => new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, delayMs);
    timer.unref?.();
    signal?.addEventListener("abort", done, { once: true });

    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  }),
};

/** Default direct-process adapter. No shell, terminal, or inherited stdin. */
export const spawnCloudflareLogin: CloudflareLoginSpawn = (executable, args, options) => {
  const child = spawn(executable, [...args], {
    shell: options.shell,
    windowsHide: options.windowsHide,
    stdio: [...options.stdio],
  });
  return {
    stdout: child.stdout ? outputAdapter(child.stdout) : undefined,
    stderr: child.stderr ? outputAdapter(child.stderr) : undefined,
    onError(listener) {
      const wrapped = () => listener();
      child.on("error", wrapped);
      return () => child.off("error", wrapped);
    },
    onClose(listener) {
      const wrapped = (code: number | null) => listener(code);
      child.on("close", wrapped);
      return () => child.off("close", wrapped);
    },
    kill() {
      child.kill("SIGTERM");
    },
  };
};

function outputAdapter(stream: NodeJS.ReadableStream): CloudflareLoginOutput {
  return {
    onData(listener) {
      const wrapped = (chunk: string | Buffer) => listener(chunk);
      stream.on("data", wrapped);
      return () => stream.off("data", wrapped);
    },
  };
}

function normalizeRequest(request: CloudflareLoginRequest): Required<
  Pick<CloudflareLoginRequest, "executable" | "certificatePath" | "timeoutMs" | "pollIntervalMs">
> {
  if (!request || typeof request !== "object") throw invalidRequest();
  const executable = safeRequestText(request.executable);
  const certificatePath = safeRequestText(request.certificatePath);
  if (!path.isAbsolute(certificatePath) || path.basename(certificatePath).toLowerCase() !== "cert.pem") {
    throw new CloudflareLoginError("invalid-request", "Cloudflare certificatePath must be an absolute cert.pem path.");
  }
  const timeoutMs = request.timeoutMs ?? DEFAULT_CLOUDFLARE_LOGIN_TIMEOUT_MS;
  const pollIntervalMs = request.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_CLOUDFLARE_LOGIN_TIMEOUT_MS) {
    throw invalidRequest();
  }
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0 || pollIntervalMs > 1_000 || pollIntervalMs > timeoutMs) {
    throw invalidRequest();
  }
  return { executable, certificatePath: path.resolve(certificatePath), timeoutMs, pollIntervalMs };
}

function safeRequestText(value: unknown): string {
  if (
    typeof value !== "string" || value.length === 0 || value.length > 8_192 ||
    value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)
  ) throw invalidRequest();
  return value;
}

function invalidRequest(): CloudflareLoginError {
  return new CloudflareLoginError("invalid-request", "The Cloudflare login request is invalid.");
}

type CertificateState = "missing" | "valid" | "unsafe";

async function inspectCertificate(
  fileSystem: CloudflareLoginFileSystem,
  certificatePath: string,
): Promise<CertificateState> {
  try {
    const stat = await fileSystem.lstat(certificatePath);
    if (
      stat.isSymbolicLink() || !stat.isFile() || !Number.isSafeInteger(stat.size) ||
      stat.size <= 0 || stat.size > MAX_CERTIFICATE_SIZE
    ) return "unsafe";
    return "valid";
  } catch (error) {
    if (isMissingFileError(error)) return "missing";
    throw new CloudflareLoginError("credential-inspection-failed", "Could not inspect Cloudflare cert.pem on the extension host.");
  }
}

function isMissingFileError(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error &&
    (error as { code?: unknown }).code === "ENOENT";
}

function unsafeCertificateError(): CloudflareLoginError {
  return new CloudflareLoginError(
    "credential-file-unsafe",
    "Cloudflare cert.pem must be a non-empty regular file and must not be a symbolic link.",
  );
}

function safeNow(time: CloudflareLoginTime): number {
  const value = time.now();
  if (!Number.isSafeInteger(value) || value < 0) throw invalidRequest();
  return value;
}

class BoundedCloudflareLoginOutput {
  private totalBytes = 0;
  private readonly pending: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" };
  private readonly emitted = new Set<string>();

  push(stream: "stdout" | "stderr", chunk: string | Uint8Array): string[] {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    this.totalBytes += Buffer.byteLength(text, "utf8");
    if (this.totalBytes > MAX_CLOUDFLARE_LOGIN_OUTPUT_BYTES) {
      throw new CloudflareLoginError("output-limit", "cloudflared produced too much login output.");
    }
    const combined = this.pending[stream] + text;
    const lines = combined.split(/\r?\n/u);
    this.pending[stream] = lines.pop() ?? "";
    if (this.pending[stream].length > MAX_PENDING_LINE_LENGTH) {
      throw new CloudflareLoginError("output-limit", "cloudflared produced an overlong login output line.");
    }
    return this.extract(lines);
  }

  finish(): string[] {
    const lines = [this.pending.stdout, this.pending.stderr];
    this.pending.stdout = "";
    this.pending.stderr = "";
    return this.extract(lines);
  }

  private extract(lines: readonly string[]): string[] {
    const urls: string[] = [];
    for (const line of lines) {
      for (const match of line.matchAll(/https:\/\/[^\s<>"']+/gu)) {
        const candidate = match[0].replace(/[),.;\]}]+$/u, "");
        const official = officialCloudflareLoginUrl(candidate);
        if (official && !this.emitted.has(official)) {
          this.emitted.add(official);
          urls.push(official);
        }
      }
    }
    return urls;
  }
}

function officialCloudflareLoginUrl(value: string): string | undefined {
  if (value.length > MAX_LOGIN_URL_LENGTH) return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" || url.hostname !== "dash.cloudflare.com" ||
      url.pathname !== "/argotunnel" || url.username || url.password || url.hash
    ) return undefined;
    const callbackValue = url.searchParams.get("callback");
    if (!callbackValue) return undefined;
    const callback = new URL(callbackValue);
    if (
      callback.protocol !== "https:" || callback.hostname !== "login.cloudflareaccess.org" ||
      callback.username || callback.password || callback.hash
    ) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}
