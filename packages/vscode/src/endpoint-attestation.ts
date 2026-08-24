import {
  resolveInstanceIdentity,
  type InstanceIdentity,
} from "../../../src/instance-identity.js";

export const DEFAULT_ATTESTATION_BODY_LIMIT = 256 * 1024;

export type EndpointAttestationStage =
  | "configuration"
  | "local-health"
  | "public-health"
  | "authorization-server"
  | "protected-resource"
  | "instance-descriptor";

export class EndpointAttestationError extends Error {
  readonly stage: EndpointAttestationStage;

  constructor(stage: EndpointAttestationStage, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EndpointAttestationError";
    this.stage = stage;
  }
}

export interface EndpointAttestationOptions {
  /** Loopback origin of the server process owned by this extension host. */
  localOrigin: string;
  /** Canonical identity expected from both the local process and public edge. */
  expectedIdentity: Readonly<InstanceIdentity>;
  timeoutMs?: number;
  maxBodyBytes?: number;
}

export interface EndpointAttestationDependencies {
  fetch: typeof globalThis.fetch;
  timeoutSignal: (timeoutMs: number) => AbortSignal;
}

export interface EndpointAttestationResult {
  publicOrigin: string;
  mcpUrl: string;
  identity: Readonly<InstanceIdentity>;
}

const DEFAULT_DEPENDENCIES: EndpointAttestationDependencies = {
  fetch: (...args) => globalThis.fetch(...args),
  timeoutSignal: (timeoutMs) => AbortSignal.timeout(timeoutMs),
};

/**
 * Prove that the loopback process and public HTTPS edge expose the exact same
 * VSPiLink instance before the wizard opens ChatGPT or starts OAuth pairing.
 * Every public request is a bounded, no-redirect GET so an unexpected proxy or
 * hostname can never be silently accepted as the configured server.
 */
export async function attestEndpoint(
  options: EndpointAttestationOptions,
  dependencies: Partial<EndpointAttestationDependencies> = {},
): Promise<Readonly<EndpointAttestationResult>> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const timeoutMs = boundedPositiveInteger(options.timeoutMs, 5_000, 120_000, "timeoutMs");
  const maxBodyBytes = boundedPositiveInteger(
    options.maxBodyBytes,
    DEFAULT_ATTESTATION_BODY_LIMIT,
    2 * 1024 * 1024,
    "maxBodyBytes",
  );
  const localOrigin = normalizeLoopbackOrigin(options.localOrigin);
  const expected = canonicalExpectedIdentity(options.expectedIdentity);
  const publicOrigin = normalizeHttpsOrigin(expected.publicOrigin);
  const mcpUrl = `${publicOrigin}/sse`;

  const request = (stage: EndpointAttestationStage, url: string) => requestJson(
    stage,
    url,
    timeoutMs,
    maxBodyBytes,
    deps,
  );

  const [localHealth, publicHealth, authorizationServer, protectedResource, descriptor] = await Promise.all([
    request("local-health", `${localOrigin}/health`),
    request("public-health", `${publicOrigin}/health`),
    request("authorization-server", `${publicOrigin}/.well-known/oauth-authorization-server`),
    request("protected-resource", `${publicOrigin}/.well-known/oauth-protected-resource`),
    request("instance-descriptor", `${publicOrigin}/.well-known/vspilink-instance`),
  ]);

  validateHealth("local-health", localHealth, expected);
  validateHealth("public-health", publicHealth, expected);
  validateAuthorizationServer(authorizationServer, publicOrigin);
  validateProtectedResource(protectedResource, publicOrigin, expected);
  validateDescriptor(descriptor, publicOrigin, mcpUrl, expected);

  return Object.freeze({
    publicOrigin,
    mcpUrl,
    identity: expected,
  });
}

