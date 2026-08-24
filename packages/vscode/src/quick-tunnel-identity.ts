export interface QuickTunnelRuntimeIdentityInput {
  /** Origin currently persisted in the private VSPiLink configuration. */
  persistedOrigin: string;
  /** Origin reported by the authenticated local PiLink administration API. */
  runtimeOrigin: string;
  /** Optional origin captured from the extension-owned cloudflared process. */
  capturedOrigin?: string;
}

export interface QuickTunnelRuntimeIdentity {
  origin: string;
  changed: boolean;
}

/**
 * Select the one authoritative Quick Tunnel origin without ever combining an
 * old persisted identity with a newly observed edge URL. The authenticated
 * local runtime is authoritative; process output is only a corroborating
 * signal and a disagreement fails closed.
 */
export function resolveQuickTunnelRuntimeIdentity(
  input: Readonly<QuickTunnelRuntimeIdentityInput>,
): Readonly<QuickTunnelRuntimeIdentity> {
  const runtimeOrigin = normalizeQuickTunnelOrigin(input.runtimeOrigin, "runtime");
  if (input.capturedOrigin) {
    const capturedOrigin = normalizeQuickTunnelOrigin(input.capturedOrigin, "captured");
    if (capturedOrigin !== runtimeOrigin) {
      throw new Error("The Cloudflare URL reported by VSPiLink does not match the extension-owned tunnel.");
    }
  }

  return Object.freeze({
    origin: runtimeOrigin,
    changed: normalizeExistingOrigin(input.persistedOrigin) !== runtimeOrigin,
  });
}

function normalizeQuickTunnelOrigin(value: string, source: "runtime" | "captured"): string {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:" ||
      url.username || url.password || url.search || url.hash ||
      (url.pathname !== "/" && url.pathname !== "") ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com$/u.test(hostname)
    ) throw new Error();
    return url.origin;
  } catch {
    throw new Error(`The ${source} Quick Tunnel origin is invalid.`);
  }
}

function normalizeExistingOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
      return "";
    }
    return url.origin;
  } catch {
    return "";
  }
}
