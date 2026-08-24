import assert from "node:assert/strict";
import test from "node:test";
import { resolveInstanceIdentity, type InstanceIdentity } from "../../../src/instance-identity.js";
import {
  attestEndpoint,
  EndpointAttestationError,
  type EndpointAttestationDependencies,
  type EndpointAttestationStage,
} from "../src/endpoint-attestation.js";

const LOCAL_ORIGIN = "http://127.0.0.1:3200";
const PUBLIC_ORIGIN = "https://mcp.example.test";
const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

interface AttestationFixture {
  identity: Readonly<InstanceIdentity>;
  payloads: Map<string, Record<string, unknown>>;
  calls: FetchCall[];
  dependencies: EndpointAttestationDependencies;
}

function createFixture(): AttestationFixture {
  const identity = resolveInstanceIdentity({
    instanceId: INSTANCE_ID,
    instanceLabel: "build-vps",
    publicUrl: PUBLIC_ORIGIN,
  });
  const health = {
    status: "ok",
    server: "pilink",
    instance: {
      id: identity.instanceId,
      label: identity.instanceLabel,
      fingerprint: identity.instanceFingerprint,
      connection_fingerprint: identity.connectionFingerprint,
      connection_name: identity.connectionName,
      connection_description: identity.connectionDescription,
    },
  };
  const payloads = new Map<string, Record<string, unknown>>([
    [`${LOCAL_ORIGIN}/health`, structuredClone(health)],
    [`${PUBLIC_ORIGIN}/health`, structuredClone(health)],
    [`${PUBLIC_ORIGIN}/.well-known/oauth-authorization-server`, {
      issuer: PUBLIC_ORIGIN,
      authorization_response_iss_parameter_supported: true,
      authorization_endpoint: `${PUBLIC_ORIGIN}/oauth/authorize`,
      token_endpoint: `${PUBLIC_ORIGIN}/oauth/token`,
      revocation_endpoint: `${PUBLIC_ORIGIN}/oauth/revoke`,
      registration_endpoint: `${PUBLIC_ORIGIN}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
    }],
    [`${PUBLIC_ORIGIN}/.well-known/oauth-protected-resource`, {
      resource: PUBLIC_ORIGIN,
      resource_name: identity.connectionName,
      resource_documentation: `${PUBLIC_ORIGIN}/.well-known/vspilink-instance`,
      authorization_servers: [PUBLIC_ORIGIN],
      scopes_supported: ["mcp:tools", "mcp:read", "mcp:write"],
    }],
    [`${PUBLIC_ORIGIN}/.well-known/vspilink-instance`, {
      schema_version: 1,
      instance_id: identity.instanceId,
      instance_label: identity.instanceLabel,
      instance_fingerprint: identity.instanceFingerprint,
      connection_fingerprint: identity.connectionFingerprint,
      display_name: identity.connectionName,
      description: identity.connectionDescription,
      connection_key: identity.connectionKey,
      server_url: PUBLIC_ORIGIN,
      mcp_url: `${PUBLIC_ORIGIN}/sse`,
      oauth: {
        protected_resource_metadata: `${PUBLIC_ORIGIN}/.well-known/oauth-protected-resource`,
        authorization_server_metadata: `${PUBLIC_ORIGIN}/.well-known/oauth-authorization-server`,
      },
    }],
  ]);
  const calls: FetchCall[] = [];
  const dependencies: EndpointAttestationDependencies = {
    fetch: async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({ url, init });
      const payload = payloads.get(url);
      if (!payload) return jsonResponse({ error: "not_found" }, 404);
      return jsonResponse(payload);
    },
    timeoutSignal: () => new AbortController().signal,
  };
  return { identity, payloads, calls, dependencies };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function nestedRecord(payload: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = payload[field];
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

async function assertStage(
  promise: Promise<unknown>,
  stage: EndpointAttestationStage,
): Promise<EndpointAttestationError> {
  try {
    await promise;
    assert.fail(`Expected endpoint attestation to fail at ${stage}`);
  } catch (error) {
    assert.ok(error instanceof EndpointAttestationError);
    assert.equal(error.stage, stage);
    return error;
  }
}

test("attestEndpoint accepts one exact local/public instance and disables redirects", async () => {
  const fixture = createFixture();
  const result = await attestEndpoint({
    localOrigin: `${LOCAL_ORIGIN}/`,
    expectedIdentity: fixture.identity,
  }, fixture.dependencies);

  assert.deepEqual(result, {
    publicOrigin: PUBLIC_ORIGIN,
    mcpUrl: `${PUBLIC_ORIGIN}/sse`,
    identity: fixture.identity,
  });
  assert.deepEqual(
    fixture.calls.map(({ url }) => url).sort(),
    [...fixture.payloads.keys()].sort(),
  );
  assert.equal(fixture.calls.length, 5);
  for (const { init } of fixture.calls) {
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.deepEqual(init?.headers, { accept: "application/json" });
    assert.ok(init?.signal instanceof AbortSignal);
  }
});

const mismatches: ReadonlyArray<{
  name: string;
  stage: EndpointAttestationStage;
  mutate: (fixture: AttestationFixture) => void;
}> = [
  {
    name: "local instance identity",
    stage: "local-health",
    mutate: ({ payloads }) => {
      nestedRecord(payloads.get(`${LOCAL_ORIGIN}/health`)!, "instance").id = "22222222-2222-4222-8222-222222222222";
    },
  },
  {
    name: "public connection description",
    stage: "public-health",
    mutate: ({ payloads }) => {
      nestedRecord(payloads.get(`${PUBLIC_ORIGIN}/health`)!, "instance").connection_description = "another server";
    },
  },
  {
    name: "authorization-server origin",
    stage: "authorization-server",
    mutate: ({ payloads }) => {
      payloads.get(`${PUBLIC_ORIGIN}/.well-known/oauth-authorization-server`)!.issuer = "https://other.example.test";
    },
  },
  {
    name: "protected-resource connection name",
    stage: "protected-resource",
    mutate: ({ payloads }) => {
      payloads.get(`${PUBLIC_ORIGIN}/.well-known/oauth-protected-resource`)!.resource_name = "VSPiLink — wrong server";
    },
  },
  {
    name: "descriptor instance fingerprint",
    stage: "instance-descriptor",
    mutate: ({ payloads }) => {
      payloads.get(`${PUBLIC_ORIGIN}/.well-known/vspilink-instance`)!.instance_fingerprint = "0000000000";
    },
  },
  {
    name: "descriptor connection key",
    stage: "instance-descriptor",
    mutate: ({ payloads }) => {
      payloads.get(`${PUBLIC_ORIGIN}/.well-known/vspilink-instance`)!.connection_key = "vspilink-wrong";
    },
  },
  {
    name: "descriptor MCP URL",
    stage: "instance-descriptor",
    mutate: ({ payloads }) => {
      payloads.get(`${PUBLIC_ORIGIN}/.well-known/vspilink-instance`)!.mcp_url = `${PUBLIC_ORIGIN}/wrong`;
    },
  },
];

for (const mismatch of mismatches) {
  test(`attestEndpoint rejects a mismatched ${mismatch.name}`, async () => {
    const fixture = createFixture();
    mismatch.mutate(fixture);
    await assertStage(attestEndpoint({
      localOrigin: LOCAL_ORIGIN,
      expectedIdentity: fixture.identity,
    }, fixture.dependencies), mismatch.stage);
  });
}

test("attestEndpoint rejects a response marked as redirected", async () => {
  const fixture = createFixture();
  const originalFetch = fixture.dependencies.fetch;
  fixture.dependencies.fetch = async (input, init) => {
    const response = await originalFetch(input, init);
    const url = input instanceof Request ? input.url : String(input);
    if (url === `${PUBLIC_ORIGIN}/health`) {
      Object.defineProperty(response, "redirected", { value: true });
    }
    return response;
  };

  const error = await assertStage(attestEndpoint({
    localOrigin: LOCAL_ORIGIN,
    expectedIdentity: fixture.identity,
  }, fixture.dependencies), "public-health");
  assert.match(error.message, /redirect/iu);
});

test("attestEndpoint rejects streamed response bodies above the configured byte limit", async () => {
  const fixture = createFixture();
  fixture.payloads.get(`${PUBLIC_ORIGIN}/health`)!.padding = "x".repeat(2_048);

  const error = await assertStage(attestEndpoint({
    localOrigin: LOCAL_ORIGIN,
    expectedIdentity: fixture.identity,
    maxBodyBytes: 1_024,
  }, fixture.dependencies), "public-health");
  assert.match(error.message, /safe body limit/iu);
});

test("attestEndpoint rejects noncanonical expectations and unsafe origins before fetching", async () => {
  const fixture = createFixture();
  const noncanonical = { ...fixture.identity, connectionName: "VSPiLink" };
  await assertStage(attestEndpoint({
    localOrigin: LOCAL_ORIGIN,
    expectedIdentity: noncanonical,
  }, fixture.dependencies), "configuration");

  const unsafePublic = resolveInstanceIdentity({
    instanceId: INSTANCE_ID,
    instanceLabel: "build-vps",
    publicUrl: "http://mcp.example.test",
  });
  await assertStage(attestEndpoint({
    localOrigin: LOCAL_ORIGIN,
    expectedIdentity: unsafePublic,
  }, fixture.dependencies), "configuration");

  await assertStage(attestEndpoint({
    localOrigin: "http://192.0.2.10:3200",
    expectedIdentity: fixture.identity,
  }, fixture.dependencies), "configuration");
  assert.equal(fixture.calls.length, 0);
});
