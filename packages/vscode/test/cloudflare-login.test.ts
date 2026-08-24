import assert from "node:assert/strict";
import test from "node:test";
import {
  CloudflareLoginError,
  MAX_CLOUDFLARE_LOGIN_OUTPUT_BYTES,
  loginCloudflare,
  type CloudflareLoginFileStat,
  type CloudflareLoginFileSystem,
  type CloudflareLoginOutput,
  type CloudflareLoginProcess,
  type CloudflareLoginSpawn,
  type CloudflareLoginTime,
} from "../src/cloudflare-login.js";

const CERTIFICATE_PATH = "/home/operator/.cloudflared/cert.pem";
const LOGIN_URL = "https://dash.cloudflare.com/argotunnel?aud=&callback=" +
  "https%3A%2F%2Flogin.cloudflareaccess.org%2Ftest-callback%3D";

class FakeFileSystem implements CloudflareLoginFileSystem {
  state: "missing" | "valid" | "empty" | "symlink" = "missing";
  readonly inspectedPaths: string[] = [];

  lstat(filePath: string): Promise<CloudflareLoginFileStat> {
    this.inspectedPaths.push(filePath);
    if (this.state === "missing") {
      return Promise.reject(Object.assign(new Error("missing"), { code: "ENOENT" }));
    }
    return Promise.resolve({
      size: this.state === "empty" ? 0 : 2_048,
      isFile: () => this.state !== "symlink",
      isSymbolicLink: () => this.state === "symlink",
    });
  }
}

class FakeOutput implements CloudflareLoginOutput {
  private readonly listeners = new Set<(chunk: string | Uint8Array) => void>();

  onData(listener: (chunk: string | Uint8Array) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(chunk: string | Uint8Array): void {
    for (const listener of this.listeners) listener(chunk);
  }
}

class FakeProcess implements CloudflareLoginProcess {
  readonly stdout = new FakeOutput();
  readonly stderr = new FakeOutput();
  killCalls = 0;
  private readonly errorListeners = new Set<() => void>();
  private readonly closeListeners = new Set<(code: number | null) => void>();

