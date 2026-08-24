import assert from "node:assert/strict";
import test from "node:test";
import { resolveQuickTunnelRuntimeIdentity } from "../src/quick-tunnel-identity.js";

test("a new authenticated Quick Tunnel origin replaces the old persisted identity", () => {
  const result = resolveQuickTunnelRuntimeIdentity({
    persistedOrigin: "https://old-edge.trycloudflare.com",
    runtimeOrigin: "https://new-edge.trycloudflare.com/",
    capturedOrigin: "https://new-edge.trycloudflare.com",
  });

  assert.deepEqual(result, {
    origin: "https://new-edge.trycloudflare.com",
    changed: true,
  });
});

test("an already persisted runtime identity remains stable", () => {
  const result = resolveQuickTunnelRuntimeIdentity({
    persistedOrigin: "https://current-edge.trycloudflare.com/",
    runtimeOrigin: "https://current-edge.trycloudflare.com",
  });

  assert.equal(result.origin, "https://current-edge.trycloudflare.com");
  assert.equal(result.changed, false);
});

test("runtime and extension-owned tunnel disagreement fails closed", () => {
  assert.throws(() => resolveQuickTunnelRuntimeIdentity({
    persistedOrigin: "http://127.0.0.1:3200",
    runtimeOrigin: "https://runtime-edge.trycloudflare.com",
    capturedOrigin: "https://different-edge.trycloudflare.com",
  }), /does not match/u);
});

test("non-Cloudflare, credential-bearing, and non-origin runtime URLs are rejected", () => {
  for (const runtimeOrigin of [
    "http://edge.trycloudflare.com",
    "https://attacker.example.com",
    "https://user:secret@edge.trycloudflare.com",
    "https://edge.trycloudflare.com/oauth/pair",
  ]) {
    assert.throws(() => resolveQuickTunnelRuntimeIdentity({
      persistedOrigin: "http://127.0.0.1:3200",
      runtimeOrigin,
    }), /runtime Quick Tunnel origin is invalid/u);
  }
});
