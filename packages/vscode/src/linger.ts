import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_CAPTURED_OUTPUT = 32 * 1024;
const SAFE_USER_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

export type UserLingerState = "enabled" | "disabled" | "unavailable";

export type LingerDiagnosticCode =
  | "already-enabled"
  | "disabled"
  | "enabled"
  | "invalid-user"
  | "loginctl-not-found"
  | "systemd-unavailable"
  | "inspection-failed"
  | "invalid-response"
  | "permission-denied"
  | "enable-failed"
  | "verification-failed";

export interface LingerCommandRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
}

export interface LingerCommandResult {
  readonly exitCode: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly errorCode?: string;
}

export type LingerCommandRunner = (
  request: LingerCommandRequest,
) => Promise<LingerCommandResult>;

export interface LingerPolicyDependencies {
  readonly runCommand?: LingerCommandRunner;
  readonly loginctlExecutable?: string;
  readonly timeoutMs?: number;
}

export interface LingerInspection {
  readonly user: string;
  readonly state: UserLingerState;
  readonly code: LingerDiagnosticCode;
  readonly diagnostic: string;
}

export interface LingerPolicyOutcome extends LingerInspection {
  readonly changed: boolean;
  readonly action: "none" | "enabled" | "manual-required" | "unavailable";
  readonly manualCommand?: string;
  readonly manualCommandArgv?: readonly ["loginctl", "enable-linger", string];
}

/**
 * Reads the current systemd user-linger state. The command is always executed
 * directly with an argument array; no shell is involved.
 */
export async function inspectUserLinger(
  user: string,
  dependencies: LingerPolicyDependencies = {},
): Promise<LingerInspection> {
  const invalidUser = validateUser(user);
  if (invalidUser) return invalidUser;

  const result = await runSafely(
    {
      executable: dependencies.loginctlExecutable || "loginctl",
      args: ["show-user", user, "-p", "Linger", "--value"],
      timeoutMs: normalizeTimeout(dependencies.timeoutMs),
    },
    dependencies.runCommand || runLingerCommand,
  );

  if (isCommandMissing(result)) {
    return inspection(
      user,
      "unavailable",
      "loginctl-not-found",
      "loginctl is not available on this host, so user lingering cannot be managed automatically.",
    );
  }

  if (result.exitCode !== 0) {
    const detail = summarizeCommandFailure(result);
    if (looksLikeSystemdUnavailable(detail)) {
      return inspection(
        user,
        "unavailable",
        "systemd-unavailable",
        `systemd user services are not available on this host${detail ? `: ${detail}` : "."}`,
      );
    }
    return inspection(
      user,
      "unavailable",
      "inspection-failed",
      `Could not inspect user lingering${detail ? `: ${detail}` : "."}`,
    );
  }

  const value = (result.stdout || "").trim().toLowerCase();
  if (value === "yes") {
    return inspection(user, "enabled", "already-enabled", "User lingering is enabled.");
  }
  if (value === "no") {
    return inspection(user, "disabled", "disabled", "User lingering is disabled.");
  }

  return inspection(
    user,
    "unavailable",
    "invalid-response",
    "loginctl returned an unrecognized linger state.",
  );
}

/**
 * Enables lingering only when inspection reports `Linger=no`, then verifies
 * the persisted state. It never invokes sudo and never interpolates a shell
 * command. If authorization is unavailable, the caller receives one explicit
 * manual command to present to the user.
 */
export async function ensureUserLinger(
  user: string,
  dependencies: LingerPolicyDependencies = {},
): Promise<LingerPolicyOutcome> {
  const initial = await inspectUserLinger(user, dependencies);

  if (initial.state === "enabled") {
    return {
      ...initial,
      changed: false,
      action: "none",
    };
  }

  if (initial.state === "unavailable") {
    return {
      ...initial,
      changed: false,
      action: "unavailable",
    };
  }

  const result = await runSafely(
    {
      executable: dependencies.loginctlExecutable || "loginctl",
      args: ["enable-linger", user],
      timeoutMs: normalizeTimeout(dependencies.timeoutMs),
    },
    dependencies.runCommand || runLingerCommand,
  );

  if (result.exitCode !== 0) {
    const detail = summarizeCommandFailure(result);
    const denied = looksLikePermissionDenied(detail);
    return manualOutcome(
      user,
      denied ? "permission-denied" : "enable-failed",
      denied
        ? `VSPiLink was not authorized to enable user lingering${detail ? `: ${detail}` : "."}`
        : `VSPiLink could not enable user lingering${detail ? `: ${detail}` : "."}`,
    );
  }

  const verified = await inspectUserLinger(user, dependencies);
  if (verified.state === "enabled") {
    return {
      user,
      state: "enabled",
      code: "enabled",
      diagnostic: "User lingering was enabled and verified.",
      changed: true,
      action: "enabled",
    };
  }

  return {
    user,
    state: verified.state,
    code: "verification-failed",
    diagnostic: `loginctl completed, but the enabled state could not be verified. ${verified.diagnostic}`,
    changed: false,
    action: "manual-required",
    ...manualCommandFields(user),
  };
}