  onError(listener: () => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  onClose(listener: (exitCode: number | null) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  kill(): void {
    this.killCalls += 1;
  }

  emitError(): void {
    for (const listener of this.errorListeners) listener();
  }

  emitClose(code: number | null): void {
    for (const listener of this.closeListeners) listener(code);
  }
}

class AdvancingTime implements CloudflareLoginTime {
  value = 1_000;
  sleeps = 0;
  onSleep?: (sleepNumber: number) => void;

  now(): number {
    return this.value;
  }

  async sleep(delayMs: number): Promise<void> {
    this.sleeps += 1;
    this.value += delayMs;
    this.onSleep?.(this.sleeps);
    await Promise.resolve();
  }
}

function request(signal?: AbortSignal) {
  return {
    executable: "/usr/local/bin/cloudflared",
    certificatePath: CERTIFICATE_PATH,
    timeoutMs: 100,
    pollIntervalMs: 10,
    ...(signal ? { signal } : {}),
  };
}

function spawning(process: FakeProcess, calls: unknown[][] = []): CloudflareLoginSpawn {
  return (executable, args, options) => {
    calls.push([executable, [...args], options]);
    return process;
  };
}

async function rejectsWithCode(promise: Promise<unknown>, code: CloudflareLoginError["code"]): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof CloudflareLoginError && error.code === code);
}

test("an existing regular cert.pem is reused without spawning or opening a browser", async () => {
  const fileSystem = new FakeFileSystem();
  fileSystem.state = "valid";
  let spawnCalls = 0;
  let openCalls = 0;
  const result = await loginCloudflare(request(), {
    fs: fileSystem,
    spawn: () => { spawnCalls += 1; throw new Error("must not spawn"); },
    time: new AdvancingTime(),
    openExternal: () => { openCalls += 1; },
  });

  assert.deepEqual(result, { status: "reused", certificatePath: CERTIFICATE_PATH });
  assert.equal(spawnCalls, 0);
  assert.equal(openCalls, 0);
  assert.deepEqual(fileSystem.inspectedPaths, [CERTIFICATE_PATH]);
});

test("login uses fixed argv without a shell, opens one bounded official URL, and waits for cert.pem", async () => {
  const fileSystem = new FakeFileSystem();
  const process = new FakeProcess();
  const time = new AdvancingTime();
  const spawnCalls: unknown[][] = [];
  const opened: string[] = [];
  time.onSleep = (step) => {
    if (step === 1) {
      process.stdout.emit("Open this URL:\nhttps://dash.cloudflare.com/argotunnel?aud=&call");
      process.stdout.emit("back=https%3A%2F%2Flogin.cloudflareaccess.org%2Ftest-callback%3D\n");
    }
  };

  const result = await loginCloudflare(request(), {
    fs: fileSystem,
    spawn: spawning(process, spawnCalls),
    time,
    openExternal: async (url) => {
      opened.push(url);
      fileSystem.state = "valid";
      return true;
    },
  });

  assert.deepEqual(spawnCalls, [[
    "/usr/local/bin/cloudflared",
    ["tunnel", "login"],
    { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  ]]);
  assert.deepEqual(opened, [LOGIN_URL]);
  assert.deepEqual(result, { status: "authenticated", certificatePath: CERTIFICATE_PATH });
  assert.equal(process.killCalls, 1);
  assert.equal(JSON.stringify(result).includes("argotunnel"), false);
});

test("the official URL may arrive on stderr and duplicate copies open only once", async () => {
  const fileSystem = new FakeFileSystem();
  const process = new FakeProcess();
  const time = new AdvancingTime();
  let openCalls = 0;
  time.onSleep = (step) => {
    if (step === 1) {
      process.stderr.emit(`${LOGIN_URL}\n${LOGIN_URL}\n`);
    } else if (step === 2) {
      fileSystem.state = "valid";
    }
  };
  const result = await loginCloudflare(request(), {
    fs: fileSystem,
    spawn: spawning(process),
    time,
    openExternal: () => { openCalls += 1; return true; },
  });
  assert.equal(result.status, "authenticated");
  assert.equal(openCalls, 1);
});

test("unofficial URLs are ignored and browser refusal is handled without exposing the URL", async () => {
  const fileSystem = new FakeFileSystem();
  const process = new FakeProcess();
  const time = new AdvancingTime();
  time.onSleep = (step) => {
    if (step === 1) {
      process.stdout.emit("https://dash.cloudflare.com.evil.test/argotunnel?callback=https://login.cloudflareaccess.org/x\n");
      process.stdout.emit(`${LOGIN_URL}\n`);
    }
  };
  const operation = loginCloudflare(request(), {
    fs: fileSystem,
    spawn: spawning(process),
    time,
    openExternal: () => false,
  });
  await rejectsWithCode(operation, "open-failed");
  assert.equal(process.killCalls, 1);
  await operation.catch((error: unknown) => {
    assert.equal(String(error).includes("argotunnel"), false);
  });
});

test("cancel before spawn and cancel while waiting both return a non-error canceled result", async () => {
  const alreadyCanceled = new AbortController();
  alreadyCanceled.abort();
  let spawnCalls = 0;
  assert.deepEqual(await loginCloudflare(request(alreadyCanceled.signal), {
    fs: new FakeFileSystem(),
    spawn: () => { spawnCalls += 1; throw new Error("must not spawn"); },
    time: new AdvancingTime(),
    openExternal: () => true,
  }), { status: "canceled" });
  assert.equal(spawnCalls, 0);

  const controller = new AbortController();
  const process = new FakeProcess();
  const time = new AdvancingTime();
  time.onSleep = () => controller.abort();
  const result = await loginCloudflare(request(controller.signal), {
    fs: new FakeFileSystem(),
    spawn: spawning(process),
    time,
    openExternal: () => true,
  });
  assert.deepEqual(result, { status: "canceled" });
  assert.equal(process.killCalls, 1);
});

test("timeout and bounded-output failures terminate the child", async () => {
  const timeoutProcess = new FakeProcess();
  await rejectsWithCode(loginCloudflare(request(), {
    fs: new FakeFileSystem(),
    spawn: spawning(timeoutProcess),
    time: new AdvancingTime(),
    openExternal: () => true,
  }), "timeout");
  assert.equal(timeoutProcess.killCalls, 1);

  const outputProcess = new FakeProcess();
  const outputTime = new AdvancingTime();
  outputTime.onSleep = () => outputProcess.stdout.emit("x".repeat(MAX_CLOUDFLARE_LOGIN_OUTPUT_BYTES + 1));
  await rejectsWithCode(loginCloudflare(request(), {
    fs: new FakeFileSystem(),
    spawn: spawning(outputProcess),
    time: outputTime,
    openExternal: () => true,
  }), "output-limit");
  assert.equal(outputProcess.killCalls, 1);
});

test("timeout still applies after cloudflared exits while browser opening is unresolved", async () => {
  const process = new FakeProcess();
  const time = new AdvancingTime();
  time.onSleep = (step) => {
    if (step === 1) {
      process.stdout.emit(`${LOGIN_URL}\n`);
      process.emitClose(0);
    }
  };
  await rejectsWithCode(loginCloudflare(request(), {
    fs: new FakeFileSystem(),
    spawn: spawning(process),
    time,
    openExternal: () => new Promise(() => undefined),
  }), "timeout");
  assert.equal(process.killCalls, 1);
});

test("spawn, process error, nonzero exit, and successful exit without a certificate are distinct", async () => {
  await rejectsWithCode(loginCloudflare(request(), {
    fs: new FakeFileSystem(),
    spawn: () => { throw new Error("sensitive executable failure"); },
    time: new AdvancingTime(),
    openExternal: () => true,
  }), "spawn-failed");

  for (const [event, expectedCode] of [
    ["error", "process-error"],
    ["nonzero", "process-exit"],
    ["zero-no-url", "login-url-missing"],
    ["zero-no-cert", "certificate-missing"],
  ] as const) {
    const process = new FakeProcess();
    const time = new AdvancingTime();
    time.onSleep = (step) => {
      if (step !== 1) return;
      if (event === "error") process.emitError();
      if (event === "nonzero") process.emitClose(17);
      if (event === "zero-no-url") process.emitClose(0);
      if (event === "zero-no-cert") {
        process.stdout.emit(`${LOGIN_URL}\n`);
        process.emitClose(0);
      }
    };
    await rejectsWithCode(loginCloudflare(request(), {
      fs: new FakeFileSystem(),
      spawn: spawning(process),
      time,
      openExternal: () => true,
    }), expectedCode);
    assert.equal(process.killCalls, 1, event);
  }
});

test("unsafe existing credential paths are rejected without reading credential contents", async () => {
  for (const state of ["empty", "symlink"] as const) {
    const fileSystem = new FakeFileSystem();
    fileSystem.state = state;
    await rejectsWithCode(loginCloudflare(request(), {
      fs: fileSystem,
      spawn: () => { throw new Error("must not spawn"); },
      time: new AdvancingTime(),
      openExternal: () => true,
    }), "credential-file-unsafe");
  }
});
