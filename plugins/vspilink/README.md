# VSPiLink local Codex plugin

This optional repository marketplace plugin connects Codex to a VSPiLink
server listening at `http://127.0.0.1:3200/sse`. It is useful when Codex and
VSPiLink run on the same machine.

This is not the private ChatGPT Work plugin created in the ChatGPT web
interface. ChatGPT Work plugin provisioning remains a per-account or
per-workspace step because its app identifier and OAuth grant belong to that
deployment.

## Install from this checkout

From the repository root:

```bash
codex plugin marketplace add ./.agents/plugins
codex plugin add vspilink@personal
```

Start VSPiLink locally before opening a new Codex thread. The OAuth browser
flow appears on first use.

Installing this package repeatedly does not create separate server instances.
The package remains shared; every remote VSPiLink server publishes its own
non-secret descriptor at `/.well-known/vspilink-instance`. Use the descriptor's
`connection_key`, `display_name`, and `mcp_url` so multiple servers cannot
collapse into one generic entry:

```bash
codex mcp add vspilink-build-vps-a1b2c3d4e5 \
  --url https://your-vspilink-host.example/sse
codex mcp login vspilink-build-vps-a1b2c3d4e5
```

For a remote or custom endpoint, do not edit and redistribute this loopback
template. Create one uniquely named MCP entry per descriptor. OAuth approval
remains separate for every server.

Never place a bearer token, OAuth client secret, tunnel credential, or private
key in this plugin directory.
