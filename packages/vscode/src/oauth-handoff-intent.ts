import { randomUUID } from "node:crypto";

export const OAUTH_HANDOFF_INTENT_KEY = "vspilink.oauth-handoff.v1";
export const DEFAULT_OAUTH_HANDOFF_TTL_MS = 5 * 60 * 1_000;
export const MAX_OAUTH_HANDOFF_TTL_MS = 15 * 60 * 1_000;

const OAUTH_HANDOFF_PURPOSE = "open-chatgpt-after-oauth" as const;
const INTENT_KEYS = new Set(["schemaVersion", "intentId", "purpose", "createdAt", "expiresAt", "target"]);

export const OAUTH_HANDOFF_IDENTITY_FIELDS = [
  "configPath",
  "instanceId",
  "connectionKey",
  "connectionFingerprint",
  "publicOrigin",
  "mcpUrl",
  "workspace",
] as const;

const IDENTITY_KEYS = new Set<string>(OAUTH_HANDOFF_IDENTITY_FIELDS);

export type OAuthHandoffIdentityField = (typeof OAUTH_HANDOFF_IDENTITY_FIELDS)[number];

/**
 * The complete, non-secret identity of the server and capability target the
 * user confirmed before leaving VS Code for the external OAuth flow.
 */
export interface OAuthHandoffIdentity {
  configPath: string;
  instanceId: string;
  connectionKey: string;
  connectionFingerprint: string;
  publicOrigin: string;
  mcpUrl: string;
  workspace: string;
}

export interface PersistedOAuthHandoffIntent {
  schemaVersion: 1;
  intentId: string;
  purpose: typeof OAUTH_HANDOFF_PURPOSE;
  createdAt: number;
  expiresAt: number;
  target: OAuthHandoffIdentity;
}

export interface OAuthHandoffMementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

export interface OAuthHandoffIntentStoreOptions {
  ttlMs?: number;
  now?: () => number;
  createId?: () => string;
}

export type OAuthHandoffInspection =
  | { status: "pending"; intent: PersistedOAuthHandoffIntent }
  | { status: "missing" }
  | { status: "expired" }
  | { status: "invalid" };

export type OAuthHandoffConsumption =
  | { status: "consumed"; intent: PersistedOAuthHandoffIntent }
  | { status: "missing" }
  | { status: "expired" }
  | { status: "invalid" }
  | { status: "identity-mismatch"; mismatchedFields: OAuthHandoffIdentityField[] };

// An extension host is a single process, but more than one store instance can
// wrap the same VS Code Memento. Serialize all read-modify-write operations by
// Memento identity so concurrent dashboard refreshes cannot consume twice.
const mementoTails = new WeakMap<object, Promise<void>>();

export class OAuthHandoffIntentStore {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(
    private readonly memento: OAuthHandoffMementoLike,
    options: OAuthHandoffIntentStoreOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_OAUTH_HANDOFF_TTL_MS;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs <= 0 || this.ttlMs > MAX_OAUTH_HANDOFF_TTL_MS) {
      throw new Error(`OAuth handoff TTL must be between 1 and ${MAX_OAUTH_HANDOFF_TTL_MS} milliseconds.`);
    }
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
  }

  /** Replace any prior handoff with a fresh intent created by a user gesture. */
  async begin(target: OAuthHandoffIdentity): Promise<PersistedOAuthHandoffIntent> {
    const normalizedTarget = normalizeIdentity(target);
    return this.serialized(async () => {
      const createdAt = this.currentTime();
      const intentId = safeText(this.createId(), "intentId", 256);
      const intent: PersistedOAuthHandoffIntent = {
        schemaVersion: 1,
        intentId,
        purpose: OAUTH_HANDOFF_PURPOSE,
        createdAt,
        expiresAt: createdAt + this.ttlMs,
        target: normalizedTarget,
      };
      await this.memento.update(OAUTH_HANDOFF_INTENT_KEY, intent);
      return cloneIntent(intent);
    });
  }

  /** Read a live intent. Invalid and expired records are removed eagerly. */
  async inspect(): Promise<OAuthHandoffInspection> {
    return this.serialized(async () => {
      const raw = this.memento.get<unknown>(OAUTH_HANDOFF_INTENT_KEY);
      if (raw === undefined) return { status: "missing" };
      const intent = normalizePersistedIntent(raw);
      if (!intent) {
        await this.deleteStoredIntent();
        return { status: "invalid" };
      }
      if (this.isExpired(intent)) {
        await this.deleteStoredIntent();
        return { status: "expired" };
      }
      return { status: "pending", intent: cloneIntent(intent) };
    });
  }

  /**
   * Consume a handoff exactly once and only for the confirmed target identity.
   * A changed target clears the stale handoff instead of leaving it available
   * for a later refresh of the wrong server.
   */
  async consume(target: OAuthHandoffIdentity): Promise<OAuthHandoffConsumption> {
    const normalizedTarget = normalizeIdentity(target);
    return this.serialized(async () => {
      const raw = this.memento.get<unknown>(OAUTH_HANDOFF_INTENT_KEY);
      if (raw === undefined) return { status: "missing" };
      const intent = normalizePersistedIntent(raw);
      if (!intent) {
        await this.deleteStoredIntent();
        return { status: "invalid" };
      }
      if (this.isExpired(intent)) {
        await this.deleteStoredIntent();
        return { status: "expired" };
      }
      const mismatchedFields = oauthHandoffIdentityMismatches(intent.target, normalizedTarget);
      if (mismatchedFields.length > 0) {
        await this.deleteStoredIntent();
        return { status: "identity-mismatch", mismatchedFields };
      }

      // Persist the deletion before telling the caller it is safe to navigate.
      // If Memento.update fails, consume rejects and the chat must not open.
      await this.deleteStoredIntent();
      return { status: "consumed", intent: cloneIntent(intent) };
    });
  }

  /** Clear an intent after cancellation, reset, or an explicit target change. */
  async clear(): Promise<boolean> {
    return this.serialized(async () => {
      if (this.memento.get<unknown>(OAUTH_HANDOFF_INTENT_KEY) === undefined) return false;
      await this.deleteStoredIntent();
      return true;
    });
  }

  /** Remove an expired or malformed intent without consuming a live one. */
  async expire(): Promise<boolean> {
    return this.serialized(async () => {
      const raw = this.memento.get<unknown>(OAUTH_HANDOFF_INTENT_KEY);
      if (raw === undefined) return false;
      const intent = normalizePersistedIntent(raw);
      if (intent && !this.isExpired(intent)) return false;
      await this.deleteStoredIntent();
      return true;
    });
  }

  private currentTime(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("OAuth handoff clock returned an invalid timestamp.");
    return value;
  }

  private isExpired(intent: PersistedOAuthHandoffIntent): boolean {
    const now = this.currentTime();
    // A clock moving behind creation time must not extend a security intent.
    return now < intent.createdAt || now >= intent.expiresAt;
  }

  private async deleteStoredIntent(): Promise<void> {
    await this.memento.update(OAUTH_HANDOFF_INTENT_KEY, undefined);
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    return withMementoLock(this.memento, operation);
  }
}

