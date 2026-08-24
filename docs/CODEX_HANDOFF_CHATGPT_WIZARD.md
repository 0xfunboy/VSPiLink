# Codex handoff: finish the VSPiLink ChatGPT setup wizard

This document is the implementation brief for the Codex instance that owns the
main VSPiLink development work. Treat the branch containing this file as the
working baseline: it includes the server-specific identity model, corrected
ChatGPT OAuth flow, and the external-browser pairing workaround proven against
a real remote VSPiLink installation on 2026-08-23.

## Prompt for the receiving Codex

```text
Fetch and check out branch agent/chatgpt-wizard-handoff from
https://github.com/0xfunboy/VSPiLink. Read
docs/CODEX_HANDOFF_CHATGPT_WIZARD.md completely before editing. Preserve the
already working OAuth, owner-pairing, instance-identity and multi-server
boundaries. Implement the remaining P0 items in priority order, keeping normal
ChatGPT Chat as the primary product flow. Do not restore the old ChatGPT Work
workflow and do not add a central router that can silently select another
machine. Run the focused tests after each area and leave the branch releasable.
```

## Product contract

VSPiLink is one distributable package, but every installed server is a distinct
remote target:

```text
one OS installation/configuration + one stable public HTTPS origin
= one VSPiLink instance identity
= one visibly named ChatGPT app/connection
= one independent OAuth/DCR client boundary
```

Normal ChatGPT Chat is the user-facing agent. The VSPiLink connection selected
in that chat may execute only on the server exposed by that connection. Never
accept a machine name as a tool argument and route it through a shared relay.
Multiple servers must remain separate both technically and visibly.

The connection identity belongs to the server installation and public origin.
The currently exposed workspace is mutable configuration and must always be
shown separately. Changing a folder must not silently turn one server identity
into another or claim that an old fingerprint permanently identifies a folder.

## What is already implemented and must be preserved

### Server and connection identity

- `src/config.ts` and `packages/vscode/src/configuration.ts` derive an instance
  fingerprint, connection fingerprint, display name, and connection key from a
  stable instance UUID plus the effective public origin.
- The generated name is intentionally recognizable, for example
  `VSPiLink — build-vps · a1b2c3d4e5`.
- `src/index.ts` exposes the non-secret descriptor at
  `/.well-known/vspilink-instance` and includes identity in status data.
- `src/mcp.ts` publishes identity in MCP server information, instructions,
  approval context, tool metadata, and target-inspection results.
- OAuth tokens are audience-bound to the configured `SERVER_URL`, so a token
  for one origin cannot authorize a different VSPiLink server.

### OAuth compatible with the current ChatGPT plugin flow

- Authorization Code with PKCE and Dynamic Client Registration are supported.
- OAuth `resource` is carried through authorization, consent, authorization
  code, and token validation.
- Authorization responses include the authorization-server `iss` parameter,
  and discovery advertises
  `authorization_response_iss_parameter_supported: true`.
- DCR advertises `response_types: ["code"]`.
- The current ChatGPT callback and the stable
  `https://chatgpt.com/connector_platform_oauth_redirect` callback are
  allowlisted; arbitrary public redirect URIs remain rejected.
- The real connection was verified end to end: DCR, consent, token issuance,
  durable refresh token, Streamable HTTP/SSE initialization, and an active MCP
  session all completed successfully.

Primary files:

- `src/oauth.ts`
- `src/auth.ts`
- `src/types.ts`
- `test/oauth.integration.test.mjs`

### One-use owner pairing and browser handoff

VS Code's Integrated Browser blocks popup windows. ChatGPT currently launches
the connector sign-in in a popup, which previously produced a blank
`about:blank` tab. The working solution is:

1. the extension requests a short-lived, one-use pairing URL from the
   loopback-only authenticated admin endpoint;
2. `/oauth/pair` establishes the owner session and redirects to the intended
   ChatGPT page;
3. the extension opens that URL with `vscode.env.openExternal`, so setup and
   consent run in the user's normal system browser;
4. the dashboard observes the durable OAuth authorization and returns normal
   ChatGPT Chat to the VS Code Integrated Browser.

Do not redirect the ChatGPT OAuth popup back into the Integrated Browser.

Primary files:

