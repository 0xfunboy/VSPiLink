import assert from "node:assert/strict";
import test from "node:test";
import {
  ensureUserLinger,
  inspectUserLinger,
  type LingerCommandRequest,
  type LingerCommandResult,
} from "../src/linger.js";

function queuedRunner(results: readonly LingerCommandResult[]) {
  const calls: LingerCommandRequest[] = [];
  let index = 0;
  return {
    calls,
    runCommand: async (request: LingerCommandRequest): Promise<LingerCommandResult> => {
      calls.push(request);
      const result = results[index++];
      if (!result) throw new Error("Unexpected loginctl invocation.");
      return result;
    },
  };
}

test("Linger=yes is a no-op", async () => {
  const fake = queuedRunner([{ exitCode: 0, stdout: "yes\n" }]);

  const outcome = await ensureUserLinger("operator", fake);

  assert.equal(outcome.state, "enabled");
  assert.equal(outcome.action, "none");
  assert.equal(outcome.changed, false);
  assert.equal(outcome.manualCommand, undefined);
  assert.deepEqual(fake.calls.map(({ executable, args }) => ({ executable, args })), [
    {
      executable: "loginctl",
      args: ["show-user", "operator", "-p", "Linger", "--value"],
    },
  ]);
});

test("Linger=no is enabled and rechecked", async () => {
  const fake = queuedRunner([
    { exitCode: 0, stdout: "no\n" },
    { exitCode: 0 },
    { exitCode: 0, stdout: "yes\n" },
  ]);

  const outcome = await ensureUserLinger("operator", fake);

  assert.equal(outcome.state, "enabled");
  assert.equal(outcome.action, "enabled");
  assert.equal(outcome.changed, true);
  assert.deepEqual(fake.calls.map(({ executable, args }) => ({ executable, args })), [
    {
      executable: "loginctl",
      args: ["show-user", "operator", "-p", "Linger", "--value"],
    },
    {
      executable: "loginctl",
      args: ["enable-linger", "operator"],
    },
    {
      executable: "loginctl",
      args: ["show-user", "operator", "-p", "Linger", "--value"],
    },
  ]);
  assert.ok(fake.calls.every(({ executable }) => executable !== "sudo"));
});

test("authorization denial returns the exact no-sudo manual command", async () => {
  const fake = queuedRunner([
    { exitCode: 0, stdout: "no\n" },
    { exitCode: 1, stderr: "Access denied" },
  ]);

  const outcome = await ensureUserLinger("operator", fake);

  assert.equal(outcome.state, "disabled");
  assert.equal(outcome.action, "manual-required");
  assert.equal(outcome.changed, false);
  assert.equal(outcome.code, "permission-denied");
  assert.equal(outcome.manualCommand, "loginctl enable-linger operator");
  assert.deepEqual(outcome.manualCommandArgv, ["loginctl", "enable-linger", "operator"]);
  assert.match(outcome.diagnostic, /not authorized/i);
  assert.ok(!outcome.diagnostic.includes("sudo"));
  assert.ok(fake.calls.every(({ executable, args }) =>
    executable !== "sudo" && !args.includes("sudo")));
});

test("a host without loginctl is reported as unavailable and is not mutated", async () => {
  const fake = queuedRunner([
    { exitCode: null, errorCode: "ENOENT", stderr: "spawn loginctl ENOENT" },
  ]);

  const outcome = await ensureUserLinger("operator", fake);

  assert.equal(outcome.state, "unavailable");
  assert.equal(outcome.action, "unavailable");
  assert.equal(outcome.code, "loginctl-not-found");
  assert.equal(outcome.changed, false);
  assert.equal(fake.calls.length, 1);
});

test("a host not booted with systemd is reported as unavailable", async () => {
  const fake = queuedRunner([
    {
      exitCode: 1,
      stderr: "System has not been booted with systemd as init system (PID 1). Can't operate.",
    },
  ]);

  const outcome = await inspectUserLinger("operator", fake);

  assert.equal(outcome.state, "unavailable");
  assert.equal(outcome.code, "systemd-unavailable");
  assert.match(outcome.diagnostic, /systemd user services are not available/i);
  assert.equal(fake.calls.length, 1);
});

test("unsafe user names are rejected before any process is started", async () => {
  const fake = queuedRunner([]);

  const outcome = await ensureUserLinger("operator;sudo reboot", fake);

  assert.equal(outcome.state, "unavailable");
  assert.equal(outcome.code, "invalid-user");
  assert.equal(fake.calls.length, 0);
});