async function requestJson(
  stage: EndpointAttestationStage,
  url: string,
  timeoutMs: number,
  maxBodyBytes: number,
  dependencies: EndpointAttestationDependencies,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await dependencies.fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: dependencies.timeoutSignal(timeoutMs),
    });
  } catch (error) {
    throw new EndpointAttestationError(stage, `Unable to fetch ${stage} metadata without redirects`, {
      cause: error,
    });
  }
  if (response.redirected) {
    throw new EndpointAttestationError(stage, `${stage} unexpectedly followed a redirect`);
  }
  if (!response.ok) {
    throw new EndpointAttestationError(stage, `${stage} returned HTTP ${response.status}`);
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new EndpointAttestationError(stage, `${stage} did not return application/json`);
  }

  let body: string;
  try {
    body = await readBoundedBody(response, maxBodyBytes);
  } catch (error) {
    throw new EndpointAttestationError(stage, `${stage} response could not be read within the safe body limit`, { cause: error });
  }
  try {
    return record(JSON.parse(body), stage, "response");
  } catch (error) {
    if (error instanceof EndpointAttestationError) throw error;
    throw new EndpointAttestationError(stage, `${stage} returned invalid JSON`, { cause: error });
  }
}

async function readBoundedBody(response: Response, maxBodyBytes: number): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsed = Number(declaredLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maxBodyBytes) {
      throw new Error("Invalid or oversized Content-Length");
    }
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBodyBytes) {
        await reader.cancel("VSPiLink endpoint attestation body limit exceeded");
        throw new Error("Response body is too large");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

function validateHealth(
  stage: "local-health" | "public-health",
  payload: Record<string, unknown>,
  expected: Readonly<InstanceIdentity>,
): void {
  exact(stage, payload.status, "ok", "status");
  exact(stage, payload.server, "pilink", "server");
  const instance = record(payload.instance, stage, "instance");
  exact(stage, instance.id, expected.instanceId, "instance.id");
  exact(stage, instance.label, expected.instanceLabel, "instance.label");
  exact(stage, instance.fingerprint, expected.instanceFingerprint, "instance.fingerprint");
  exact(stage, instance.connection_fingerprint, expected.connectionFingerprint, "instance.connection_fingerprint");
  exact(stage, instance.connection_name, expected.connectionName, "instance.connection_name");
  exact(stage, instance.connection_description, expected.connectionDescription, "instance.connection_description");
}

function validateAuthorizationServer(payload: Record<string, unknown>, origin: string): void {
  const stage = "authorization-server" as const;
  exact(stage, payload.issuer, origin, "issuer");
  exact(stage, payload.authorization_endpoint, `${origin}/oauth/authorize`, "authorization_endpoint");
  exact(stage, payload.token_endpoint, `${origin}/oauth/token`, "token_endpoint");
  exact(stage, payload.revocation_endpoint, `${origin}/oauth/revoke`, "revocation_endpoint");
  exact(stage, payload.registration_endpoint, `${origin}/oauth/register`, "registration_endpoint");
  exact(stage, payload.authorization_response_iss_parameter_supported, true, "authorization_response_iss_parameter_supported");
  includes(stage, payload.response_types_supported, "code", "response_types_supported");
  includes(stage, payload.grant_types_supported, "authorization_code", "grant_types_supported");
  includes(stage, payload.grant_types_supported, "refresh_token", "grant_types_supported");
  includes(stage, payload.code_challenge_methods_supported, "S256", "code_challenge_methods_supported");
}

function validateProtectedResource(
  payload: Record<string, unknown>,
  origin: string,
  expected: Readonly<InstanceIdentity>,
): void {
  const stage = "protected-resource" as const;
  exact(stage, payload.resource, origin, "resource");
  exact(stage, payload.resource_name, expected.connectionName, "resource_name");
  exact(stage, payload.resource_documentation, `${origin}/.well-known/vspilink-instance`, "resource_documentation");
  exactStringArray(stage, payload.authorization_servers, [origin], "authorization_servers");
  includes(stage, payload.scopes_supported, "mcp:tools", "scopes_supported");
  includes(stage, payload.scopes_supported, "mcp:read", "scopes_supported");
  includes(stage, payload.scopes_supported, "mcp:write", "scopes_supported");
}

function validateDescriptor(
  payload: Record<string, unknown>,
  origin: string,
  mcpUrl: string,
  expected: Readonly<InstanceIdentity>,
): void {
  const stage = "instance-descriptor" as const;
  exact(stage, payload.schema_version, 1, "schema_version");
  exact(stage, payload.instance_id, expected.instanceId, "instance_id");
  exact(stage, payload.instance_label, expected.instanceLabel, "instance_label");
  exact(stage, payload.instance_fingerprint, expected.instanceFingerprint, "instance_fingerprint");
  exact(stage, payload.connection_fingerprint, expected.connectionFingerprint, "connection_fingerprint");
  exact(stage, payload.display_name, expected.connectionName, "display_name");
  exact(stage, payload.description, expected.connectionDescription, "description");
  exact(stage, payload.connection_key, expected.connectionKey, "connection_key");
  exact(stage, payload.server_url, origin, "server_url");
  exact(stage, payload.mcp_url, mcpUrl, "mcp_url");
  const oauth = record(payload.oauth, stage, "oauth");
  exact(stage, oauth.protected_resource_metadata, `${origin}/.well-known/oauth-protected-resource`, "oauth.protected_resource_metadata");
  exact(stage, oauth.authorization_server_metadata, `${origin}/.well-known/oauth-authorization-server`, "oauth.authorization_server_metadata");
}

function canonicalExpectedIdentity(value: Readonly<InstanceIdentity>): Readonly<InstanceIdentity> {
  let canonical: Readonly<InstanceIdentity>;
  try {
    canonical = resolveInstanceIdentity({
      instanceId: value.instanceId,
      instanceLabel: value.instanceLabel,
      publicUrl: value.publicOrigin,
    });
  } catch (error) {
    throw new EndpointAttestationError("configuration", "The expected VSPiLink identity is invalid", { cause: error });
  }
  for (const field of [
    "instanceSlug",
    "instanceFingerprint",
    "connectionFingerprint",
    "connectionName",
    "connectionDescription",
    "connectionKey",
  ] as const) {
    if (value[field] !== canonical[field]) {
      throw new EndpointAttestationError("configuration", `Expected identity field ${field} is not canonical`);
    }
  }
  return canonical;
}

function normalizeLoopbackOrigin(value: string): string {
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
    if (
      !["127.0.0.1", "localhost", "::1"].includes(hostname) ||
      !["http:", "https:"].includes(url.protocol) ||
      url.username || url.password || url.search || url.hash ||
      (url.pathname !== "/" && url.pathname !== "")
    ) throw new Error();
    return url.origin;
  } catch {
    throw new EndpointAttestationError("configuration", "The local attestation origin must be an absolute loopback HTTP(S) origin");
  }
}

function normalizeHttpsOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      (url.pathname !== "/" && url.pathname !== "")
    ) throw new Error();
    return url.origin;
  } catch {
    throw new EndpointAttestationError("configuration", "The public attestation origin must be an absolute HTTPS origin");
  }
}

function record(
  value: unknown,
  stage: EndpointAttestationStage,
  field: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new EndpointAttestationError(stage, `${stage} field ${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(
  stage: EndpointAttestationStage,
  actual: unknown,
  expected: string | number | boolean,
  field: string,
): void {
  if (actual !== expected) {
    throw new EndpointAttestationError(stage, `${stage} field ${field} does not match the selected VSPiLink server`);
  }
}

function includes(
  stage: EndpointAttestationStage,
  actual: unknown,
  expected: string,
  field: string,
): void {
  if (!Array.isArray(actual) || !actual.every((entry) => typeof entry === "string") || !actual.includes(expected)) {
    throw new EndpointAttestationError(stage, `${stage} field ${field} does not advertise ${expected}`);
  }
}

function exactStringArray(
  stage: EndpointAttestationStage,
  actual: unknown,
  expected: readonly string[],
  field: string,
): void {
  if (
    !Array.isArray(actual) ||
    actual.length !== expected.length ||
    actual.some((entry, index) => entry !== expected[index])
  ) {
    throw new EndpointAttestationError(stage, `${stage} field ${field} does not match the selected VSPiLink server`);
  }
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0 || selected > maximum) {
    throw new EndpointAttestationError("configuration", `${name} must be a positive integer no greater than ${maximum}`);
  }
  return selected;
}
