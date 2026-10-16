# MCP servers this bridge connects to (`--mcp-upstreams`)

The bridge can be an MCP **client** of servers you choose, and offer their tools
to the CLI beside the web application's own. Because the bridge holds each tool
definition, it can tell the web application which call has an
[MCP Apps](https://github.com/modelcontextprotocol/ext-apps) view, and relay
the view's requests back to its server (PROTOCOL.md, "MCP Apps").

Only the person running the bridge configures these. A web application cannot
add, change or name one.

```sh
ai-bridge --server wss://... --mcp-upstreams ~/.config/ai-bridge-mcp.json
# or: AI_BRIDGE_MCP_UPSTREAMS=~/.config/ai-bridge-mcp.json
```

A bad file stops the bridge at start with the server and field named; a server
that will not start or connect is logged and retried, never fatal.

## The file

The `mcpServers` shape Claude Code and Claude Desktop use (a bare map of
servers is accepted too):

```json
{
  "mcpServers": {
    "weather": {
      "command": "npx",
      "args": ["-y", "@example/weather-mcp", "--stdio"],
      "env": {
        "WEATHER_UNITS": "metric",
        "WEATHER_API_KEY": { "env": "WEATHER_API_KEY" }
      }
    },
    "github": {
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": {
        "Authorization": { "vault": { "space_id": "4f1c…", "secret_id": "9a2e…" }, "prefix": "Bearer " }
      },
      "timeout_ms": 120000
    }
  }
}
```

| Key | For | Meaning |
|-----|-----|---------|
| name (the key) | both | 1–32 letters, digits, `-`, `_`; no `__`. Tools reach the CLI as `<name>__<tool>`. |
| `command`, `args` | stdio | The program to start and its arguments. |
| `cwd` | stdio | Working directory for it. |
| `env` | stdio | Extra environment. The process gets **only** these plus a safe default set (`HOME`, `PATH`, `USER`, `SHELL`, `TERM`, `LOGNAME`), never the bridge's own environment, which holds its token. |
| `url` | HTTP | A Streamable HTTP endpoint, `http://` or `https://`. No credentials in the URL. |
| `headers` | HTTP | Sent on every request. |
| `auth` | HTTP | `"oauth"` to sign in with OAuth (below). Not together with an `Authorization` header. |
| `oauth` | HTTP | With `"auth": "oauth"`, optional: `scope` (space-separated) and `client_name` (default `AI Bridge`). No other keys. |
| `timeout_ms` | both | Per request (a tool call, a resource read). Default `60000`. |
| `connect_timeout_ms` | both | Starting and initializing. Default `30000`. |

## Secrets

An `env` or `headers` value is either a literal string, for values that are
**not** secret, or a reference saying where the value comes from:

- `{"env": "NAME"}`: the bridge's own environment variable `NAME` (for a
  service, the env file its unit loads). Unset or empty is an error.
- `{"vault": {"space_id": "…", "secret_id": "…"}}`: a sealed value from the
  Engram vault, opened on this machine exactly as for local tools: the bridge
  must run with `--engram`, the device must be approved and handed that space's
  key, and the value is only found through the space that sealed it. Cached and
  refreshed like local tools' values (60 s TTL).
- Either may add `"prefix": "Bearer "`, put in front of the value.