/** Default production runner. Exported so integration code can compose it. */
export const runLingerCommand: LingerCommandRunner = (request) =>
  new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";

    const finish = (result: LingerCommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const child = spawn(request.executable, [...request.args], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = appendBounded(stderr, chunk);
    });

    child.once("error", (error: NodeJS.ErrnoException) => {
      finish({
        exitCode: null,
        stdout,
        stderr: stderr || error.message,
        ...(error.code ? { errorCode: error.code } : {}),
      });
    });
    child.once("close", (exitCode) => {
      finish({ exitCode, stdout, stderr });
    });

    const timer = setTimeout(() => {
      child.kill();
      finish({
        exitCode: null,
        stdout,
        stderr: stderr || "loginctl timed out.",
        errorCode: "ETIMEDOUT",
      });
    }, request.timeoutMs);
  });

function validateUser(user: string): LingerInspection | undefined {
  if (SAFE_USER_NAME.test(user)) return undefined;
  return inspection(
    user,
    "unavailable",
    "invalid-user",
    "The current operating-system user name is not safe to pass to loginctl.",
  );
}

function inspection(
  user: string,
  state: UserLingerState,
  code: LingerDiagnosticCode,
  diagnostic: string,
): LingerInspection {
  return { user, state, code, diagnostic };
}

function manualOutcome(
  user: string,
  code: "permission-denied" | "enable-failed",
  diagnostic: string,
): LingerPolicyOutcome {
  return {
    user,
    state: "disabled",
    code,
    diagnostic: `${diagnostic} Run \`${manualEnableLingerCommand(user)}\` from an authorized terminal.`,
    changed: false,
    action: "manual-required",
    ...manualCommandFields(user),
  };
}

function manualCommandFields(user: string): Pick<LingerPolicyOutcome, "manualCommand" | "manualCommandArgv"> {
  return {
    manualCommand: manualEnableLingerCommand(user),
    manualCommandArgv: ["loginctl", "enable-linger", user],
  };
}

export function manualEnableLingerCommand(user: string): string {
  if (!SAFE_USER_NAME.test(user)) {
    throw new TypeError("Unsafe operating-system user name.");
  }
  return `loginctl enable-linger ${user}`;
}

async function runSafely(
  request: LingerCommandRequest,
  runner: LingerCommandRunner,
): Promise<LingerCommandResult> {
  try {
    return await runner(request);
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    return {
      exitCode: null,
      stderr: failure instanceof Error ? failure.message : "loginctl failed unexpectedly.",
      ...(failure?.code ? { errorCode: failure.code } : {}),
    };
  }
}

function normalizeTimeout(value: number | undefined): number {
  return Number.isFinite(value) && Number(value) > 0
    ? Math.floor(Number(value))
    : DEFAULT_TIMEOUT_MS;
}

function isCommandMissing(result: LingerCommandResult): boolean {
  return result.errorCode === "ENOENT" || result.exitCode === 127;
}

function summarizeCommandFailure(result: LingerCommandResult): string {
  return summarizeText(result.stderr || result.stdout || result.errorCode || "");
}

function summarizeText(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, 500);
}

function looksLikeSystemdUnavailable(detail: string): boolean {
  return /not been booted with systemd|failed to connect to bus|system has no systemd|unknown command.*show-user/i.test(detail);
}

function looksLikePermissionDenied(detail: string): boolean {
  return /access denied|permission denied|not authorized|authentication is required|interactive authentication required/i.test(detail);
}

function appendBounded(current: string, chunk: string): string {
  if (current.length >= MAX_CAPTURED_OUTPUT) return current;
  return (current + chunk).slice(0, MAX_CAPTURED_OUTPUT);
}