export function oauthHandoffIdentityMismatches(
  expected: OAuthHandoffIdentity,
  actual: OAuthHandoffIdentity,
): OAuthHandoffIdentityField[] {
  const left = normalizeIdentity(expected);
  const right = normalizeIdentity(actual);
  return OAUTH_HANDOFF_IDENTITY_FIELDS.filter((field) => left[field] !== right[field]);
}

export function isExactOAuthHandoffIdentity(
  expected: OAuthHandoffIdentity,
  actual: OAuthHandoffIdentity,
): boolean {
  return oauthHandoffIdentityMismatches(expected, actual).length === 0;
}

function normalizePersistedIntent(value: unknown): PersistedOAuthHandoffIntent | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, INTENT_KEYS)) return undefined;
  if (
    value.schemaVersion !== 1 || value.purpose !== OAUTH_HANDOFF_PURPOSE ||
    typeof value.intentId !== "string" || typeof value.createdAt !== "number" ||
    typeof value.expiresAt !== "number" || !Number.isSafeInteger(value.createdAt) ||
    !Number.isSafeInteger(value.expiresAt) || value.createdAt < 0 ||
    value.expiresAt <= value.createdAt || value.expiresAt - value.createdAt > MAX_OAUTH_HANDOFF_TTL_MS
  ) return undefined;

  try {
    const intentId = safeText(value.intentId, "intentId", 256);
    const target = normalizeIdentity(value.target);
    return {
      schemaVersion: 1,
      intentId,
      purpose: OAUTH_HANDOFF_PURPOSE,
      createdAt: value.createdAt,
      expiresAt: value.expiresAt,
      target,
    };
  } catch {
    return undefined;
  }
}

function normalizeIdentity(value: unknown): OAuthHandoffIdentity {
  if (!isRecord(value) || !hasOnlyKeys(value, IDENTITY_KEYS)) {
    throw new Error("OAuth handoff target must contain only the complete public server identity.");
  }
  const publicOrigin = normalizePublicOrigin(value.publicOrigin);
  const mcpUrl = normalizeMcpUrl(value.mcpUrl, publicOrigin);
  return {
    configPath: safeText(value.configPath, "configPath", 8_192),
    instanceId: safeText(value.instanceId, "instanceId", 2_048),
    connectionKey: safeText(value.connectionKey, "connectionKey", 2_048),
    connectionFingerprint: safeText(value.connectionFingerprint, "connectionFingerprint", 2_048),
    publicOrigin,
    mcpUrl,
    workspace: safeText(value.workspace, "workspace", 8_192),
  };
}

function normalizePublicOrigin(value: unknown): string {
  const text = safeText(value, "publicOrigin", 2_048);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("OAuth handoff publicOrigin must be an absolute HTTPS origin.");
  }
  if (
    url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" ||
    url.search || url.hash || url.origin === "null"
  ) throw new Error("OAuth handoff publicOrigin must be an absolute HTTPS origin without credentials, path, query, or fragment.");
  return url.origin;
}

function normalizeMcpUrl(value: unknown, publicOrigin: string): string {
  const text = safeText(value, "mcpUrl", 4_096);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("OAuth handoff mcpUrl must be an absolute HTTPS URL.");
  }
  if (
    url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
    url.origin !== publicOrigin
  ) throw new Error("OAuth handoff mcpUrl must be a credential-free URL on the exact public origin.");
  return url.href;
}

function safeText(value: unknown, name: string, maxLength: number): string {
  if (
    typeof value !== "string" || value.length === 0 || value.length > maxLength ||
    value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)
  ) throw new Error(`OAuth handoff ${name} is invalid.`);
  return value;
}

function cloneIntent(intent: PersistedOAuthHandoffIntent): PersistedOAuthHandoffIntent {
  return { ...intent, target: { ...intent.target } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.size && keys.every((key) => allowed.has(key));
}

function withMementoLock<T>(memento: object, operation: () => Promise<T>): Promise<T> {
  const previous = mementoTails.get(memento) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const tail = result.then(() => undefined, () => undefined);
  mementoTails.set(memento, tail);
  return result.finally(() => {
    if (mementoTails.get(memento) === tail) mementoTails.delete(memento);
  });
}
