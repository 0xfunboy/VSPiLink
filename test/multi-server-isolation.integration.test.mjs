import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const FIRST_INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_INSTANCE_ID = "22222222-2222-4222-8222-222222222222";
const SHARED_JWT_SECRET = "same-test-jwt-material-proves-audience-isolation";
const SHARED_BOOTSTRAP_SECRET = "same-test-bootstrap-material-for-both-servers";
const CHATGPT_REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";

test("two simultaneous VSPiLink configurations keep identity, DCR, descriptors, and OAuth audiences separate", async (t) => {
  const first = await startServer(t, {
    prefix: "vspilink-multi-one-",
    instanceId: FIRST_INSTANCE_ID,
    instanceLabel: "build-one",
  });
  const second = await startServer(t, {
    prefix: "vspilink-multi-two-",
    instanceId: SECOND_INSTANCE_ID,
    instanceLabel: "build-two",
  });

  const [firstMetadata, secondMetadata, firstResource, secondResource, firstDescriptor, secondDescriptor] = await Promise.all([
    json(`${first.origin}/.well-known/oauth-authorization-server`),
    json(`${second.origin}/.well-known/oauth-authorization-server`),
    json(`${first.origin}/.well-known/oauth-protected-resource`),
    json(`${second.origin}/.well-known/oauth-protected-resource`),
    json(`${first.origin}/.well-known/vspilink-instance`),
    json(`${second.origin}/.well-known/vspilink-instance`),
  ]);

  assert.equal(firstMetadata.issuer, first.origin);
  assert.equal(secondMetadata.issuer, second.origin);
  assert.notEqual(firstMetadata.issuer, secondMetadata.issuer);
  assert.equal(firstResource.resource, first.origin);
  assert.equal(secondResource.resource, second.origin);
  assert.deepEqual(firstResource.authorization_servers, [first.origin]);
  assert.deepEqual(secondResource.authorization_servers, [second.origin]);

  assert.equal(firstDescriptor.instance_id, FIRST_INSTANCE_ID);
  assert.equal(secondDescriptor.instance_id, SECOND_INSTANCE_ID);
  assert.equal(firstDescriptor.server_url, first.origin);
  assert.equal(secondDescriptor.server_url, second.origin);
  assert.equal(firstDescriptor.mcp_url, `${first.origin}/sse`);
  assert.equal(secondDescriptor.mcp_url, `${second.origin}/sse`);
  assert.equal(firstResource.resource_name, firstDescriptor.display_name);
  assert.equal(secondResource.resource_name, secondDescriptor.display_name);
  for (const field of [
    "instance_fingerprint",
    "connection_fingerprint",
    "display_name",
    "connection_key",
  ]) {
    assert.notEqual(firstDescriptor[field], secondDescriptor[field], field);
  }

  const dcrBody = {
    client_name: "ChatGPT",
    redirect_uris: [CHATGPT_REDIRECT],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: "mcp:tools offline_access",
    token_endpoint_auth_method: "none",
  };
  const [firstDcr, secondDcr] = await Promise.all([
    postJson(`${first.origin}/oauth/register`, dcrBody),
    postJson(`${second.origin}/oauth/register`, dcrBody),
  ]);
  assert.equal(firstDcr.response.status, 201);
  assert.equal(secondDcr.response.status, 201);
  assert.notEqual(firstDcr.body.client_id, secondDcr.body.client_id);
  assert.equal(firstDcr.body.token_endpoint_auth_method, "none");
  assert.equal(secondDcr.body.token_endpoint_auth_method, "none");

  const [firstClient, secondClient] = await Promise.all([
    registerConfidentialClient(first.origin),
    registerConfidentialClient(second.origin),
  ]);
  const [firstToken, secondToken] = await Promise.all([
    issueClientToken(first.origin, firstClient),
    issueClientToken(second.origin, secondClient),
  ]);
  assert.deepEqual(accessTokenClaims(firstToken.access_token), {
    iss: first.origin,
    aud: first.origin,
  });
  assert.deepEqual(accessTokenClaims(secondToken.access_token), {
    iss: second.origin,
    aud: second.origin,
  });

  assert.equal(await initializeWithToken(second.origin, firstToken.access_token), 401);
  assert.equal(await initializeWithToken(first.origin, secondToken.access_token), 401);
  assert.equal(await authorizeForeignDcrClient(second.origin, firstDcr.body.client_id), 400);
  assert.equal(await authorizeForeignDcrClient(first.origin, secondDcr.body.client_id), 400);
});

async function startServer(t, options) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), options.prefix));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  const coordinationDir = path.join(root, "coordination");
  await Promise.all([
    fs.mkdir(workspace),
    fs.mkdir(dataDir),
    fs.mkdir(coordinationDir),
  ]);
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.resolve("dist/index.js")], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      SERVER_URL: origin,
      PILINK_CONFIG: path.join(root, "vspilink.env"),
      PI_WORK_DIR: workspace,
      PI_DATA_DIR: dataDir,
      PI_COORDINATION_DATA_DIR: coordinationDir,
      PI_INSTANCE_ID: options.instanceId,
      PI_INSTANCE_LABEL: options.instanceLabel,
      JWT_SECRET: SHARED_JWT_SECRET,
      PI_BOOTSTRAP_SECRET: SHARED_BOOTSTRAP_SECRET,
      PI_OAUTH_CONSENT_MODE: "browser",
      PI_OAUTH_PUBLIC_CHATGPT_DCR: "true",
    },
    stdio: "ignore",
  });
  t.after(async () => {
    child.kill("SIGINT");
    await exited(child);
    await fs.rm(root, { recursive: true, force: true });
  });
  await waitForHealth(origin);
  return { origin };
}

async function registerConfidentialClient(origin) {
  const response = await fetch(`${origin}/oauth/register`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${SHARED_BOOTSTRAP_SECRET}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      client_name: "audience-test",
      grant_types: ["client_credentials"],
      scope: "mcp:read",
    }),
  });
  assert.equal(response.status, 201);
  return response.json();
}

async function issueClientToken(origin, client) {
  const { response, body } = await postJson(`${origin}/oauth/token`, {
    grant_type: "client_credentials",
    client_id: client.client_id,
    client_secret: client.client_secret,
    scope: "mcp:read",
    resource: origin,
  });
  assert.equal(response.status, 200);
  return body;
}

function accessTokenClaims(token) {
  const parts = token.split(".");
  assert.equal(parts.length, 3);
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  return { iss: payload.iss, aud: payload.aud };
}

async function initializeWithToken(origin, token) {
  const response = await fetch(`${origin}/sse`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "multi-server-test", version: "1.0.0" },
      },
    }),
  });
  return response.status;
}

async function authorizeForeignDcrClient(origin, clientId) {
  const url = new URL(`${origin}/oauth/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CHATGPT_REDIRECT,
    scope: "mcp:tools offline_access",
    state: "foreign-client",
    code_challenge: "q".repeat(43),
    code_challenge_method: "S256",
    resource: origin,
  }).toString();
  return (await fetch(url)).status;
}

async function postJson(url, value) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
  return { response, body: await response.json() };
}

async function json(url) {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  return response.json();
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHealth(origin) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) return;
    } catch {
      // The child process may still be binding its loopback port.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${origin}`);
}

async function exited(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 2_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}
