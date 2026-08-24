import path from "node:path";

import type { PublicClientSummary } from "./protocol.js";
import type { WizardAccessMode } from "./wizard-state.js";

export interface PendingFullAccessTarget {
  accessMode: WizardAccessMode;
  configPath?: string;
  publicUrl?: string;
  mcpUrl?: string;
  preferredClientId?: string;
}

export interface CurrentFullAccessTarget {
  configPath: string;
  publicOrigin: string;
}

export type FullAccessClientSelection =
  | { status: "inactive" | "waiting" }
  | { status: "ambiguous"; clientIds: string[] }
  | { status: "selected"; client: PublicClientSummary };

/**
 * Resolves a pending Full access intent only for the exact persisted server
 * origin and only after one current ChatGPT client has durable OAuth proof.
 * Ambiguity fails closed; the caller must require an explicit client choice.
 */
export function selectPendingFullAccessClient(
  pending: Readonly<PendingFullAccessTarget>,
  current: Readonly<CurrentFullAccessTarget>,
  clients: readonly PublicClientSummary[],
): FullAccessClientSelection {
  const publicOrigin = current.publicOrigin.replace(/\/$/u, "");
  if (
    pending.accessMode !== "full" || !pending.configPath ||
    path.resolve(pending.configPath) !== path.resolve(current.configPath) ||
    pending.publicUrl?.replace(/\/$/u, "") !== publicOrigin ||
    pending.mcpUrl !== `${publicOrigin}/sse`
  ) return { status: "inactive" };

  const eligible = clients.filter((client) => (
    client.chatGpt && client.authorized && !client.stale &&
    client.grantTypes.includes("authorization_code") &&
    client.scope.split(/\s+/u).includes("mcp:tools")
  ));
  if (pending.preferredClientId) {
    const selected = eligible.find((client) => client.id === pending.preferredClientId);
    return selected ? { status: "selected", client: selected } : { status: "waiting" };
  }
  if (eligible.length === 1) return { status: "selected", client: eligible[0] };
  if (eligible.length > 1) {
    return { status: "ambiguous", clientIds: eligible.map((client) => client.id).sort() };
  }
  return { status: "waiting" };
}
