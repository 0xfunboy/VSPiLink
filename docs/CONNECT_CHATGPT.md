# Connect normal ChatGPT Chat

This is the canonical connection guide. VSPiLink uses a personal ChatGPT
plugin backed by one remote MCP endpoint. Each machine gets its own distinct
connection; normal Chat uses it after you select it from the Plugins menu.

The supported flow is:

```text
Normal Chat -> selected personal plugin -> OAuth -> VSPiLink MCP endpoint
            -> Pi tool harness -> selected VS Code workspace
```

## Before you begin

Confirm all four layers:

1. VSPiLink is installed and Node.js 24.18.0 is available.
2. The selected workspace is trusted and the sidecar is healthy on loopback.
3. The public VSPiLink origin is stable, HTTPS, and reachable from the
   Internet.
4. Your ChatGPT plan and policy allow personal plugins and remote MCP tools.

OpenAI documents creation as **Plugins → + → name/description → endpoint →
Create**, followed by review and OAuth. The controls visible to you depend on
product rollout and policy. VSPiLink is not an unrelated public result found by
searching for "MCP server".

## 1. Prepare the local bridge

1. In VS Code, open the project folder.
2. If the right sidebar is hidden, select **View -> Appearance -> Secondary
   Side Bar**, then select the **VSPiLink** view.
3. Keep **ChatGPT MCP** selected.
4. Select the guided connect/setup action.
5. Choose **Open folder** access for the normal safe mode.
6. Choose a stable HTTPS origin:
   - **Cloudflare Named Tunnel** for a persistent managed tunnel;
   - **Existing domain** when you already operate DNS and a reverse proxy;
   - **Quick Tunnel** only for a temporary evaluation.
7. Wait until the runtime and public endpoint are both healthy.
8. Copy the MCP URL ending in `/sse` when VSPiLink presents it.

The `/sse` URL is a protocol endpoint, not a website. Opening it in a browser
may show an authentication response or no useful page. Use VSPiLink health and
OAuth discovery checks to validate it.

## 2. Make VSPiLink available as a plugin

VSPiLink uses one distributable package and one separate app/connection
instance for every server. Do not download, rename, or fork the package for
each VPS. The installation generates a stable instance ID and a connection
name such as `VSPiLink — build-vps · a1b2c3d4e5`; that exact name is bound to
one server installation and MCP origin. The currently selected workspace is
shown separately and may be changed deliberately on that server.

ChatGPT creates a private `plugin_asdk_app...` identifier in the owner's
account or workspace only after that owner registers the MCP connection.
VSPiLink cannot bypass ChatGPT's Create/Review step or OAuth consent. It
automates the server identity, endpoint, OAuth discovery, DCR and copyable
values so the owner never has to invent identifiers.

Create one owner-provided app entry **per VSPiLink server**, then share each
entry through the personal or workspace plugin source permitted by policy.
Other authorized users install the entry for the server they intend to use.
Never repoint an existing entry to a different VPS or local machine.

In ChatGPT web:

1. In the VSPiLink sidebar, select **Open setup in browser**. VSPiLink opens
   the system browser with a one-use owner pairing already applied. This setup
   handoff is required because VS Code's integrated browser blocks the OAuth
   popup used by ChatGPT; normal Chat returns inside VS Code after approval.
2. Copy the generated **Connection name** and MCP URL.
   Automation may read the same non-secret values from
   `https://YOUR-MCP-HOST/.well-known/vspilink-instance`.
3. Open **Plugins**, select the personal tab, and click `+`.
4. Create a **new** connection using the exact generated name, description and
   endpoint, then select OAuth/DCR.
5. Review that the displayed name, endpoint and fingerprint match the intended
   machine, then approve OAuth.
6. Repeat only step 4 once for every additional VSPiLink server. Do not edit the
   first server's app to point at the second server.
7. If no personal/workspace creation control exists, ask the workspace
   administrator or plugin publisher to create the server-specific entry.

Do not install Workable, Alpic, or another public result merely because its
description contains "MCP". It will connect to that vendor's server, not your
VSPiLink instance.

The repository directory `plugins/vspilink` is an optional **Codex local
plugin** whose MCP URL is loopback-only. It is intentionally separate from the
private ChatGPT plugin and cannot provision or substitute for the
owner-specific ChatGPT identifier above.

### Multiple-server invariant

```text
one VSPiLink configuration + one instance ID + one HTTPS origin
= one named ChatGPT app/connection + one DCR client
```

