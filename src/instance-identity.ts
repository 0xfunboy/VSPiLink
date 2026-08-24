import { createHash, randomUUID } from "node:crypto";
import os from "node:os";

export interface InstanceIdentity {
  instanceId: string;
  instanceLabel: string;
  instanceSlug: string;
  instanceFingerprint: string;
  publicOrigin: string;
  connectionFingerprint: string;
  connectionName: string;
  connectionDescription: string;
  connectionKey: string;
}

export interface InstanceIdentityOptions {
  instanceId?: string;
  instanceLabel?: string;
  publicUrl: string;
  legacyJwtSecret?: string;
  fallbackSeed?: string;
  hostname?: string;
}

/**
 * One canonical identity contract shared by the MCP service and VS Code.
 * The installation UUID identifies the server; the effective public origin
 * identifies the ChatGPT connection. The mutable workspace is deliberately
 * absent from every derived identity field.
 */
export function resolveInstanceIdentity(options: InstanceIdentityOptions): Readonly<InstanceIdentity> {
  const hostname = options.hostname ?? os.hostname();
  const instanceId = options.instanceId
    ? normalizeInstanceId(options.instanceId)
    : options.legacyJwtSecret
      ? legacyInstanceId(options.legacyJwtSecret)
      : deterministicInstanceId(`unconfigured\0${hostname}\0${options.fallbackSeed || "default"}`);
  const instanceLabel = options.instanceLabel
    ? normalizeInstanceLabel(options.instanceLabel)
    : defaultInstanceLabel(hostname);
  const instanceSlug = slug(instanceLabel, 24);
  const instanceFingerprint = fingerprint(`instance\0${instanceId}`);
  const publicOrigin = normalizePublicOrigin(options.publicUrl);
  const connectionFingerprint = fingerprint(`connection\0${instanceId}\0${publicOrigin}`);
  const connectionName = `VSPiLink — ${instanceLabel} · ${connectionFingerprint}`;
  return Object.freeze({
    instanceId,
    instanceLabel,
    instanceSlug,
    instanceFingerprint,
    publicOrigin,
    connectionFingerprint,
    connectionName,
    connectionDescription: `Secure MCP coding-agent bridge to ${instanceLabel} at ${publicOrigin} · ${connectionFingerprint}`,
    connectionKey: `vspilink-${instanceSlug}-${connectionFingerprint}`,
  });
}

export function createInstanceId(): string {
  return randomUUID();
}

export function legacyInstanceId(jwtSecret: string): string {
  if (!jwtSecret) throw new Error("JWT_SECRET is required to preserve legacy instance identity");
  return deterministicInstanceId(`legacy\0${jwtSecret}`);
}

export function defaultInstanceLabel(hostname = os.hostname()): string {
  const normalized = hostname
    .normalize("NFKD")
    .replace(/[^a-z0-9._ -]+/giu, "-")
    .replace(/[\s._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);
  return normalized || "server";
}

export function normalizeInstanceId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(normalized)) {
    throw new Error("PI_INSTANCE_ID must be a canonical UUID");
  }
  return normalized;
}

export function normalizeInstanceLabel(value: string): string {
  const normalized = value.trim();
  if (!/^[a-z0-9][a-z0-9._ -]{0,63}$/iu.test(normalized)) {
    throw new Error("PI_INSTANCE_LABEL must be 1-64 safe display characters");
  }
  return normalized;
}

export function normalizePublicOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username || url.password || url.search || url.hash ||
      (url.pathname !== "/" && url.pathname !== "")
    ) throw new Error();
    return url.origin;
  } catch {
    throw new Error("SERVER_URL must be an absolute HTTP(S) origin");
  }
}

function deterministicInstanceId(seed: string): string {
  const bytes = Buffer.from(createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 32), "hex");
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 10);
}

function slug(value: string, maxLength: number): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, maxLength) || "server";
}
