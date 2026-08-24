import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createAccessToken,
  createRefreshToken,
  findActiveClient,
  isClientActive,
  loadClients,
  registerClient,
  rotateRefreshToken,
} from "../dist/auth.js";

const FIRST_INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_INSTANCE_ID = "22222222-2222-4222-8222-222222222222";
const FIRST_ORIGIN = "https://mcp-one.example.test";
const SECOND_ORIGIN = "https://mcp-two.example.test";
const ENVIRONMENT_KEYS = [
  "PILINK_CONFIG",
  "PI_WORK_DIR",
  "PI_DATA_DIR",
  "PORT",
  "HOST",
  "SERVER_URL",
  "JWT_SECRET",
  "PI_BOOTSTRAP_SECRET",
  "PI_INSTANCE_ID",
  "PI_INSTANCE_LABEL",
  "PI_OAUTH_CONSENT_MODE",
];

test("OAuth state is bound to one instance and canonical public origin", async (t) => {
  const root = await temporaryRuntime(t);
  configureRuntime(root, FIRST_INSTANCE_ID, FIRST_ORIGIN);

  const registered = await registerClient(
    "ChatGPT PKCE",
    ["https://chatgpt.com/connector_platform_oauth_redirect"],
    ["authorization_code", "refresh_token"],
    "mcp:tools offline_access",
    "none",
  );
  assert.equal(registered.client.binding?.binding_version, 1);
  assert.equal(registered.client.binding?.instance_id, FIRST_INSTANCE_ID);
  assert.equal(registered.client.binding?.public_origin, FIRST_ORIGIN);
  assert.equal(registered.client.binding?.resource, FIRST_ORIGIN);
  assert.equal(registered.client.binding?.client_kind, "public");
  assert.match(registered.client.binding?.connection_fingerprint || "", /^[a-f0-9]{10}$/u);
  assert.match(registered.client.binding?.connection_key || "", /^vspilink-/u);

  const issued = await createRefreshToken(registered.client, "mcp:tools offline_access");
  const serializedClientStore = await fs.readFile(path.join(root, "data", "clients.json"), "utf8");
  const clientStore = JSON.parse(serializedClientStore);
  const refreshStore = await readJson(path.join(root, "data", "refresh-tokens.json"));
  assert.deepEqual(clientStore.clients[0].binding, registered.client.binding);
  assert.deepEqual(refreshStore.tokens[0].binding, registered.client.binding);
  assert.doesNotMatch(serializedClientStore, new RegExp(escapeRegExp(registered.client_secret)));
  assert.doesNotMatch(JSON.stringify(refreshStore), new RegExp(escapeRegExp(issued.refresh_token)));

  configureRuntime(root, FIRST_INSTANCE_ID, SECOND_ORIGIN);
  assert.equal(findActiveClient(registered.client.client_id), undefined);
  assert.equal(isClientActive(registered.client), false);
  assert.throws(
    () => createAccessToken(registered.client, "mcp:tools"),
    /not bound to the current VSPiLink target/u,
  );
  assert.equal(await rotateRefreshToken(issued.refresh_token, registered.client), null);

  const replacementConnection = await registerClient(
    "ChatGPT PKCE for the new origin",
    ["https://chatgpt.com/connector_platform_oauth_redirect"],
    ["authorization_code", "refresh_token"],
    "mcp:tools offline_access",
    "none",
  );
  assert.equal(replacementConnection.client.binding?.public_origin, SECOND_ORIGIN);
  assert.notEqual(
    replacementConnection.client.binding?.connection_fingerprint,
    registered.client.binding?.connection_fingerprint,
  );
  assert.equal(isClientActive(replacementConnection.client), true);
});

