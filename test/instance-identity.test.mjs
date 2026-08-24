import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  defaultInstanceLabel,
  legacyInstanceId,
  normalizePublicOrigin,
  resolveInstanceIdentity,
} from "../dist/instance-identity.js";
import { persistLegacyInstanceIdentity } from "../dist/config.js";

const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";

function temporaryDirectory(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("the shared identity contract is stable and workspace-independent", () => {
  const identity = resolveInstanceIdentity({
    instanceId: INSTANCE_ID,
    instanceLabel: "build-vps",
    publicUrl: "https://mcp.example.test/",
  });

  assert.deepEqual(identity, {
    instanceId: INSTANCE_ID,
    instanceLabel: "build-vps",
    instanceSlug: "build-vps",
    instanceFingerprint: "e4ee77c92f",
    publicOrigin: "https://mcp.example.test",
    connectionFingerprint: "5d9f91c8ba",
    connectionName: "VSPiLink — build-vps · 5d9f91c8ba",
    connectionDescription: "Secure MCP coding-agent bridge to build-vps at https://mcp.example.test · 5d9f91c8ba",
    connectionKey: "vspilink-build-vps-5d9f91c8ba",
  });

  const sameOrigin = resolveInstanceIdentity({
    instanceId: INSTANCE_ID,
    instanceLabel: "build-vps",
    publicUrl: "https://mcp.example.test",
    fallbackSeed: "/a/different/workspace",
  });
  assert.deepEqual(sameOrigin, identity);

  const changedOrigin = resolveInstanceIdentity({
    instanceId: INSTANCE_ID,
    instanceLabel: "build-vps",
    publicUrl: "https://other.example.test",
  });
  assert.equal(changedOrigin.instanceFingerprint, identity.instanceFingerprint);
  assert.notEqual(changedOrigin.connectionFingerprint, identity.connectionFingerprint);
  assert.notEqual(changedOrigin.connectionKey, identity.connectionKey);
});

test("identity normalization rejects ambiguous labels and non-origin URLs", () => {
  assert.equal(normalizePublicOrigin("HTTPS://MCP.Example.Test:443/"), "https://mcp.example.test");
  assert.equal(defaultInstanceLabel("Build_Server.example"), "Build-Server-example");
  assert.throws(
    () => resolveInstanceIdentity({ instanceId: "not-a-uuid", publicUrl: "https://mcp.example.test" }),
    /canonical UUID/u,
  );
  assert.throws(
    () => resolveInstanceIdentity({ instanceId: INSTANCE_ID, instanceLabel: "../server", publicUrl: "https://mcp.example.test" }),
    /safe display characters/u,
  );
  assert.throws(
    () => normalizePublicOrigin("https://mcp.example.test/sse"),
    /absolute HTTP\(S\) origin/u,
  );
  assert.throws(
    () => normalizePublicOrigin("https://user:secret@mcp.example.test"),
    /absolute HTTP\(S\) origin/u,
  );
});

test("legacy installations deterministically persist one private instance UUID", (t) => {
  const directory = temporaryDirectory(t, "vspilink-legacy-identity-");
  const configPath = path.join(directory, ".env");
  const secret = "legacy-private-jwt-secret-that-is-long-enough";
  fs.writeFileSync(configPath, `JWT_SECRET=${secret}\nPORT=3200\n`, { mode: 0o600 });

  const expected = legacyInstanceId(secret);
  assert.equal(persistLegacyInstanceIdentity(configPath), expected);
  assert.match(fs.readFileSync(configPath, "utf8"), new RegExp(`^PI_INSTANCE_ID=${expected}$`, "mu"));
  assert.equal(persistLegacyInstanceIdentity(configPath), expected);
  assert.equal((fs.readFileSync(configPath, "utf8").match(/PI_INSTANCE_ID=/gu) || []).length, 1);
  if (process.platform !== "win32") assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
});