A literal value is **refused at start** for a name that looks like a credential:
headers `Authorization`, `Proxy-Authorization`, `Cookie`, `X-API-Key`, `API-Key`
or any header containing `token`, `secret` or `api-key`; environment names
containing `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `API_KEY`, `PRIVATE_KEY`
or `CREDENTIAL`. So a secret is never plain in the config file.

Resolved values are never logged, and are redacted (`[redacted: <server>.<name>]`)
from everything that leaves the bridge: what the model reads, results and
errors sent to the web application, and the server's stderr in the debug log.
Redaction is hygiene, not containment: a server that deliberately encodes a
value defeats it (see README, "What redaction does and does not do").

## Servers that require OAuth (`"auth": "oauth"`)

An HTTP server that implements the MCP authorization spec (for example a
Laravel app on `laravel/mcp` with Passport and `Mcp::oauthRoutes()`) is used
the way claude.ai uses a custom connector:

```json
{
  "mcpServers": {
    "kaizen": { "url": "https://kaizen.example/mcp", "auth": "oauth" },
    "other": { "url": "https://other.example/mcp", "auth": "oauth",
               "oauth": { "scope": "mcp:use", "client_name": "Acme bridge" } }
  }
}
```

No secret goes in the file. The bridge finds everything else itself: it asks
the server without a token, follows the `WWW-Authenticate` answer to its
protected resource metadata and authorization server, registers itself as a
public client (dynamic client registration, PKCE S256), and asks the web
application to show you a sign-in link.

**What it looks like to you.** The web application has to support it (it says
so by sending a redirect address in its `welcome`; laravel-ai-bridge does). The
first time, and whenever the sign-in has lapsed, the application shows a
"Connect kaizen" notice or card. You click it, sign in to Kaizen in your
browser and approve access; the browser lands back on the application, which
says "Connected — you can close this tab". From then on the server's tools are
offered to the CLI like any other's. You do not need to be at the machine the
bridge runs on: the sign-in goes through the web application, and the
application only passes on a one-time code, which only the bridge can turn into
tokens.

- **Until you sign in** none of that server's tools are offered. If the model
  calls one by an old name, it is told you have been asked to sign in. A link
  is good for 10 minutes and once; asking again makes a new one and the old one
  stops working.
- **Tokens** are kept on the bridge's machine in
  `$AI_BRIDGE_DATA_DIR/mcp-oauth/` (default `~/.ai-bridge/mcp-oauth/`, the
  directory 0700, files 0600): one registration per server URL and redirect
  address, one set of tokens per server URL. They are never logged, never sent
  to the web application, and redacted from anything that goes out.
- **Refreshing** is automatic, a minute before the access token expires or when
  the server answers 401. If the refresh fails, or the server rejects a fresh
  token, you are asked to sign in again.
- **Signing out** happens from the web application ("forget"): the bridge
  deletes the tokens, keeps the registration, and asks again only when you
  click Connect.
- **A web application that does not support it** (no redirect address): the
  server stays waiting for a sign-in (`needs_auth`, `no_redirect_uri` in its
  status) and its tools are not offered.

To start over completely, stop the bridge and delete
`~/.ai-bridge/mcp-oauth/`. The frames: PROTOCOL.md, "Upstream sign-in (OAuth)".

## Visibility

`_meta.ui.visibility` on a tool definition (default `["model", "app"]`):

- without `"model"`: not offered to the CLI, and refused if called by name;
- without `"app"`: refused when a view asks to call it.

A view may only read `ui://` resources of its own server.

## Connection and reconnect behaviour

- All servers connect in parallel when the bridge starts. Their tools join the
  CLI's list as each one comes up; a turn that started earlier sees them from
  its next turn.
- A server that fails to start, connect or resolve a secret is logged with the
  reason and retried in the background: 1 s, then doubling, at most every 60 s.
  A server waiting for an OAuth sign-in is not retried: it connects once the
  sign-in completes.
- When a connection drops (the process exits, the HTTP session is lost, a
  request fails without the server answering), calls in flight fail, its tools
  **stay listed**, and the next use reconnects at once rather than waiting for
  the backoff. An error the server itself answered keeps the connection.
- A slow request times out after `timeout_ms` (`timeout`); the connection is kept.
- `notifications/tools/list_changed` refreshes that server's tools.
- Stopping the bridge stops every stdio server it started.

Upstream tools are offered only when the web application runs the CLI in
`workspace` isolation; an `isolated` CLI never sees them (see docs/isolation.md).
