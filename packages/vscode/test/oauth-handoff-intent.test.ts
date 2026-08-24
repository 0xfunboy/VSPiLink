import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_OAUTH_HANDOFF_TTL_MS,
  OAUTH_HANDOFF_INTENT_KEY,
  OAuthHandoffIntentStore,
  type OAuthHandoffIdentity,
} from "../src/oauth-handoff-intent.js";

class MemoryMemento {
  readonly values = new Map<string, unknown>();
  failDeletes = false;

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    await Promise.resolve();
    if (value === undefined) {
      if (this.failDeletes) throw new Error("persisted delete failed");
      this.values.delete(key);
    } else {
      this.values.set(key, value);
    }
  }
}

const TARGET: OAuthHandoffIdentity = {
  configPath: "/home/operator/.config/pilink/server.env",
  instanceId: "instance-01JTEST",
  connectionKey: "vspilink-prod-7f31d2",
  connectionFingerprint: "sha256:7f31d2c93c",
  publicOrigin: "https://mcp.example.test",
  mcpUrl: "https://mcp.example.test/sse",
  workspace: "/home/operator/project",
};

test("a handoff survives store recreation and persists only the identity allowlist", async () => {
  const memento = new MemoryMemento();
  const store = new OAuthHandoffIntentStore(memento, {
    ttlMs: 30_000,
    now: () => 1_000,
    createId: () => "intent-1",
  });
  const untrustedInput = {
    ...TARGET,
    clientSecret: "must-not-persist",
    pairingCode: "must-not-persist",
    accessToken: "must-not-persist",
  };

  await assert.rejects(
    store.begin(untrustedInput as OAuthHandoffIdentity),
    /complete public server identity/,
  );
  assert.equal(memento.values.has(OAUTH_HANDOFF_INTENT_KEY), false);
  await store.begin(TARGET);
  const serialized = JSON.stringify(memento.values.get(OAUTH_HANDOFF_INTENT_KEY));
  assert.equal(serialized.includes("must-not-persist"), false);
  assert.deepEqual(Object.keys(JSON.parse(serialized).target).sort(), Object.keys(TARGET).sort());

  const restored = new OAuthHandoffIntentStore(memento, { ttlMs: 30_000, now: () => 1_001 });
  const pending = await restored.inspect();
  assert.equal(pending.status, "pending");
  if (pending.status === "pending") assert.deepEqual(pending.intent.target, TARGET);

  const consumed = await restored.consume(TARGET);
  assert.equal(consumed.status, "consumed");
  assert.equal((await restored.inspect()).status, "missing");
});

test("consume is atomic once across concurrent stores wrapping the same Memento", async () => {
  const memento = new MemoryMemento();
  const first = new OAuthHandoffIntentStore(memento, { now: () => 5_000, createId: () => "intent-race" });
  const second = new OAuthHandoffIntentStore(memento, { now: () => 5_000 });
  await first.begin(TARGET);

  const results = await Promise.all([first.consume(TARGET), second.consume(TARGET)]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["consumed", "missing"]);
  assert.equal(memento.values.has(OAUTH_HANDOFF_INTENT_KEY), false);
});

test("every target identity change prevents consumption and clears the stale intent", async () => {
  const changes: Array<[string, OAuthHandoffIdentity, string[]]> = [
    ["config path", { ...TARGET, configPath: "/other/server.env" }, ["configPath"]],
    ["instance", { ...TARGET, instanceId: "instance-other" }, ["instanceId"]],
    ["connection key", { ...TARGET, connectionKey: "vspilink-other" }, ["connectionKey"]],
    ["connection fingerprint", { ...TARGET, connectionFingerprint: "sha256:other" }, ["connectionFingerprint"]],
    [
      "origin",
      { ...TARGET, publicOrigin: "https://other.example.test", mcpUrl: "https://other.example.test/sse" },
      ["publicOrigin", "mcpUrl"],
    ],
    ["MCP URL", { ...TARGET, mcpUrl: "https://mcp.example.test/mcp" }, ["mcpUrl"]],
    ["workspace", { ...TARGET, workspace: "/home/operator/other" }, ["workspace"]],
  ];

  for (const [label, changed, expectedFields] of changes) {
    const memento = new MemoryMemento();
    const store = new OAuthHandoffIntentStore(memento, { now: () => 10_000, createId: () => `intent-${label}` });
    await store.begin(TARGET);
    const result = await store.consume(changed);
    assert.equal(result.status, "identity-mismatch", label);
    if (result.status === "identity-mismatch") assert.deepEqual(result.mismatchedFields, expectedFields, label);
    assert.equal((await store.inspect()).status, "missing", label);
  }
});

