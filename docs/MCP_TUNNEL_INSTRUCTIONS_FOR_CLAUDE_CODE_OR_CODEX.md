# MCP Tunnel Instructions for Claude Code or Codex

Use this runbook to connect a **second computer** to the same Cloudflare DNS
zone with its own VSPiLink MCP server. It is written so that it can be handed
to Claude Code, Codex, or a human operator.

This guide creates a parallel installation. It does not migrate or replace the
existing server. The managed Named Tunnel path documented here currently
requires a **Linux host with a working systemd user manager**. Do not use these
steps unchanged on Windows, macOS, a container without systemd, or WSL without
systemd.

This is a reusable template. Replace every value in braces, such as
`{base-domain}`, and every value in angle brackets, such as `<server-slug>`,
before running a command or handing the assignment to an agent.

## The one rule that prevents most mistakes

The second computer may use the same base domain, but it must not use the same
tunnel or the same hostnames.

Write down the current production values before starting and keep them
unchanged:

| Item | Existing value — fill this in and do not reuse or change |
| --- | --- |
| Tunnel | `{current-tunnel}` |
| MCP hostname | `{current-mcp-host}` |
| VSPiLink page | `{current-page-host}` |
| Local origin | `http://127.0.0.1:3200` on the existing computer |

Choose a short, stable name for the new computer. In this guide it is called
`<server-slug>`. Use only lowercase letters, digits, and single hyphens; begin
and end with a letter or digit. For a computer named `aireward`, use:

| Item | Value for the new computer |
| --- | --- |
| Server slug | `aireward` |
| Tunnel | `vspilink-aireward` |
| DNS zone | `example.com` |
| MCP hostname | `mcp-aireward.example.com` |
| VSPiLink page | `vspilink-aireward.example.com` |
| MCP endpoint | `https://mcp-aireward.example.com/sse` |
| Local origin | `http://127.0.0.1:3200` on the new computer |

Do not attach two simultaneously active computers to one tunnel. Cloudflare
treats them as tunnel replicas and may send a request to either computer. That
would expose the wrong workspace to ChatGPT.

Do not copy the old host's `~/.config/pilink`, `.env`, OAuth clients, refresh
tokens, bootstrap/JWT secrets, tunnel token, or tunnel credentials. Every host
must initialize its own private runtime and OAuth state.

> **Replacing the old computer?** Stop here. A replacement that must retain
> `{current-mcp-host}` needs a planned cutover, not a second parallel tunnel.

## Copy this assignment to Claude Code or Codex

Copy the following block into the coding agent on the **new computer**:

```text
Configure this computer as a second VSPiLink MCP host by following
"docs/MCP_TUNNEL_INSTRUCTIONS_FOR_CLAUDE_CODE_OR_CODEX.md" exactly.

Start with read-only checks. Use the server slug I provide and show me the
proposed tunnel name, MCP hostname, and page hostname before changing anything.
Do not change or reuse the current tunnel or current hostnames listed below.
Never ask me to paste a Cloudflare token, certificate, OAuth secret, or .env
file into chat. Tell me exactly where to click and let me enter or select
secret material locally. Use Project folder only unless I explicitly authorize
Full access. At the end, run every verification in this document and report
only redacted results.

Server slug: <replace-with-the-new-computer-name>
Base domain: <replace-with-the-existing-Cloudflare-DNS-zone>
Project folder: <replace-with-the-project-folder>
Current tunnel: <replace-with-the-current-tunnel-name>
Current MCP hostname: <replace-with-the-current-MCP-hostname>
Current page hostname: <replace-with-the-current-page-hostname>
```

## Before starting

On the new computer:

1. Connect to it with **VS Code → Remote Explorer → SSH → Connect in Current
   Window**.
2. Click **File → Open Folder…** and open the project that ChatGPT may access.
3. Check the blue remote indicator in the lower-left corner. It must name the
   new computer.
4. Open **Extensions** with `Ctrl+Shift+X`, search for
   `@id:0xfunboy.vspilink`, and install VSPiLink on the **SSH host**, not only
   on the local VS Code client. If the Marketplace listing is not available,
   use the verified VSIX release installer instead.
5. Confirm that the host has a working systemd user manager:

   ```bash
   systemctl --user show-environment >/dev/null
   command -v systemd-analyze
   ```

   Stop if either command fails. Do not try to work around this with a second
   root-level service.
6. Confirm that the remote host uses exactly Node.js `24.18.0`:

   ```bash
   node --version
   ```

   The expected output is `v24.18.0`. If it is unavailable, use the complete
   VSPiLink release installer described in [Installation](INSTALLATION.md);
   installing only the Marketplace extension does not install Node.js.