- `src/oauth-owner.ts`
- `src/oauth.ts`
- `packages/vscode/src/health.ts`
- `packages/vscode/src/extension.ts` (`pairWizardOwner`, `openChatGpt` and the
  `returnToIntegratedChatAfterOAuth` state)
- `packages/vscode/src/wizard-controller.ts`
- `packages/vscode/media/main.js`
- `packages/vscode/test/extension-commercial.test.ts`
- `packages/vscode/test/dashboard-ui.test.ts`

### Hosting and service groundwork

- Existing domain, Quick Tunnel, and Cloudflare Named Tunnel paths already
  exist.
- The Named Tunnel implementation can provision Cloudflare records and install
  managed per-user systemd units.
- The dashboard can inspect and recover managed hosting state.
- OAuth pairing and runtime administration remain loopback-only and require the
  local bootstrap credential.

Primary files:

- `src/hosting/`
- `packages/vscode/src/hosting-model.ts`
- `packages/vscode/src/named-hosting-recovery.ts`
- `packages/vscode/src/extension.ts`

## Remaining implementation

### P0 — one canonical identity implementation

1. Remove the duplicated identity derivation in `src/config.ts` and
   `packages/vscode/src/configuration.ts`. Put normalization, labels, names,
   descriptions, keys, and fingerprints behind one shared implementation and
   contract test.
2. Derive the connection fingerprint from the *effective public origin*. Quick
   Tunnel currently risks computing the wizard snapshot from loopback before
   the `trycloudflare.com` origin is known. Recompute and persist after the
   public URL is established.
3. Preserve legacy identity. When an existing installation lacks
   `PI_INSTANCE_ID`, persist the deterministic legacy UUID derived from its
   existing `JWT_SECRET`; do not replace it with a new random UUID during
   provisioning.
4. Make `PI_INSTANCE_LABEL` describe the machine/server installation. Display
   `PI_WORK_DIR` separately as the current workspace. Remove wording in
   `src/mcp.ts` and docs that says a connection fingerprint is permanently
   bound to a workspace.
5. Use the same canonical connection description in the VS Code copy field,
   MCP `serverInfo`, OAuth consent, discovery descriptor, and dashboard. Add
   that description to `/.well-known/vspilink-instance`; it is not present in
   the current descriptor.
6. On every pending/connected/error screen show the exact connection name,
   fingerprint, HTTPS origin, MCP URL, and current workspace. Never fall back
   to a generic `VSPiLink` label when more than one server may exist.

### P0 — make first run one guided flow

The happy path should require decisions, not manual configuration archaeology:

1. detect local versus Remote SSH execution and select the remote extension
   host/workspace explicitly;
2. provision or verify the supported Node runtime;
3. generate/persist instance identity and private state outside the workspace;
4. select confined folder access by default, with a separate warning for full
   machine access;
5. offer Named Tunnel, existing HTTPS origin, or temporary Quick Tunnel;
6. for Named Tunnel, launch the supported Cloudflare login/authorization step,
   let the user authenticate, then create/reuse the dedicated tunnel and DNS
   record without asking them to move credential files by hand;
7. install and enable the managed user services;
8. detect whether user lingering is enabled. Offer a guided
   `loginctl enable-linger <current-user>` step when policy permits it, explain
   the exact manual command only when the OS requires administrator approval,
   and verify the result;
9. wait for local health, public health, OAuth discovery, and exact instance
   descriptor agreement;
10. present copy buttons for the canonical name, description, and `/sse` URL;
11. open the one-use system-browser pairing handoff;
12. poll local authorization state and, after success, open normal ChatGPT Chat
   in VS Code with an explicit fallback button.

The ChatGPT-owned `+`/Create/Review/Connect/Approve actions remain deliberate
human steps. Do not automate ChatGPT by scraping its DOM, copying cookies, or
inventing a private API. Automate everything around those actions and keep the
instructions on the same wizard screen.

### P0 — durable OAuth recovery

1. Replace the purely in-memory
   `returnToIntegratedChatAfterOAuth` intention with a short-lived extension
   state record. The flow must survive closing the dashboard, reloading the VS
   Code window, or restarting the extension while system-browser approval is in
   progress.
2. Clear that record on success, explicit cancel, expiry, target identity
   change, or reset. It must never open a chat for a different server.
