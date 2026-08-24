import assert from "node:assert/strict";
import test from "node:test";

import { selectPendingFullAccessClient } from "../src/full-access-binding.js";
import type { PublicClientSummary } from "../src/protocol.js";

const current = {
  configPath: "/private/server-a/.env",
  publicOrigin: "https://mcp-a.example.test",
};
const pending = {
  accessMode: "full" as const,
  configPath: current.configPath,
  publicUrl: current.publicOrigin,
  mcpUrl: `${current.publicOrigin}/sse`,
};

function client(id: string, patch: Partial<PublicClientSummary> = {}): PublicClientSummary {
  return {
    id,
    name: "ChatGPT VSPiLink",
    grantTypes: ["authorization_code", "refresh_token"],
    scope: "mcp:tools offline_access",
    createdAt: "2026-08-23T00:00:00.000Z",
    chatGpt: true,
    authorized: true,
    stale: false,
    ...patch,
  };
}

test("selects one durable current-origin ChatGPT client", () => {
  const result = selectPendingFullAccessClient(pending, current, [client("pi_1111111111111111")]);
  assert.equal(result.status, "selected");
  if (result.status === "selected") assert.equal(result.client.id, "pi_1111111111111111");
});

test("wrong target identity or a non-Full intent is inactive", () => {
  const available = [client("pi_1111111111111111")];
  assert.equal(selectPendingFullAccessClient({ ...pending, accessMode: "workspace" }, current, available).status, "inactive");
  assert.equal(selectPendingFullAccessClient({ ...pending, configPath: "/private/server-b/.env" }, current, available).status, "inactive");
  assert.equal(selectPendingFullAccessClient({ ...pending, publicUrl: "https://mcp-b.example.test" }, current, available).status, "inactive");
  assert.equal(selectPendingFullAccessClient({ ...pending, mcpUrl: "https://mcp-b.example.test/sse" }, current, available).status, "inactive");
});

test("unproven, stale, non-ChatGPT, read-only, and non-code clients never receive Full access", () => {
  const rejected = [
    client("pi_0000000000000001", { authorized: false }),
    client("pi_0000000000000002", { stale: true }),
    client("pi_0000000000000003", { chatGpt: false }),
    client("pi_0000000000000004", { scope: "mcp:read offline_access" }),
    client("pi_0000000000000005", { grantTypes: ["client_credentials"] }),
  ];
  assert.equal(selectPendingFullAccessClient(pending, current, rejected).status, "waiting");
});

test("multiple eligible clients fail closed unless the persisted fallback client is exact", () => {
  const clients = [client("pi_2222222222222222"), client("pi_1111111111111111")];
  const ambiguous = selectPendingFullAccessClient(pending, current, clients);
  assert.deepEqual(ambiguous, {
    status: "ambiguous",
    clientIds: ["pi_1111111111111111", "pi_2222222222222222"],
  });
  const selected = selectPendingFullAccessClient({ ...pending, preferredClientId: "pi_2222222222222222" }, current, clients);
  assert.equal(selected.status, "selected");
  if (selected.status === "selected") assert.equal(selected.client.id, "pi_2222222222222222");
  assert.equal(
    selectPendingFullAccessClient({ ...pending, preferredClientId: "pi_9999999999999999" }, current, clients).status,
    "waiting",
  );
});