7. Let the graphical VSPiLink wizard verify `cloudflared`. If it is missing,
   approve the wizard's one-click installation of the pinned, checksum-verified
   helper. Do not run Cloudflare's system service installer: VSPiLink owns its
   dedicated user service. A manually managed executable is only a fallback
   for an offline or policy-restricted host and must come from the official
   [cloudflared downloads](https://developers.cloudflare.com/tunnel/downloads/).
8. Trust the project only if you understand its code. Do not open the entire
   home directory merely for convenience.

## Recommended production path: a dedicated tunnel token

This path limits the new computer to one tunnel. A person with access to the
Cloudflare account performs the dashboard steps; the token itself is never
sent to the coding agent.

### 1. Create the new tunnel in Cloudflare

The Cloudflare account owner must click:

1. Open the [Cloudflare dashboard](https://dash.cloudflare.com/).
2. Select the account that owns `{base-domain}`.
3. Click **Networking → Tunnels**.
4. Click **Create a tunnel**.
5. Choose **Cloudflared**, if Cloudflare asks for a connector type.
6. Enter `vspilink-<server-slug>` as the tunnel name.
7. Click **Create Tunnel**.
8. Select the operating system and architecture of the new computer.
9. Copy the installation command into a private text editor. **Do not run it.**
   The long `eyJ…` value in that command is the tunnel token.
10. Record the tunnel UUID shown by Cloudflare. A UUID looks like
    `00000000-0000-4000-8000-000000000000`; it is not the token.

Cloudflare may label step 9 **Add a replica** after the new tunnel has been
created. Use it only after checking that the page shows the **new tunnel name
and new UUID**. If `vspilink-<server-slug>` existed before this procedure, stop
and choose a different slug. Never click **Add a replica** on
`{current-tunnel}`.

The new tunnel can remain **Inactive** until the VSPiLink wizard starts it.
That is expected; do not install Cloudflare's service to make it active.

### 2. Add the two public routes

Still in Cloudflare:

1. Open **Networking → Tunnels → `vspilink-<server-slug>`**.
2. Open the **Routes** tab.
3. Click **Add route → Published application**.
4. Enter subdomain `mcp-<server-slug>`.
5. Select domain `{base-domain}`.
6. Enter Service URL `http://127.0.0.1:3200`.
7. Click **Save**.
8. Click **Add route → Published application** again.
9. Enter subdomain `vspilink-<server-slug>`.
10. Select domain `{base-domain}`.
11. Enter Service URL `http://127.0.0.1:3200`.
12. Click **Save**.

Both hostnames point to the same loopback service on the new computer. Do not
add a path such as `/sse` to either Cloudflare route.

### 3. Save the token without exposing it

The account owner must open a terminal on the new computer and run this block.
The prompt hides the token while it is pasted. Paste only the `eyJ…` token,
not Cloudflare's complete installation command:

```bash
install -d -m 700 "$HOME/.config/pilink/cloudflare"
umask 077
read -rsp "Paste the Cloudflare tunnel token, then press Enter: " VSPILINK_CF_TOKEN
printf '\n'
printf '%s' "$VSPILINK_CF_TOKEN" > "$HOME/.config/pilink/cloudflare/<server-slug>.token"
unset VSPILINK_CF_TOKEN
chmod 600 "$HOME/.config/pilink/cloudflare/<server-slug>.token"
```

Replace `<server-slug>` in the file path before running the block. Do not put
the token in a command argument, repository, prompt, screenshot, `.env` file,
or shell history.

Afterward, check the file without printing it:

```bash
test -s "$HOME/.config/pilink/cloudflare/<server-slug>.token"
stat -c '%a %U %n' "$HOME/.config/pilink/cloudflare/<server-slug>.token"
```

The mode must be `600` and the owner must be the remote user. Delete the
private temporary text used to extract the token and clear the clipboard. In
the VS Code file picker, select the file on the remote host; `$HOME` is a shell
shortcut and must not be typed literally into the picker. Press `Ctrl+L` and
enter the absolute path if hidden files are not shown.

Do **not** run Cloudflare's `sudo cloudflared service install …` command.
VSPiLink creates and owns its own user services; a second Cloudflare service
can cause port, process, and restart conflicts.

### 4. Complete the VSPiLink wizard

On the new computer in VS Code:

1. Press `Ctrl+Shift+P`.
2. Type and select **VSPiLink: Configure MCP Hosting (Advanced)**.
3. Select **Cloudflare Named Tunnel**.
4. Complete the fields exactly:

   | Wizard field | Value |
   | --- | --- |
   | Cloudflare tunnel name | `vspilink-<server-slug>` |
   | Cloudflare DNS zone | `{base-domain}` |
   | MCP server hostname | `mcp-<server-slug>.{base-domain}` |
   | VSPiLink page hostname | `vspilink-<server-slug>.{base-domain}` |
   | Cloudflare credential | **Token file for an existing tunnel** |
   | Token file | `/home/<remote-user>/.config/pilink/cloudflare/<server-slug>.token` |
   | Existing tunnel UUID | The UUID recorded in Cloudflare |
   | Permissions | **Project folder only** |

5. Review the summary and click **Apply and continue**.
6. Wait until VSPiLink reports that the service and public endpoint are ready.

The wizard creates persistent user services for VSPiLink and `cloudflared`.
It may open the ChatGPT connection page after the public health check passes.
If DNS propagation makes the check time out, wait and use **Retry**. Do not
create another tunnel or install another service.

Do not place Cloudflare Access browser login, a JavaScript challenge, a Worker
redirect, or aggressive caching in front of the MCP hostname. Those controls
can interrupt OAuth discovery and the MCP transport.

## Faster owner-only path: Cloudflare account certificate

This is an alternative to the token/dashboard path above; do not combine the
two paths. Use it only on a computer controlled by the Cloudflare account
owner. The account certificate can create tunnels and DNS records across its
authorized zone, so it has much broader power than a per-tunnel token.

1. On the new host, run `cloudflared tunnel login` as the remote user.
2. In the browser page that opens, the account owner signs in, selects the
   correct account, and authorizes `{base-domain}`.
3. Confirm that `~/.cloudflared/cert.pem` exists, is non-empty, and has mode
   `600`. Never print it, paste it into chat, or commit it.
4. Run **VSPiLink: Configure MCP Hosting (Advanced)**.
5. Select **Cloudflare Named Tunnel**.
6. Enter the same unique tunnel and hostname values described above.
7. For **Cloudflare credential**, select **Cloudflare account certificate**.
8. Select `/home/<remote-user>/.cloudflared/cert.pem` on the remote host when
   VS Code asks for it.
9. Select **Project folder only**.
10. Review the Cloudflare changes and click **Apply and continue**.

VSPiLink will create the new tunnel, both DNS records, and its persistent user
services. The existing tunnel and hostnames must remain unchanged.

Prefer a fresh owner-authorized `cloudflared tunnel login` over copying the
broad account certificate from another server. An agent must never transfer
that certificate or include it in this repository.

## Verify the new computer

Run these checks on the new computer. Replace `<server-slug>` and
`{base-domain}` first.

```bash
node --version
systemctl --user is-active vspilink-server.service
systemctl --user is-enabled vspilink-cloudflared.service
systemctl --user is-active vspilink-cloudflared.service
loginctl show-user "$USER" -p Linger
ss -ltn '( sport = :3200 )'
curl --fail --silent --show-error http://127.0.0.1:3200/health
curl --fail --silent --show-error https://mcp-<server-slug>.{base-domain}/health
curl --fail --silent --show-error \
  https://mcp-<server-slug>.{base-domain}/.well-known/oauth-authorization-server
curl --fail --silent --show-error \
  https://mcp-<server-slug>.{base-domain}/.well-known/oauth-protected-resource
curl --silent --show-error --output /dev/null --dump-header - \
  https://mcp-<server-slug>.{base-domain}/sse
```

Expected result:

- Node reports `v24.18.0`.
- The VSPiLink server is `active`; it is intentionally not enabled separately.
- The `vspilink-cloudflared.service` unit is both `enabled` and `active`.
- Port 3200 listens only on `127.0.0.1`, never on `0.0.0.0` or a public IP.
- Local and public health requests succeed.
- Both OAuth discovery URLs return JSON. Their issuer, resource,
  authorization, token, advertised registration, and resource-metadata URLs
  use the new HTTPS origin, and PKCE advertises `S256`.
- In **Cloudflare → Networking → Tunnels**, the new tunnel is **Healthy**.
- The VSPiLink dashboard shows **Cloudflare Named Tunnel**, the new MCP
  endpoint, and a running service.

For an unattended server, `Linger=yes` allows the user service to start before
an interactive login. Changing linger is an administrator decision; the agent
must report `Linger=no` and ask before changing it. No inbound firewall rule or
router port-forward is required. The host must allow outbound Cloudflare
Tunnel traffic, normally TCP or UDP port 7844.

In Cloudflare DNS, verify that the two **new** proxied records belong to the new
tunnel UUID and that the existing records still belong to the old tunnel. A
proxied record may resolve publicly as A/AAAA instead of displaying its CNAME.

`https://mcp-<server-slug>.{base-domain}/sse` is a protocol endpoint, not a normal
web page. Without an access token it should return HTTP `401` and a
`WWW-Authenticate` header whose `resource_metadata` points to the new MCP
hostname. That authentication response is correct. Use the health and OAuth
checks above instead of judging the endpoint as a web page.

## Connect ChatGPT to the new server

Create a separate ChatGPT MCP connection for the new endpoint. Give it a name
that identifies the computer, such as `VSPiLink — aireward`. Do not reuse an
OAuth client or saved connection from `{current-mcp-host}`.

The live ChatGPT interface can change independently of VSPiLink. Follow
[Connect ChatGPT](CONNECT_CHATGPT.md) for the current normal-Chat OAuth and
connection steps. That document is the canonical source for ChatGPT setup.

For the first test, ask ChatGPT to perform a read-only action:

```text
Using VSPiLink — <server-slug>, report the allowed workspace root and show the
Git status. Do not modify files and do not run a shell command.
```

Confirm that the reported path belongs to the new computer and the intended
project before authorizing write tools.

## Completion checklist

- [ ] The new tunnel has a unique name.
- [ ] The new MCP and page hostnames are unique and inside `{base-domain}`.
- [ ] The old tunnel and old DNS records were not changed.
- [ ] The secret is outside the workspace, private, and absent from logs.
- [ ] VSPiLink uses **Project folder only**.
- [ ] The server service is active; the tunnel service is enabled and active.
- [ ] Port 3200 is bound only to IPv4 loopback.
- [ ] Local health, public health, and OAuth discovery succeed.
- [ ] Cloudflare reports the new tunnel as Healthy.
- [ ] ChatGPT has a separate, clearly named connection.
- [ ] A read-only test confirms the correct remote workspace.

## If something fails

| Symptom | What to do |
| --- | --- |
| Hostname already exists | Stop. Choose a new server slug; do not overwrite the record. |
| Tunnel is Healthy but public health fails | Check local health first, then verify both Cloudflare routes use `http://127.0.0.1:3200`. |
| Local health fails | Restart from the VSPiLink dashboard and inspect `journalctl --user -u vspilink-server.service`. |
| Tunnel service fails | Inspect `journalctl --user -u vspilink-cloudflared.service`; never print the token. |
| Node version is not exact | Install the VSPiLink managed runtime or set the remote `vspilink.nodeExecutable` to Node.js 24.18.0. |
| ChatGPT reaches the wrong workspace | Disconnect immediately and verify the endpoint, server slug, tunnel UUID, and workspace permission. |
| `/sse` returns `401` | Correct before login; check that `WWW-Authenticate` names the new host. |
| Cloudflare error 1033 | The new tunnel has no connected connector; start or repair its managed user service. |
| Cloudflare error 502 | Check local health, IPv4 origin, protocol, and port. |
| Unexpected 302 or 403 | Remove an Access login, Worker redirect, WAF challenge, or similar interception from the MCP host. |

See [Troubleshooting](TROUBLESHOOTING.md) for the full Named Tunnel and Remote
SSH checks. Review [Security model](SECURITY_MODEL.md) before granting Full
access or changing secret storage.

## Safe rollback

If this new installation must be removed:

1. Remove the new connection from ChatGPT so it cannot issue more requests.
2. On the new host, expand **VSPiLink → MCP server and advanced settings**.
3. Click **Reset**, confirm **Reset**, then click **Stop and continue**. Type
   `RESET` in the managed terminal if it asks for final confirmation. This
   disables the new tunnel unit and removes that host's generated OAuth state.
4. If the VSPiLink dashboard is unavailable, use this fallback instead:

   ```bash
   systemctl --user disable --now vspilink-cloudflared.service
   systemctl --user stop vspilink-server.service
   ```

5. In Cloudflare, verify the new tunnel name and UUID twice.
6. Remove only the two new published application routes.
7. Delete only the new tunnel if it was created exclusively for this computer.
8. Remove the new token file when it is no longer needed.

Never delete or edit `{current-tunnel}`, `{current-mcp-host}`, or
`{current-page-host}` while following this rollback.

## Authoritative references

- [VSPiLink installation](INSTALLATION.md)
- [VSPiLink ChatGPT connection](CONNECT_CHATGPT.md)
- [VSPiLink security model](SECURITY_MODEL.md)
- [Cloudflare: create a remotely managed tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/)
- [Cloudflare: tunnel tokens](https://developers.cloudflare.com/tunnel/advanced/tunnel-tokens/)
- [Cloudflare: tunnel availability and replicas](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-availability/)
- [Cloudflare: connectivity prechecks](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/troubleshoot-tunnels/connectivity-prechecks/)