3. If authorization already exists, do not create another DCR client. Show the
   authorized client and offer **Open ChatGPT Chat**, **Reconnect**, and
   **Revoke** as separate actions.
4. Remove or deprecate the old `registerUriHandler` / `openOAuthInVsCode` path
   if it no longer has a tested non-ChatGPT use. At minimum, make it impossible
   for that path to send the ChatGPT OAuth popup to the Integrated Browser.
5. Recover cleanly from denied consent, expired pairing, stale callback,
   browser cancellation, deleted ChatGPT app, rotated refresh token, service
   restart, and changed public origin.

### P0 — multi-server safety

1. Add a final confirmation card before ChatGPT setup showing **machine label +
   fingerprint + origin + workspace**.
2. Repeat the same identity in OAuth consent and execution approval. A user
   must be able to notice that the wrong server was selected before a write.
3. Never reuse a ChatGPT app/connection after its public origin changes. Mark
   the old connection stale and guide creation of a new server-specific entry.
4. Add tests with two simultaneous configurations proving different instance
   IDs/origins produce different names, keys, fingerprints, OAuth audiences,
   and descriptors.
5. Keep Codex MCP configuration optional and separate. It is not part of the
   normal ChatGPT Chat workflow.

### P1 — packaging and release polish

1. Reduce the VSIX payload. The current package contains roughly 17,900 files
   and is about 28 MB; prune development-only and unused transitive files with
   the build pipeline and `.vscodeignore`, then test the installed VSIX rather
   than only the source tree.
2. Add a real Remote SSH smoke test covering extension-host location, workspace
   selection, external-browser handoff, and reconnect after VS Code reload.
3. Audit remaining docs for stale ChatGPT Work, connector, callback-copy, and
   old **Scan Tools** instructions. `docs/CONNECT_CHATGPT.md` is the canonical
   user flow.
4. Add a release checklist that builds, packages, installs, verifies hashes,
   reloads VS Code, and checks version/update behavior.

## Acceptance criteria

A release is ready when all of these are true:

- On Windows with a Remote SSH workspace, a new user can install the VSIX and
  reach the ChatGPT Create screen through one guided sequence.
- The OAuth sign-in never produces `about:blank` and never asks an external
  browser to "confirm in VS Code".
- A successful approval creates one DCR client and one durable refresh-token
  family, with PKCE, `resource`, audience, redirect URI, and issuer validation
  intact.
- The wizard recognizes success after reload/restart and returns the user to
  normal ChatGPT Chat in VS Code or shows one clear button to do so.
- Two servers are visibly distinct everywhere and cannot share tokens or be
  selected through a hidden router.
- Changing workspace preserves the server identity but updates the displayed
  current workspace everywhere.
- Named Tunnel and VSPiLink services are active after logout and reboot when
  lingering is enabled; the wizard detects and explains any OS policy blocker.
- Cancel, deny, expiry, hostname change, deleted client, and reset each lead to
  a recoverable state with no secret printed in logs or copied into the repo.

## Focused verification

Use focused tests during implementation; run the complete suite before a
release branch is merged:

```bash
npm run build
npm run vscode:typecheck
node --test test/oauth.integration.test.mjs
npx tsx --test \
  packages/vscode/test/configuration.test.ts \
  packages/vscode/test/dashboard-ui.test.ts \
  packages/vscode/test/extension-commercial.test.ts \
  packages/vscode/test/named-hosting-recovery.test.ts
npm run security:scan
```

Before release:

```bash
npm run test:all
npm run vscode:package
npm run release:check
```

Never put `.env`, OAuth tokens, refresh tokens, bootstrap secrets, Cloudflare
credentials, tunnel credentials, or browser cookies in fixtures, screenshots,
commits, or issue text.

## Authoritative external behavior

- OpenAI's connection flow and account-owned Create/Review steps:
  <https://developers.openai.com/plugins/deploy/connect-chatgpt>
- OpenAI OAuth, PKCE, DCR, issuer, and resource guidance:
  <https://developers.openai.com/plugins/build/auth>
- VS Code Integrated Browser limitations, including blocked popups:
  <https://code.visualstudio.com/docs/debugtest/integrated-browser>

If the product UI changes, update only the UI instructions. Do not weaken the
server identity, redirect validation, PKCE, resource binding, owner pairing, or
one-server-per-connection invariants to chase a transient browser behavior.