test("legacy OAuth records migrate once to the data directory's initial target", async (t) => {
  const root = await temporaryRuntime(t);
  configureRuntime(root, FIRST_INSTANCE_ID, FIRST_ORIGIN);
  const dataDir = path.join(root, "data");
  const legacyClientId = "pi_0123456789abcdef";
  const presentedRefreshToken = crypto.randomBytes(48).toString("base64url");
  await fs.writeFile(path.join(dataDir, "clients.json"), JSON.stringify({
    clients: [{
      client_id: legacyClientId,
      client_secret_hash: crypto.randomBytes(32).toString("hex"),
      client_name: "Legacy ChatGPT client",
      redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
      scope: "mcp:tools offline_access",
      created_at: "2026-01-01T00:00:00.000Z",
    }],
  }, null, 2), { mode: 0o600 });
  await fs.writeFile(path.join(dataDir, "refresh-tokens.json"), JSON.stringify({
    tokens: [{
      token_hash: crypto.createHash("sha256").update(presentedRefreshToken).digest("hex"),
      client_id: legacyClientId,
      scope: "mcp:tools offline_access",
      created_at: "2026-01-01T00:00:00.000Z",
      expires_at: Date.now() + 60_000,
    }],
  }, null, 2), { mode: 0o600 });

  const [migratedClient] = loadClients();
  assert.equal(migratedClient.binding?.public_origin, FIRST_ORIGIN);
  assert.equal(migratedClient.binding?.client_kind, "public");
  const persistedClient = (await readJson(path.join(dataDir, "clients.json"))).clients[0];
  assert.deepEqual(persistedClient.binding, migratedClient.binding);

  const rotated = await rotateRefreshToken(presentedRefreshToken, migratedClient);
  assert.ok(rotated);
  const persistedRefresh = (await readJson(path.join(dataDir, "refresh-tokens.json"))).tokens[0];
  assert.deepEqual(persistedRefresh.binding, migratedClient.binding);
  const directoryMetadata = await readJson(path.join(dataDir, "oauth-instance-binding.json"));
  assert.equal(directoryMetadata.metadata_version, 1);
  assert.equal(directoryMetadata.instance_id, FIRST_INSTANCE_ID);
  assert.equal(directoryMetadata.legacy_binding_target.public_origin, FIRST_ORIGIN);
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(path.join(dataDir, "oauth-instance-binding.json"))).mode & 0o777, 0o600);
  }

  configureRuntime(root, FIRST_INSTANCE_ID, SECOND_ORIGIN);
  assert.equal(findActiveClient(legacyClientId), undefined);
  assert.equal(await rotateRefreshToken(rotated.refresh_token, migratedClient), null);
  const unchangedMetadata = await readJson(path.join(dataDir, "oauth-instance-binding.json"));
  assert.equal(unchangedMetadata.legacy_binding_target.public_origin, FIRST_ORIGIN);
});

test("PI_DATA_DIR refuses a different VSPiLink instance identity", async (t) => {
  const root = await temporaryRuntime(t);
  configureRuntime(root, FIRST_INSTANCE_ID, FIRST_ORIGIN);
  assert.deepEqual(loadClients(), []);

  configureRuntime(root, SECOND_INSTANCE_ID, FIRST_ORIGIN);
  assert.throws(
    () => loadClients(),
    /PI_DATA_DIR is already bound to another VSPiLink instance/u,
  );
  await assert.rejects(
    registerClient("Wrong instance", [], ["client_credentials"], "mcp:read"),
    /PI_DATA_DIR is already bound to another VSPiLink instance/u,
  );
});

async function temporaryRuntime(t) {
  const original = new Map(ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vspilink-oauth-binding-"));
  await fs.mkdir(path.join(root, "workspace"));
  await fs.mkdir(path.join(root, "data"));
  t.after(async () => {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

function configureRuntime(root, instanceId, origin) {
  Object.assign(process.env, {
    PILINK_CONFIG: path.join(root, ".env"),
    PI_WORK_DIR: path.join(root, "workspace"),
    PI_DATA_DIR: path.join(root, "data"),
    PORT: "3200",
    HOST: "127.0.0.1",
    SERVER_URL: origin,
    JWT_SECRET: "test-only-jwt-material-not-a-real-secret",
    PI_BOOTSTRAP_SECRET: "test-only-bootstrap-material-not-real",
    PI_INSTANCE_ID: instanceId,
    PI_INSTANCE_LABEL: "binding-test-server",
    PI_OAUTH_CONSENT_MODE: "paired",
  });
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