The package may be installed on any number of machines, but connection
instances are never shared between origins. OAuth access tokens are already
audience-bound to the exact `SERVER_URL`; the generated name and fingerprint
make the same boundary visible to people and models. A central router that
silently chooses a machine from a tool argument is intentionally unsupported.

Codex MCP configuration is a separate optional integration and is not used by
the normal-Chat workflow described here.

Official references:

- [Connect a plugin to ChatGPT](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [Plugin architecture](https://developers.openai.com/plugins/concepts/plugins)
- [OAuth, PKCE and Dynamic Client Registration](https://developers.openai.com/plugins/build/auth)
- [Build an MCP-backed plugin](https://developers.openai.com/plugins/build/mcp-server)

## 3. Complete OAuth

VSPiLink publishes protected-resource and authorization-server metadata. A
compatible OpenAI host discovers its authorization URL, token URL, scopes, and
client-registration methods.

### Dynamic Client Registration

Use DCR when the plugin builder offers it:

1. Select **OAuth** for the VSPiLink connection.
2. Select **Dynamic Client Registration (DCR)** if a registration method is
   requested.
3. Create or save the connection.
4. Select **Connect**, **Authenticate**, or **Sign in with VSPiLink**.
5. On the VSPiLink consent page, verify the client name, endpoint, workspace,
   and requested scopes.
6. Select **Approve** once and wait for the redirect back to ChatGPT.

The system browser is used only for this setup/consent step. The wizard watches
for the issued token and opens normal Chat in VS Code's integrated browser as
soon as the connection succeeds.

DCR registers the callback and client automatically. Do **not** search for a
callback/fallback URL, invent a client ID, or paste a secret when DCR succeeds.
VSPiLink uses Authorization Code with PKCE for the public DCR client.

### User-defined compatibility fallback

Use this only when the active builder explicitly supports a user-defined OAuth
client but cannot use DCR:

1. Copy the exact Callback/Redirect URL displayed by that builder.
2. Open VSPiLink's manual OAuth fallback.
3. Register that exact callback.
4. Copy the generated Client ID, one-time Client secret, Authorization URL, and
   Token URL into the matching fields.
5. Use `client_secret_post` when the builder asks for the token endpoint
   authentication method.
6. Request only the scopes required for the intended tools.

Never paste the client secret into ChatGPT conversation text, a repository,
issue, screenshot, or log. If the builder does not expose these controls, the
manual fallback is not available on that surface.

### Developer Mode visibility

If the personal Plugins page does not show `+`, open Security and login and
check whether Developer Mode is available for the account. Labels and
availability may differ. Do not weaken DCR, OAuth, or callback validation to
compensate for a missing account-level control.

## 4. Run the first task

1. Start a new normal **Chat**.
2. From `+ → Plugins`, select the exact VSPiLink name and fingerprint for the
   intended machine.
3. Begin with a bounded read-only request, for example:

   ```text
   Use VSPiLink to inspect the configured workspace. Report its root, Git
   status, package scripts, and the tests you would run. Do not modify files.
   ```

4. Confirm the VSPiLink sidebar reports an authenticated MCP session.
5. Review the reported workspace before authorizing writes or execution.
6. Continue with a narrowly scoped implementation request.

ChatGPT decides when to invoke tools. A connected session does not mean every
message will call VSPiLink.

## What the monitor shows

- MCP connection and durable OAuth identity counts;
- metadata-only tool activity;
- messages explicitly posted through `agent_chat_post`;
- tasks created or updated through `agent_task_*`;
- supervised Pi agent status when that optional runtime is configured.

It does not read the ChatGPT DOM, cookies, reasoning, private transcript, or
composer. An empty collaboration feed can be healthy if no agent has posted to
the shared chat or task board.

## Returning after a restart

With a stable origin, VSPiLink should reuse the saved server configuration and
OAuth client. A new transport session may appear without repeating setup.

Quick Tunnel is different: its hostname changes, so the previous plugin
connection points to an obsolete origin. Create a new connection for the new
origin or migrate to a Named Tunnel/existing domain.

## ChatGPT and Codex

| Surface | VSPiLink use |
| --- | --- |
| Normal Chat | Primary workflow: select the server-specific personal VSPiLink plugin |
| ChatGPT Work | Separate surface; use only if your account deliberately requires it |
| Codex desktop/CLI/IDE | Optional separate MCP configuration; not part of this ChatGPT connection |
| Pi Local | Uses a provider configured in VSPiLink and separate credentials/usage |

Plans, usage and plugin availability are controlled by OpenAI and may change.
See [Usage, models, and costs](USAGE_AND_COSTS.md).