test("expiration is persisted and a backwards clock cannot extend an intent", async () => {
  const memento = new MemoryMemento();
  let now = 20_000;
  const store = new OAuthHandoffIntentStore(memento, { ttlMs: 1_000, now: () => now, createId: () => "intent-expiry" });
  await store.begin(TARGET);

  now = 20_999;
  assert.equal((await store.inspect()).status, "pending");
  now = 21_000;
  assert.equal((await store.inspect()).status, "expired");
  assert.equal(memento.values.has(OAUTH_HANDOFF_INTENT_KEY), false);

  now = 30_000;
  await store.begin(TARGET);
  now = 29_999;
  assert.equal((await store.consume(TARGET)).status, "expired");
});

test("clear handles cancellation and expire leaves a live intent untouched", async () => {
  const memento = new MemoryMemento();
  const store = new OAuthHandoffIntentStore(memento, { now: () => 40_000, createId: () => "intent-cancel" });
  await store.begin(TARGET);
  assert.equal(await store.expire(), false);
  assert.equal((await store.inspect()).status, "pending");
  assert.equal(await store.clear(), true);
  assert.equal(await store.clear(), false);
  assert.equal((await store.inspect()).status, "missing");
});

test("invalid or secret-bearing persisted records are rejected and erased", async () => {
  const memento = new MemoryMemento();
  memento.values.set(OAUTH_HANDOFF_INTENT_KEY, {
    schemaVersion: 1,
    intentId: "tampered",
    purpose: "open-chatgpt-after-oauth",
    createdAt: 50_000,
    expiresAt: 51_000,
    target: TARGET,
    refreshToken: "should-never-be-loaded",
  });
  const store = new OAuthHandoffIntentStore(memento, { now: () => 50_001 });
  assert.equal((await store.inspect()).status, "invalid");
  assert.equal(memento.values.has(OAUTH_HANDOFF_INTENT_KEY), false);
});

test("consume never reports success until the persistent deletion succeeds", async () => {
  const memento = new MemoryMemento();
  const store = new OAuthHandoffIntentStore(memento, { now: () => 60_000, createId: () => "intent-durable" });
  await store.begin(TARGET);
  memento.failDeletes = true;
  await assert.rejects(store.consume(TARGET), /persisted delete failed/);
  assert.equal(memento.values.has(OAUTH_HANDOFF_INTENT_KEY), true);

  memento.failDeletes = false;
  assert.equal((await store.consume(TARGET)).status, "consumed");
});

test("TTL and target URLs are constrained to short, credential-free HTTPS state", async () => {
  assert.throws(
    () => new OAuthHandoffIntentStore(new MemoryMemento(), { ttlMs: MAX_OAUTH_HANDOFF_TTL_MS + 1 }),
    /TTL/,
  );

  const store = new OAuthHandoffIntentStore(new MemoryMemento(), { now: () => 70_000 });
  await assert.rejects(
    store.begin({ ...TARGET, publicOrigin: "http://mcp.example.test", mcpUrl: "http://mcp.example.test/sse" }),
    /HTTPS origin/,
  );
  await assert.rejects(
    store.begin({ ...TARGET, mcpUrl: "https://mcp.example.test/sse?token=secret" }),
    /credential-free URL/,
  );
  await assert.rejects(
    store.begin({ ...TARGET, mcpUrl: "https://other.example.test/sse" }),
    /exact public origin/,
  );
});
