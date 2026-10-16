# AI Bridge Protocol v0.1

Specification for the WebSocket protocol between `@tetrixdev/ai-bridge` (npm, client-side) and `tetrixdev/laravel-ai-bridge` (Composer, server-side).

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Modes of Operation](#modes-of-operation)
- [Connection](#connection)
- [Handshake](#handshake)
- [Local Calls](#local-calls)
- [App backends](#app-backends)
- [Subscription Usage](#subscription-usage)
- [AI Requests](#ai-requests)
- [Person uploads](#person-uploads)
- [Handing files back](#handing-files-back)
- [Space files](#space-files)
- [Conversation Continuity](#conversation-continuity)
- [Streaming Events](#streaming-events)
- [Tool Calls](#tool-calls)
- [MCP Apps](#mcp-apps)
- [Upstream sign-in (OAuth)](#upstream-sign-in-oauth)
- [Heartbeat](#heartbeat)
- [Error Handling](#error-handling)
- [Provider Reference](#provider-reference)

---

## Overview

The AI Bridge protocol enables web applications to send AI requests to a user's locally installed CLI tools (Codex, Claude, Gemini) via a persistent WebSocket connection. The bridge runs on the user's machine, receives requests from the server, pipes them through the user's CLI, and streams normalized responses back.

This protocol is **provider-agnostic on the server side** — the Laravel package doesn't care whether the AI response comes from a CLI bridge, a BYOK API key, or a managed endpoint. It normalizes everything into a single streaming format.

## Architecture

```
Browser <──HTTP/SSE──> Laravel App <──WebSocket──> AI Bridge (local)
                        (server)                      │
                                                      ├── codex exec
                                                      ├── claude -p
                                                      └── gemini -p
```

**Direction of connection**: The bridge connects **outward** to the server (not the other way around). This avoids NAT/firewall issues. Once the WebSocket is established, the server can initiate AI requests through it.

**Three participants:**
1. **Browser** — the end user's web interface (talks to server via HTTP/SSE)
2. **Server** — the Laravel app with `laravel-ai-bridge` installed (manages conversations, tools, streaming)
3. **Bridge** — `@tetrixdev/ai-bridge` running locally on the user's machine (talks to CLI tools)

## Modes of Operation

### CLI Bridge
User installs the bridge locally via `npx @tetrixdev/ai-bridge`. The bridge connects to the server via WebSocket using a connection token. AI requests are fulfilled by the user's local CLI tools, using their existing subscriptions.

### BYOK (Bring Your Own Key)
User provides an API key and endpoint URL for any Chat Completions-compatible provider. No local install needed — the server calls the API directly. For MVP, only a single "Custom Chat Completions" option is supported (user sets URL + key). No preset provider configurations.

### Managed
Same as BYOK, but the application provides its own API key. Users pay the app a subscription fee. No separate architecture needed — it's just a different config source for the same BYOK code path.

---

## Connection

### WebSocket Establishment

The bridge connects to the WebSocket address the server hands it. The Laravel
package's dedicated WebSocket server listens on its own port and serves the
connection at the origin root, so the address is an origin rather than a path:

```
wss://{host}:{port}?token={connection_token}
```

The exact value comes from the server (`ai-bridge.server.public_url` when set,
otherwise `ws://{host}:{port}`) and is whatever the operator passes to
`--server`. The token also travels as an `Authorization: Bearer` header; the
query parameter is kept for servers that have not adopted the header.

The `connection_token` is a short-lived JWT obtained by the user through the web application's settings page. It encodes:

```json
{
  "sub": "user_id",
  "exp": 1718400000,
  "scope": "ai-bridge"
}
```

The server validates the token on connection. If invalid or expired, the server closes the WebSocket with code `4001` and reason `"invalid_token"`, and sends a `connection_error` message just before closing. Code `4001` is fatal — the bridge must not reconnect.

CLI bridge tokens also carry a `cid` claim (the bridge connection's database id). On connection the server confirms that connection still exists and its key has not been rotated; a token for a deleted or regenerated bridge is rejected with code `4001` even though its signature is still valid.

### Token lifetime

CLI bridge tokens are long-lived (default 30 days) — a bridge is a semi-permanent connection. Rather than re-mint a token on every request, the server tops it up once it is past half its life. A fresh token is delivered either:

- in the `welcome` message (`refreshed_token` field) — at the handshake, covering bridges that reconnect; or
- in a `token_refresh` message — pushed by a slow background timer, covering a bridge that stays connected without ever reconnecting.

The bridge adopts the new token for subsequent reconnects, so a bridge used at least once per token lifetime never expires.

### Reconnection

The bridge implements exponential backoff reconnection:

| Attempt | Delay    |
|---------|----------|
| 1       | 1s       |
| 2       | 2s       |
| 3       | 4s       |
| 4       | 8s       |
| 5+      | 15s (cap)|

On reconnect, the bridge sends a new `hello` message. The server re-associates the connection with the user. The bridge holds no session state of its own — the server owns the `conversation_id → cli_session_id` mapping (see [Conversation Continuity](#conversation-continuity)), so a bridge restart loses nothing.

---

## Handshake

After WebSocket connection is established, the bridge sends a `hello` message and the server responds with a `welcome`.

### Bridge → Server: `hello`

```json
{
  "type": "hello",
  "version": "0.1",
  "bridge_version": "1.0.0",
  "providers": [
    {
      "name": "codex",
      "available": true,
      "version": "1.2.3",
      "supports_streaming": true,
      "supports_tools": true,
      "supports_thinking": true,
      "supports_session_resume": true
    },
    {
      "name": "claude",
      "available": true,
      "version": "2.0.1",
      "supports_streaming": true,
      "supports_tools": true,
      "supports_thinking": true,
      "supports_session_resume": true
    },
    {
      "name": "gemini",
      "available": false,
      "version": null,
      "supports_streaming": false,
      "supports_tools": true,
      "supports_thinking": false,
      "supports_session_resume": true
    }
  ]
}
```

Each provider entry may include a `models` array listing available models (populated from local CLI cache or known aliases):

```json
{
  "name": "claude",
  "available": true,
  "models": [
    {"id": "sonnet", "name": "Sonnet", "is_default": true},
    {"id": "opus", "name": "Opus", "is_default": false}
  ]
}
```

**Provider detection**: On startup, the bridge probes for each CLI:
- `codex --version` → Codex availability
- `claude --version` → Claude availability
- `gemini --version` → Gemini availability

If a CLI is not installed, `available` is `false` and the server won't route requests to it.

**`supports_tools`** indicates whether the provider can invoke server-defined bridge tools. All three currently supported providers (Codex, Claude, Gemini) report `true`. Even CLIs without native tool calling can use bridge tools: the bridge injects them as Bash wrapper scripts on the CLI's `PATH` that route calls back through the WebSocket. For Codex this additionally requires running `codex exec` with a workspace-write sandbox and network access so the wrapper scripts' loopback callback succeeds — the bridge handles this automatically. Per-provider capability values are reported dynamically in the `hello` handshake; this spec documents the format, not fixed values. See [Tool Calls](#tool-calls).

**`supports_session_resume`** indicates whether the provider supports resuming conversations by session ID. All three currently supported providers support this.

#### Additive field: `workspaces`

A bridge started with `--allow-dir` also advertises the directories it will accept in `ai_request.working_dir`:

```json
{
  "type": "hello",
  "version": "0.1",
  "bridge_version": "0.2.0",
  "providers": [ "..." ],
  "workspaces": [
    { "path": "/Users/jasper/zp-studio/zeroplex-studio/ZeroPlex_Studio__D09042", "label": "Studio D09042" }
  ]
}
```

| Field | Meaning |
|---|---|
| `path` | Absolute, symlink-resolved root. Any directory at or below it may be named. |
| `label` | Human-readable name for a picker. Defaults to the directory's basename; the operator sets it with `--allow-dir <path>=<label>`. |

This is what makes the feature usable: the server shows a picker of the checkouts the developer allowed, and nobody types an absolute path into a chat box.

The field is **omitted entirely** when the operator allowed nothing, so "this bridge has no workspaces" and "this bridge predates workspaces" look the same to the server — correctly, because in both cases naming a directory is refused. An older server ignores the field.

#### Additive field: `attachment_limits`

The caps this bridge will enforce on [`attachments`](#additive-field-attachments), so a server can refuse or warn in the composer — with the real number — before anybody waits for an upload, instead of mirroring the bridge's configuration in its own and keeping the two in step by hand:

```json
{
  "type": "hello",
  "version": "0.1",
  "bridge_version": "0.10.0",
  "providers": [ "..." ],
  "attachment_limits": {
    "max_file_bytes": 26214400,
    "max_total_bytes": 104857600,
    "max_count": 50
  }
}
```

| Field | Meaning |
|---|---|
| `max_file_bytes` | Largest single attachment, in bytes (`--attachment-max-mb`, default 25 MB) |
| `max_total_bytes` | Largest total across one `ai_request`, in bytes (`--attachment-total-mb`, default 100 MB) |
| `max_count` | Most attachments one `ai_request` may carry (`--attachment-max-count`, default 50) |

Bytes rather than megabytes, so neither side rounds. A turn over any of them is refused with `attachment_too_large` exactly as before; the field only lets the server know in advance. A bridge that predates the field omits it, and the server should then assume nothing — in particular not today's defaults, which an operator may have changed. An older server ignores it.

#### Additive field: `file_uploads`

```json
{ "type": "hello", "...": "...", "file_uploads": true }
```

This bridge understands [`upload_offer`](#person-uploads): a file a person picked in the server's chat, streamed through the server into `<working folder>/file-uploads/` on this machine and not kept by the server. Advertised whatever the allow-list says — whether the machine has a folder at all is `workspaces`, and a bridge with none refuses every offer with `upload_refused`.

A bridge that predates it omits the field. A server that no longer stores uploads itself **must refuse** the upload for such a bridge, saying the bridge needs updating, rather than quietly falling back to holding the file. An older server ignores the field.

#### Additive field: `file_downloads`

```json
{ "type": "hello", "...": "...", "file_downloads": true }
```

This bridge answers [`file_read`](#handing-files-back): it hands back a file it recorded itself, by the id it minted, and it refuses the older path-based `attachment_read`. A bridge without it cannot be asked for a file at all; a server says so ("update the bridge") rather than falling back to asking by path.

#### Additive field: `app_backends`

```json
{ "type": "hello", "...": "...", "app_backends": true }
```

This bridge understands [`app_call`](#app-backends). Sent whatever `--local-tools` says, like the flags above: it says the frame is understood, and a bridge that did not opt in answers every `app_call` with a refusal. A server must not send `app_call` to a bridge that did not advertise it; it would be logged as an unknown frame and never answered.

#### Additive field: `self_update`

```json
{ "type": "hello", "...": "...", "self_update": true }
```

`true` when this bridge will follow [`welcome.desired_bridge_version`](#desired_bridge_version) by itself: it runs as a systemd service that restarts it, whose unit starts `@tetrixdev/ai-bridge@${AI_BRIDGE_VERSION}`, and it is not opted out. `false` from a bridge that understands the field and will not follow it (a terminal, an unpinned unit, macOS or Windows, `--no-self-update`). Absent from a bridge older than 0.24.0. Either way, a machine without `true` needs updating by hand once.

#### Additive field: `mcp_apps`

```json
{ "type": "hello", "...": "...", "mcp_apps": { "spec": "2026-01-26", "revision": 1 } }
```

This bridge implements [MCP Apps](#mcp-apps): `spec` is the ext-apps revision, `revision` the revision of the bridge's own MCP Apps frames. Absent from a bridge that predates them; a server then tells the person to update it and must not send `mcp_request`.

#### Additive field: `mcp_upstream_auth`

```json
{ "type": "hello", "...": "...", "mcp_upstream_auth": { "revision": 1 } }
```

This bridge implements [upstream sign-in (OAuth)](#upstream-sign-in-oauth). Absent from a bridge that predates it; a server must not send it `upstream_auth_start`, `upstream_auth_code` or `upstream_auth_forget`.

#### Additive field: `space_files`

```json
{ "type": "hello", "...": "...", "space_files": 1 }
```

This bridge keeps a server's [space files](#space-files) (`files_write`, `files_read`, `files_move`, `files_purge`); the number is the revision of those frames. Advertised whatever the allow-list says; a bridge with no allowed folder refuses each with `files_no_folder`. Absent from a bridge that predates it: a server tells the person to update it and sends none of the frames.

#### Additive field: `app_network`

```json
{ "type": "hello", "...": "...", "app_network": 1 }
```

This bridge holds every app backend to the hosts its manifest declares, plus Engram's own API, and honours `backend.public_images` ([The network fence](#the-network-fence-0290)); the number is the fence's revision. Absent from a bridge that predates it (before 0.29.0), where `backend.network` is shown to the person but not enforced: a server says so rather than claiming it is held.

#### Additive field: `input_closed`

```json
{ "type": "hello", "...": "...", "turn_input": true, "input_closed": true }
```

This bridge sends the [`input_closed`](#input_closed) stream event when a turn with its input open stops taking messages. A bridge without it still closes the input by the terminal rule but says nothing — and it may close it too early, before the CLI has read the opening message (see the terminal rule under [`accepts_input`](#additive-option-accepts_input--a-turn-that-takes-messages-while-it-runs)). A server can then learn of the close only from a `turn_input` answered `turn_ending`, or from the terminal frame. An older server ignores the field and the event.

#### Additive field: `effort_levels`

```json
{ "type": "hello", "...": "...", "effort_levels": ["low", "medium", "high", "xhigh", "max"] }
```

Since ai-bridge 0.32.0. The values this bridge takes for [`options.effort`](#additive-option-effort--the-claude-thinking-level), the Claude thinking level. Sent whichever providers are detected; Codex and Gemini ignore the option. Absent from a bridge that predates it, which drops the option and runs every turn at the CLI's default: a server that lets a person pick a level says it was not applied rather than implying it was.

### Bridge → Server: `providers_update`

Sent mid-connection when the bridge's set of available provider CLIs changes after the `hello` — for example, the user installs or removes a CLI while the bridge stays connected.

```json
{
  "type": "providers_update",
  "providers": [
    { "name": "claude", "version": "1.2.3", "available": true, "supports_streaming": true, "supports_tools": true, "supports_thinking": true, "supports_session_resume": true }
  ]
}
```

**`providers`**: The currently available providers, in the same shape as the `hello` `providers` array, but containing only providers whose CLI is present (`available: true`).

The server refreshes the connection's advertised providers from this message, so the host application's provider list reflects what the bridge can currently run. No response is sent.

The bridge re-probes its CLIs after every handshake and after a provider spawn failure (a request routed to a since-removed CLI), and emits this message only when the available set actually changed.

### Bridge → Server: `posture`

Sent once per handshake, immediately after the bridge adopts a CLI isolation posture — so after `welcome`, necessarily: at `hello` time it has not been told what to adopt.

```json
{
  "type": "posture",
  "cli_isolation": "isolated",
  "requested": "native",
  "reason": "requires_allow_native",
  "message": "Server asked for `native` isolation, which hands this machine's full CLI environment … Pass --allow-native if the server is one you would give a shell to."
}
```

| Field | Meaning |
|---|---|
| `cli_isolation` | The posture actually in force. |
| `requested` | What the server asked for, or `null` if it asked for nothing. |
| `reason` | Present **only** when the two differ: `not_requested`, `unrecognised`, `requires_allow_dir`, `requires_allow_native`. |
| `message` | A sentence naming the operator action that would change it. |

The server asks for a posture; the bridge may decline it, because `workspace` and `native` are gated on flags the bridge's operator passes. That refusal is correct and a server cannot override it — the gate exists precisely so a server cannot. What this frame adds is that the server can **show** it.

Without it the refusal is visible only in a log on the operator's own machine, and the failure that produces is nasty in a specific way: an operator who forgot `--allow-native` gets a connection that looks perfectly healthy in every screen, while the assistant silently has no tools at all, and nothing anywhere explains why.

Sent whether or not the posture matches the request, so a server always knows what is in force. **Absence of the frame means an older bridge, not agreement.** Additive and optional: a server that ignores it loses nothing.

### Server → Bridge: `welcome`

```json
{
  "type": "welcome",
  "session_id": "ws_abc123",
  "tools": [
    {
      "name": "roll_dice",
      "description": "Roll dice using standard D&D notation",
      "parameters": {
        "type": "object",
        "properties": {
          "notation": {
            "type": "string",
            "description": "Dice notation, e.g. '2d6+3', '1d20'"
          }
        },
        "required": ["notation"]
      }
    },
    {
      "name": "lookup_rule",
      "description": "Look up a D&D 5e rule by keyword",
      "parameters": {
        "type": "object",
        "properties": {
          "query": {
            "type": "string",
            "description": "The rule or mechanic to look up"
          }
        },
        "required": ["query"]
      }
    }
  ],
  "config": {
    "heartbeat_interval": 30,
    "request_timeout": 86400,
    "silence_timeout": 900
  },
  "refreshed_token": "<new JWT>"
}
```

#### `cli_isolation`

How much of the operator's local environment the spawned CLI may see, and what it may do. Sent on `welcome`; **absent means `isolated`**, so an older server gets the safe default rather than the legacy behaviour.

| Value | The CLI may... | The operator's environment... |
|---|---|---|
| `isolated` (default) | reach server-declared tools through the bridge's MCP server. No edits. Per-CLI — see the flag table below: Claude's built-ins are denied outright, Codex keeps its own `shell` bounded by a read-only, no-network sandbox, and Gemini's built-ins stall on an approval nothing can answer. The bridge states this posture explicitly on Claude and Codex, so the operator's own CLI configuration cannot widen it; Gemini offers no such lever. | stays out: other MCP servers ignored. The system prompt is the server's, or the CLI's own default when the server sends none. |
| `workspace` | **also use its own file and shell tools**, inside `working_dir`. | stays out, exactly as in `isolated`. |
| `native` | do anything the CLI can do. | is fully in play: user `CLAUDE.md`, skills, hooks, configured MCP servers, plugins, the CLI's own default prompt. |

`workspace` exists because neither of the other two fits a chat that is supposed to do the work: `isolated` blocks the edit and shell tools that *are* the capability, and `native` switches off far more than that. It is the middle setting — work in the named directory, keep the operator's own environment out — and it maps to these flags:

| CLI | `isolated` | `workspace` |
|---|---|---|
| Claude | `--strict-mcp-config`, `--allowedTools mcp__bridge__*`, `--permission-mode manual`. The permission mode is what makes the tool restriction real: `--allowedTools` only asks, and the denial comes from Claude's own permission system, which reads the operator's `~/.claude/settings.json`. Without it, a `defaultMode: "auto"` there turns `isolated` into "everything allowed". | Keeps `--strict-mcp-config`; drops the `--allowedTools` restriction; adds `--permission-mode bypassPermissions`. In headless `-p` mode `acceptEdits` would still stall on the first shell command — and running the tests *is* a shell command — so `bypassPermissions` is what actually runs a real task. The permission mode contains nothing; saying otherwise would be misleading. |
| Codex | MCP only, plus `-c sandbox_mode=read-only` stated explicitly rather than left to the operator's `~/.codex/config.toml` default | `-c sandbox_mode=workspace-write` — explicitly **not** `danger-full-access`, which is what `native` uses — plus `-c approval_policy=never`, because `codex exec` is headless and anything that asks for approval waits for an answer that can never arrive. `--cd` is passed as well when the installed codex supports it. |
| Gemini | no `--yolo`, so built-ins stall on approval | `--yolo`. It is the only lever Gemini offers: there is no middle setting, so `workspace` on Gemini is materially broader than on Codex. |

`--skip-git-repo-check` on Codex exists because the pinned scratch cwd is not a repository. Inside a real checkout it is a no-op; it is left in place because it is still correct for the scratch case.

See [`docs/isolation.md`](docs/isolation.md) in the bridge repository for how each posture is enforced, what `isolated` does not stop, and how to verify it on a given machine.

**Both permissive postures are refused unless the operator opted in.** `workspace` requires `--allow-dir`; `native` requires `--allow-native`. A bridge started without them runs `isolated` instead and logs why.

This is not a formality. `workspace` is what enables the shell, and a shell in the empty scratch directory is still a shell — so if the allow-list bounded only the working directory, a server could switch the capability on by sending this field. And gating `workspace` alone would have been theatre, because `native` is strictly broader: a server refused the shell one way would ask for it the other way and get the operator's own MCP servers, hooks and plugins as well. Same rule as `--local-tools`, in all three cases.

An unrecognised value — a typo, a newer server — is also treated as `isolated` rather than passed to the adapters, which test it with `!== 'isolated'` and would otherwise land in the permissive branch on one CLI and the restrictive branch on another.

The system prompt behaves the same in every mode: the server's `system_prompt` when there is one, and otherwise nothing, so the CLI keeps its own default prompt. The bridge writes no system prompt of its own; its lifecycle addendum (`bridge_prompt`) rides beside whichever prompt applies. Earlier bridges substituted a one-sentence neutral stand-in in `isolated` and `workspace`; a server that relied on it should send its own `system_prompt`.

`bridge__attach_file` is offered in `workspace` and `native` only. In `isolated` the CLI reaches server-declared tools and nothing else, which is what the row above says and what it should keep meaning.

**Gemini and `working_dir`.** Gemini is the one CLI with no per-invocation MCP config flag — it reads `.gemini/settings.json` from cwd. When cwd is a developer's checkout the bridge therefore writes into it, and handles that explicitly: it **refuses the turn rather than overwriting** a settings file the repository already has, removes the one it wrote when the turn ends (`done`, `error` or `cancel`), and removes the `.gemini` directory too if it created it and nothing else is in it. Because there is only one such path per directory and the file carries a per-spawn bearer token, **two concurrent Gemini turns in one directory are refused** rather than allowed to race — the loser would otherwise read the winner's credential and have its tool calls routed to the other turn's request.

#### `upstream_oauth`

```json
{ "type": "welcome", "...": "...", "upstream_oauth": { "redirect_uri": "https://app.example/ai-bridge/upstream-oauth/callback" } }
```

Where the authorization server sends the browser back after a person signs in to an OAuth upstream MCP server. See [Upstream sign-in (OAuth)](#upstream-sign-in-oauth). Absent: OAuth upstreams on this bridge cannot be signed in to through this server.

#### `desired_bridge_version`

```json
{ "type": "welcome", "...": "...", "desired_bridge_version": "0.24.1" }
```

The bridge version this server wants every machine on, exactly: higher or lower than what runs, the server decides. Additive and optional; absent means no opinion, and a bridge that predates it ignores it like any unknown field. It is read on every welcome, so changing it and restarting the server process (which every deploy does) reaches each bridge as it reconnects; nothing needs pushing to a connected one.

**Only a strict semver string** — `MAJOR.MINOR.PATCH`, optionally `-prerelease`; no `v`, no build metadata, no range, tag, URL or command. The package is fixed by the bridge, so the most a server can pick is one published release of `@tetrixdev/ai-bridge`. Anything else is ignored with a warning. A version below **0.24.0**, the first that updates itself, is refused too: it would leave the machine on a release that never follows again.

What a bridge with `self_update: true` does when the value differs from its own version:

1. Fetches it into the npx cache and runs it once with `--version` (`npx -y --prefer-online --ignore-scripts @tetrixdev/ai-bridge@<v> --version`). If that fails it keeps running as it is and tries again later: 5 minutes, doubling, at most 6 hours. Fetches on one machine take turns (a lock in `~/.cache/ai-bridge/`): two npx installs of one version at once can leave half a package in npx's shared cache, which fails every later run of that version. A cache directory of the target version that fails with a missing module is removed and fetched once more (0.24.1).
2. Waits until nothing is in progress: no turn (sub-agents run inside one), no turn still stopping, no upload, no file read or transfer, no app call. Work is never cut off.
3. Writes `AI_BRIDGE_VERSION=<v>` (and `AI_BRIDGE_PREVIOUS_VERSION=<old>`) into its unit's env file, disconnects with a normal close, and exits with code 75. systemd starts the unit again, now on `<v>`, which reconnects and says hello as usual.

If it comes back still on the old version, the pin did not take; the next attempt at that version waits 5 minutes, doubling, at most a day, rather than restarting in a loop. A bridge that cannot follow (`self_update` false or absent) logs that the server wants another version and carries on.

What this does not cover: a new version that crashes before it reaches this code. The old one has gone by then; the `--version` run in step 1 is what keeps that rare.

#### Local tools (optional)

A tool may carry fields that move execution from the server to the bridge:

```json
{
  "name": "fetch_mail",
  "description": "Fetch mail since a date",
  "parameters": { "type": "object", "properties": {} },
  "execute": "local",
  "space_id": "1f2c...",
  "needs": [{ "role": "mailbox", "kind": "azure_app",
              "fields": ["tenant_id", "client_id", "client_secret"] }],
  "fill": [{ "role": "mailbox", "item_id": "5d0e...", "space_id": "77aa...",
             "kind": "azure_app",
             "fields": { "tenant_id": "4f1c...", "client_id": "9a2e..." },
             "sealed": [{ "field": "client_secret", "secret_id": "9ab3...",
                          "space_id": "77aa..." }] }],
  "package": "@scope/fetch-mail@1.2.3",
  "network": false,
  "run": { "command": "node", "args": ["index.js"] }
}
```

`execute` absent means `"server"`, so a server that never sends the field is
unaffected. `"local"` means the bridge runs the command on the operator's
machine and **never emits a `tool_call` frame** for it, which is the point once
the arguments include a decrypted secret: the plaintext must not reach the
network.

**A server cannot enable this.** The bridge honours `"local"` only when its
operator started it with `--local-tools`. Otherwise the tool is refused and the
refusal logged. This is deliberate: a local tool lets a server run commands on
someone else's machine, as them, and that has to be chosen rather than sent.

**`space_id`** is the tool's own space, where its package is installed.

**`needs`** declares what the tool wants by ROLE: the label of the vault item
that fits (`kind`, naming the service) and the `fields` it reads. **`fill`** is
the item the server resolved for each role, after a person chose it for this
exact tool: its plain fields as values, and each sealed field as the id of the
sealed value and the **space it is sealed in**, never a value. That space may
differ from the tool's: a tool in a shared space may run with an item from the
person's private space.

The bridge opens each sealed value only through the space the fill names for
it, and only if the value it holds under that id is that field of that item. A
value named through another space, or under another item or field, is refused
exactly as one this device does not hold, and the call fails rather than running
without it. Whether the person may use that item with that tool is the server's
decision (Engram records a consent against a hash of the tool's definition);
the bridge trusts the server for it the same way it trusts the server for the
tool's command, which is what signing tools will change.

**Environment: `ENGRAM_<ROLE>_<FIELD>`, for plain and sealed fields alike**,
upper-cased, `-` becoming `_`: the role `mailbox` and the field `client_secret`
arrive as `ENGRAM_MAILBOX_CLIENT_SECRET`. A tool reads every field of its item
the same way and never learns which were sealed, nor what the item is called, so
one `fetch_mail` serves three Azure app registrations. Sealed values are scrubbed
from everything the tool prints; plain ones are not, because plain means not
secret. Two role/field pairs that would become the same variable, or one that
would replace a variable the bridge sets itself (`ENGRAM_PACKAGE_DIR`), fail the
call rather than one silently overwriting the other.

The older `secrets` field (credential names resolved within `space_id`) and the
`{role, secret_id}` fill are retired: Engram no longer names sealed values, and
a sealed value belongs to an item.

**`package`** names an npm package, pinned exactly (`@scope/name@1.2.3`).
Installed with `--ignore-scripts`, into a directory of its own per space. A
range, a dist-tag, a `file:` spec or a git URL is refused.

**`network`** says what the tool needs from the network. `false` means none, and
on Linux the bridge enforces it with `unshare -rn`. A host list is **not**
enforced (per-host filtering is not implemented) and is reported as such.

`run.command` is executed with an argv array and no shell; the model's arguments
arrive as `ENGRAM_ARG_*` environment variables rather than on a command line, so
a value containing shell metacharacters is a string a program received, not
something the system interpreted. Two argument names that would become the same
variable (`a-b` and `a.b`) fail the call rather than one overwriting the other.

**`tools`**: Dynamic tool definitions sent from the server. These are the tools the AI can call during a conversation. The bridge injects these into the CLI's context (see [Tool Calls](#tool-calls)).

**`config.heartbeat_interval`**: Seconds between heartbeat pings, clamped to 5–300. A missing or non-numeric value uses 30 rather than failing open — `setInterval` given `NaN` fires about every millisecond. See [Heartbeat](#heartbeat).

**`config.request_timeout`**: A wall-clock ceiling for a single AI request, in seconds. Accepted range 10–86400; `0` means the server bounds the turn itself and wants no ceiling here. Default 86400. A numeric string such as `"300"` is accepted; a value that is not a number at all is ignored and the default kept, rather than clamped to the 10-second floor.

**`config.silence_timeout`**: How many seconds a turn may produce **nothing** before the CLI is presumed wedged and killed. Accepted range 10–86400; `0` disables it. Default 900. Optional — a bridge that has never heard of it keeps behaving as it did, and a server that omits it gets the default.

It also sets how long the bridge waits for the server to answer a [`tool_call`](#tool-resolution-flow-cli-bridge): 90% of whichever of `silence_timeout` and `request_timeout` would end the turn first, never more than an hour — and, for the wall clock, 90% of the time *left* in the turn when the call is made, since that clock started with the turn rather than with the call. A CLI blocked on an unanswered tool call emits nothing, so the silence clock is what ends that wait either way; stopping just short of it means the CLI gets a tool error it can report and continue from, rather than the whole turn being killed to report one failed tool.

**Silence is the bound that kills, and that is the point.** A wall clock cannot tell a stuck CLI from a busy one: an assistant reading a codebase, waiting on a build or running a test suite produces nothing *of interest* for minutes at a time and is working throughout, while a turn streaming tool results continuously for five minutes is in the healthiest state a long turn has.

**A long-running tool does count as silence**, so the bound must exceed the longest tool you expect. Measured against Claude Code 2.1.x: a `sleep 20` produced a **17-second gap** between CLI output lines, and the bridge emits nothing it is not given. An ordinary turn — shell commands, a written answer — went quiet for at most 4–5 seconds. So 900 covers normal work with two orders of magnitude to spare and still catches a wedged CLI, but a build that takes longer than the bound will be stopped; raise it, or set it to `0` and bound the turn on the server side. The old 300-second request timeout killed exactly that turn, punctually, mid-work — and punctuality is the tell, because a crash is never that precise. The silence clock resets on **every** frame the adapter emits: delta, tool call, tool result. `request_timeout` remains as a backstop for a server that wants a hard ceiling.

When either bound fires, the bridge sends `error` with code **`silence_timeout_exceeded`** or **`request_timeout_exceeded`** and a `limit_seconds` field, then `done`. It does not surface the signal: `exited with code 143` is true, describes the mechanism rather than the decision, and leaves a consumer unable to say "stopped after 15 minutes".

**`refreshed_token`** *(optional)*: Present when the server topped up an aging connection token at the handshake. The bridge replaces its current token with this value for future reconnects. See [Token lifetime](#token-lifetime).

### Server → Bridge: `token_refresh`

Sent at any time after the handshake to hand the bridge a fresh connection token — used for a long-lived bridge that stays connected without reconnecting, so it never picks up a `refreshed_token` via `welcome`.

```json
{
  "type": "token_refresh",
  "token": "<new JWT>"
}
```

The bridge replaces its current token with this value and uses it for subsequent reconnects. It does **not** reconnect in response to this message.

---

## Local Calls

> **Bridge-side only.** These frames are implemented in `@tetrixdev/ai-bridge`;
> `tetrixdev/laravel-ai-bridge` does not send or understand them, and a bridge
> that emits a `local_result` at it has the message logged as an unknown type
> and dropped. They are documented here because both packages share this file
> and a reader should know the protocol is this size — not because the Laravel
> server implements this half.

A `local_call` is the server asking the bridge to run one tool on the operator's
machine, directly. Unlike a `welcome`-registered local tool it is not something
a model decided to call: it is a panel, a job or a button invoking a tool a
person configured.

It goes through the **same gate**. A bridge started without `--local-tools`
refuses every `local_call` outright and answers with `ok: false`. There is one
way in, not one per message type.

### Server → Bridge: `local_call`

```json
{
  "type": "local_call",
  "id": "<uuid>",
  "space_id": "<uuid>",
  "tool": {
    "name": "fetch_mail",
    "command": "node",
    "args": ["/abs/path/index.js"],
    "package": "@scope/name@1.2.3",
    "network": false
  },
  "fill": [{ "role": "mailbox", "item_id": "<uuid>", "space_id": "<uuid>",
             "kind": "azure_app", "fields": { "client_id": "9a2e..." },
             "sealed": [{ "field": "client_secret", "secret_id": "<uuid>",
                          "space_id": "<uuid>" }] }],
  "input": { "since": "2026-08-01" }
}
```

- **`space_id`** is the tool's space: where its package is installed and what
  the per-space limiter counts against.
- **`fill`** is the same shape as a local tool's (above): plain fields as
  values, each sealed field as (`secret_id`, `space_id`) with the space it is
  sealed in. Each sealed value must be held by this device under that space, as
  that field of that item, or the call is refused. The bridge does not turn a
  name into an id.
- **`input`** is passed to the tool as **one JSON document on stdin**. It is not
  flattened into environment variables.
- **`tool.package`**, when present, is installed before the run (pinned exactly,
  `--ignore-scripts`, one directory per space) and the tool runs with the
  package directory as its working directory. `ENGRAM_PACKAGE_DIR` points at it.
- **`tool.network`**: `false` means the tool runs with no network. A host list is
  not enforced. See the sandbox section below.

Each field reaches the tool as `ENGRAM_<ROLE>_<FIELD>`, upper-cased, with `-`
replaced by `_`. The tool reads the role and field it declared and never an
item's name.

#### Where a device's sealed values come from

The bridge fetches `/devices/:id/keys` (each space key wrapped to this device,
with the granter's signing key beside it) and `/devices/:id/secrets` (each
filled sealed value as `{id, space_id, item_id, field, envelope}`). A space key
is opened only if the wrap is bound to this device and that space (the context
in both HKDF and the AES-GCM additional data, as Engram's `public/vault.js`
makes it) and carries a signature that verifies against the granter key; an
envelope is opened with its space's key and the vault's size padding stripped.
Engram's `tests/bridgecrypto.test.ts` runs this bridge's code against the real
vault page, so the two cannot drift apart silently.

### Bridge → Server: `local_result`

```json
{ "type": "local_result", "id": "<uuid>", "ok": true, "result": { } }
```

```json
{ "type": "local_result", "id": "<uuid>", "ok": false, "error": "text" }
```

The bridge always answers, for every `local_call` carrying an id, including one
it refuses before running anything. A server waiting forever on an id it will
never hear about again is the one outcome with no diagnosis.

**`result` is the tool's stdout, parsed.** A tool's stdout must be exactly one
JSON document. Credential values are scrubbed out of it **before** it is parsed,
so a credential cannot survive inside a JSON string. Stdout that is not one JSON
document (a log line, a stack trace, two documents) produces `ok: false` and the
text is **not** passed through: raw text arriving where a result belongs reads
to a model exactly like a tool that worked. Anything a tool prints for a human
belongs on stderr.

**`error`** is a sentence, already scrubbed of every credential the call
resolved. A non-zero exit, a timeout, a refused space, a rate limit and a parse
failure all arrive this way.

### Additive field: `sandbox`

A `local_result` may carry a `sandbox` object. A server that ignores it loses
nothing.

```json
{
  "type": "local_result", "id": "<uuid>", "ok": true, "result": { },
  "sandbox": {
    "filesystem": "node-permissions",
    "network": "open",
    "notes": ["per-host network filtering is not implemented, so the declared hosts (graph.microsoft.com) are NOT enforced and the tool has the whole network"]
  }
}
```

It reports what the bridge actually enforced, which is not always what the tool
asked for:

- **`filesystem`**: `node-permissions` when Node's permission model applied
  (only when the command is `node`), otherwise `none`.
- **`network`**: `namespace` when the tool ran with no network at all,
  otherwise `open`.
- **`notes`**: plain sentences naming everything that was **not** covered.

`unshare` is Linux only and `--permission` is Node only, so a non-Node command
on a non-Linux machine gets **no sandbox at all**. That case is reported here
rather than implied away.

### Rate limits

Per space: at most **2** local calls in flight, and starts spaced at least
**250ms** apart. A third concurrent call for the same space is refused with
`ok: false` rather than queued, because a queue is the same fork bomb with a
delay. A caller that sees this is usually re-rendering or retrying in a loop.

---

## App backends

An Engram app may have a backend: code in the app's versioned files, run on the machine of the person using the app, as a long-running process this bridge supervises (Engram `docs/22-apps`). Behind the same gate as local tools: without `--local-tools` every `app_call` is refused. Whether the person approved this version, and whether the endpoint is one the app declares, is the server's to check before it sends the frame.

### Server → Bridge: `app_call`

```json
{
  "type": "app_call",
  "id": "4c0e…",
  "app": { "space_id": "…", "name": "todo", "version": 4, "hash": "<sha256 of the version>" },
  "files": { "base": "https://engram.example/app-blobs/<token>/", "tree": { "server.js": "<sha256>", "engram.json": "<sha256>" } },
  "backend": { "main": "server.js", "folders": [{ "path": "~/Documents/x", "write": false }], "shell": false, "programs": [], "network": false },
  "fill": [ { "role": "mailbox", "item_id": "…", "space_id": "…", "fields": { "tenant_id": "…" }, "sealed": [{ "field": "client_secret", "secret_id": "…", "space_id": "…" }] } ],
  "use": [ { "role": "mailbox", "item_id": "…", "space_id": "…", "fields": { "tenant_id": "…" }, "sealed": [{ "field": "client_secret", "secret_id": "…", "space_id": "…" }] } ],
  "request": { "method": "POST", "path": "/todos", "headers": { "content-type": "application/json" }, "body": "{\"label\":\"milk\"}" },
  "engram": { "api": "https://engram.example/app-api", "token": "<5-minute token for this request>" }
}
```

What the bridge does with it (`src/apps/supervisor.ts`):

1. **Working copy.** Keyed on `app.hash`. Each file is fetched as `files.base + sha256`, checked against that hash, and cached by hash under `<local data dir>/apps/blobs/`, so a file unchanged across versions is fetched once. The copy is built beside its final folder and renamed into place. `files.base` and `engram.api` must be on the origin of the server this bridge is connected to (or `--api`), https unless loopback; a path in `tree` is plain segments, never `..`.
2. **The process.** One per app version on this machine: `node --permission --allow-fs-read=<copy> --allow-fs-read=<fence> --require <fence> [--allow-net on a Node that has it] [--allow-fs-read=<folder>] [--allow-fs-write=<folder with write>] [--allow-child-process when shell or programs] <copy>/<main>`, cwd the copy. Its environment is the same short allowlist local tools get (never the bridge's tokens, never a proxy variable), the vault roles as `ENGRAM_<ROLE>_<FIELD>` exactly as for [`local_call`](#local-calls), and `ENGRAM_APP_DIR`, `ENGRAM_APP_NAME`, `ENGRAM_APP_VERSION` (and `ENGRAM_IMAGE_FETCH` with `public_images`). A different item chosen for a role, or a different host list, restarts the process. The network is held to `backend.network`, see [The network fence](#the-network-fence-0290).
3. **Lifetime.** Started by the first request, kept while used, stopped after 10 minutes with no request, stopped with the bridge. A crash fails the requests in flight with the exit status and the tail of its stderr; the next request starts a fresh process. Three crashes within a minute refuse starts for 30 seconds.
4. **The request.** One JSON line on the process's stdin: `{ "id", "method", "path", "headers", "body", "engram": { "api", "token" }, "vault"? }`. The process answers with one JSON line on stdout: `{ "id", "status", "headers", "body" }` (body a string, at most 256 KB). Requests may overlap; ids match them. A stdout line that is not a response is ignored (logs belong on stderr). No answer in 55 seconds fails the request, not the process.

5. **Another linked item, for one request** (`use`, 0.22.0, advertised as `hello.app_items`). `fill` is each role's DEFAULT item, the person's link, and it is what the process's environment holds. A role that accepts several items ("many" in the app's manifest) may have a request name another of the person's linked items; the server then sends it as `use`, in `fill`'s shape, for roles `fill` already fills. The bridge opens it exactly as it opens `fill` (same space and item checks) and hands the result to the backend on THAT request's line only, as `"vault": { "ENGRAM_<ROLE>_<FIELD>": "value", … }`, the same names the environment uses, so a backend reads `{ ...process.env, ...req.vault }`. It never enters the environment, so the process is not restarted and no other request sees it, and its sealed values are scrubbed from that answer as the fill's are. A `use` role that `fill` does not fill is refused. A server must not send `use` to a bridge that did not advertise `app_items`: an older one would ignore it and answer with the default.

JSON lines over a pipe rather than a local port or socket, because nothing listens: a localhost port is reachable by every program and user on the machine, and by web pages through DNS rebinding, so it would need an authentication story of its own; a pipe belongs to the one process that was handed it.

### Bridge → Server: `app_result`

```json
{ "type": "app_result", "id": "4c0e…", "ok": true, "response": { "status": 200, "headers": { "content-type": "application/json" }, "body": "[…]" } }
{ "type": "app_result", "id": "4c0e…", "ok": false, "error": "the backend of \"todo\" stopped before answering: it exited 3. …" }
```

Exactly one per `app_call`, whatever happens. Every sealed value the process was given is scrubbed from the body, the header values and the error, as for local tools: hygiene, not containment.

**Node only, and what is not confined.** The permission model covers the filesystem and child processes; the network is held by the fence below (0.29.0; before it, `network` was recorded, not enforced). A child process runs outside both, so `shell`/`programs` is where the fences end. Engram's approval prompt says so.

### The network fence (0.29.0)

Advertised as `hello.app_network: 1`. A bridge without it does not enforce `backend.network`.

A backend reaches the hosts in `backend.network` on ports 443 and 80, and Engram's own API host on its exact port, and nothing else. Two halves (`src/apps/guard.ts`, `src/apps/egress.ts`):

- **In the backend**, a fence loaded with `--require` before the app's own code replaces the native methods every connection ends in, on their prototypes, non-writable and non-configurable: a TCP connect goes to a loopback relay in the bridge for the port asked for (another port is refused); UDP, Unix sockets and named pipes, listening, and wrapping a descriptor as a TCP or UDP socket are refused; `dns.lookup` answers only declared names (with a stand-in address) and never asks a resolver; `dns.resolve*` is refused; `v8.setFlagsFromString` is refused. `process.binding`, addons, workers, WASI, the inspector and loader hooks are closed by the permission model itself.
- **In the bridge**, the relay decides where a connection goes. TLS: by the server name in the client hello (no name, or two, is refused); then it only copies bytes. Anything else is parsed as HTTP/1.1 request by request: each request is checked by its own Host header and forwarded on its own, so a kept-alive connection cannot switch hosts; CONNECT, an absolute-URL request target and anything that is not HTTP are refused. The relay resolves the name itself and connects to the address it checked; a declared name that resolves only to loopback, private, link-local, CGNAT or other non-public addresses is refused (Engram's own host is exempt). A refusal is a 403 with `x-engram-refused: network` over HTTP, an `unrecognized_name` alert over TLS, and a line in the bridge's log.

The replaced functions on the modules themselves (`dns.lookup`, `dns.promises.lookup`, `v8.setFlagsFromString` and the like) keep their enumerability, so a backend written as ES modules still imports them by name (`import { lookup } from 'node:dns/promises'`) and gets the fenced one. In 0.29.0 they were made non-enumerable, which Node reads as "not an export": such an import failed to link and the backend exited at start; fixed in 0.29.1.

**`backend.public_images: true`** (the manifest's `"public_images": true`): the backend gets `ENGRAM_IMAGE_FETCH` (`http://engram-images.invalid/`) and may ask the bridge to fetch one image: `GET <ENGRAM_IMAGE_FETCH>?url=<http or https address>`. The bridge makes the request itself: GET with no body and none of the app's headers, ports 443 and 80, public addresses only, at most 4 redirects each checked the same way, an `image/*` content type, 3 MB, 10 seconds. The answer is the image (200, its content type) or a 4xx/502 with `x-engram-refused: images` and a sentence. The address itself still reaches the image's host, which is what loading an image from any host means; nothing else of the app's does.

**What it does not hold.** Inside TLS the relay sees nothing: a request to a declared host whose front end also serves other sites (a shared CDN) can name another site in its inner Host header ("domain fronting"); most large front ends refuse a mismatch, but the bridge cannot check it. Data can go out to a declared host itself. A child process (`shell`, `programs`) runs without the fence. The relay's loopback ports can be reached by other programs on the machine, which gets them only this app's declared hosts.

## Subscription Usage

Where a CLI runs on somebody's own subscription, that subscription has allowances that refill
on a rolling basis, and an application may want to show a person where they stand. The
credential that could answer for them lives on the machine, with the CLI, and is deliberately
never sent to the server — so the server asks, and the bridge answers with figures only.

One request, one reply, correlated by `id`, exactly like `local_call` / `local_result`.

### Server → Bridge: `usage_request`

```json
{
  "type": "usage_request",
  "id": "usage-7f3c1a",
  "provider": "claude"
}
```

- **`id`** — echoed back on the reply.
- **`provider`** — optional, the CLI to report on, by the name it is detected under. **Send it
  whenever you know.** A machine can have several CLIs installed and only the server knows
  which one is answering a given conversation. Without it the bridge answers only when the
  choice is unambiguous (exactly one CLI installed) and otherwise replies `unsupported`,
  because reporting one CLI's subscription while another is answering the conversation is
  worse than reporting nothing: the number looks right.

### Bridge → Server: `usage_result`

```json
{
  "type": "usage_result",
  "id": "usage-7f3c1a",
  "ok": true,
  "limits": [
    { "label": "Current session", "percent": 32, "resets_at": "2026-09-21T11:10:00+00:00", "kind": "session", "group": "session" },
    { "label": "This week", "percent": 43, "resets_at": "2026-09-24T00:00:00+00:00", "kind": "weekly_all", "group": "weekly" }
  ]
}
```

```json
{
  "type": "usage_result",
  "id": "usage-7f3c1a",
  "ok": false,
  "reason": "no_credential"
}
```

**The bridge always answers**, for every `usage_request` carrying an id, including one it
cannot help with. A request that goes unanswered is indistinguishable from a bridge too old to
know the frame, and the server would have to wait out a timeout to find out which it was.

**`limits`** is present when `ok`. Each entry describes one allowance window:

- **`label`** — human-readable, composed by the bridge (`"Current session"`, `"This week"`,
  `"Fable this week"`). Composed HERE on purpose: this is the layer that knows which CLI
  answered and what its vocabulary means. A consumer renders the list in the order given,
  using these labels, and therefore needs no change when the vendor renames a window or adds
  one. A window kind the bridge has not met is still labelled, from the kind itself.
- **`percent`** — whole percent consumed, clamped to 0-100.
- **`resets_at`** — ISO 8601 instant the allowance refills. Absent when the CLI does not say.
- **`kind`** / **`group`** — the CLI's own identifiers, passed through untranslated, for a
  consumer that wants to group or filter. Neither is required to render a row.

**`reason`** is present when not `ok`:

- **`unsupported`** — this CLI has no notion of a subscription allowance.
- **`no_credential`** — it has one, but nobody is signed in, or the sign-in has expired.
- **`failed`** — it tried and could not.

**Money is deliberately absent.** The vendor's answer may also carry spend and credit
balances; they are dropped here rather than forwarded, so an allowance figure cannot be
mistaken for a bill by anything downstream.

**Claude.** `readClaudeUsage()` reads `~/.claude/.credentials.json` and calls
`GET https://api.anthropic.com/api/oauth/usage`. The token is re-read on every request
because the CLI refreshes it in place. Other CLIs answer `unsupported`.

---

## AI Requests

### Server → Bridge: `ai_request`

When the server needs an AI response (triggered by a user message in the browser), it sends:

```json
{
  "type": "ai_request",
  "request_id": "req_abc123",
  "conversation_id": "conv_xyz789",
  "provider": "claude",
  "message": "The goblin chieftain steps forward, raising a gnarled staff...",
  "system_prompt": "You are a D&D Dungeon Master...",
  "cli_session_id": null,
  "history": [
    {"role": "user", "content": "I enter the cave"},
    {"role": "assistant", "content": "The cave mouth yawns before you..."}
  ],
  "options": {
    "max_tokens": 4096,
    "temperature": 0.8
  }
}
```

**`request_id`**: Unique identifier for this request. All streaming events reference it.

**`conversation_id`**: The server's conversation identifier.

**`provider`**: Which CLI to use. Must match one of the available providers from the handshake. If the requested provider is unavailable, the bridge responds with an error.

**`message`**: The new user message to send.

**`system_prompt`**: The system prompt. May be `null`.

**`subagent_prompt`** *(optional)*: Text appended to the system prompt of every subagent the assistant starts this turn. See [Additive field: `subagent_prompt`](#additive-field-subagent_prompt--text-for-every-subagent).

**`cli_session_id`**: The CLI session to resume, or `null` to start a fresh session. **The server owns this mapping** (persisted per conversation) and is the single source of truth — the bridge keeps no session map of its own. See [Conversation Continuity](#conversation-continuity).

**`history`**: Prior conversation turns (`{role, content}`). Included only when `cli_session_id` is `null`, so a fresh CLI session can be seeded with context. Omitted when resuming — the resumed session already holds its history.

**`options`**: Provider-agnostic generation options. The bridge maps these to CLI-specific flags where supported.

#### Additive option: `accepts_input` — a turn that takes messages while it runs

```json
"options": { "accepts_input": true }
```

A bridge that understands this says so in `hello` with **`"turn_input": true`**, so a server can tell before the first turn whether offering it is worth anything. That is the capability, not a promise about any turn: `input_open` on the ack still decides each one.

Opt-in, per turn, Claude only. The turn keeps the CLI's input open for its whole life, so a message the person types while it runs can reach the assistant in the same process ([`turn_input`](#server--bridge-turn_input)) instead of waiting for the next turn. The bridge confirms it with `input_open: true` on the [`ai_request_ack`](#bridge--server-ai_request_ack); **without that confirmation nothing about the turn differs** from one that did not ask, and a server holds mid-turn messages as it always did. An older bridge ignores the option and never confirms, and so does this one for any other provider — which also makes leaving the option out the way back if the mode misbehaves.

What changes for such a turn:

- **The CLI reads its messages as NDJSON on stdin.** Spawned with `--input-format stream-json --replay-user-messages`; the opening `message` is written as the first frame, and stdin stays open. The frame, verified against Claude Code 2.1.280, is `{"type":"user","message":{"role":"user","content":"<text>"}}`. The CLI echoes each message back at the moment it takes it in, which is what [`user_input`](#user_input) is made from.
- **The turn ends by a rule, not at the first `result`.** The bridge closes stdin — after which the CLI finishes, exits, and the bridge sends `done` — only when **all** of these hold:
  1. the main assistant has **taken in the opening message** and is idle (its message ended, or a `result` arrived);
  2. **no task it or a helper started is still running**, whatever its `task_type` (`local_agent`, `local_bash`, anything else), as tracked from the task's `started` to its `finished` (or an `updated` to a status other than `running`/`pending`). That includes a command a helper left running after the helper itself finished (`owned_by_subagent` on its `task_started`): the CLI wakes that helper when the command ends, and it reads the result and carries on (seen on 2.1.283), so the command is still work in progress. Only when the silence bound runs out on such commands alone does the bridge end the turn early, and gently — see `leftovers_silent` under [`input_closed`](#input_closed);
  3. every accepted `turn_input` has been read (its `user_input` was sent).

  In addition, when a background task of the main assistant ends, the CLI answers it in a turn of its own (a background task here includes a command started in the foreground and moved to the background when it outlived its tool timeout, recognised by the reply to the call naming its output file); the bridge waits for that turn to start (up to 10 s) before closing, so a message sent meanwhile is still delivered.

  The bridge announces the close with [`input_closed`](#input_closed) (when it advertised `hello.input_closed`). From then on every `turn_input` is answered `turn_ending`, while the CLI finishes what it has; `done` follows its exit.

  **The opening message counts as unread until the CLI has taken it in** — its echo was seen, or a `result` without `origin` arrived (that one answers the prompt, so it cannot come before the prompt was read; it is the fallback for a CLI that ever skipped or folded the echo, and either signal is enough). Until then a `result` with an `origin` does not make the main assistant idle: it is kept for `done` like every other, and nothing else changes. The case this exists for, seen in production: a previous turn on the session was stopped while a background task it started still ran. On `--resume` the CLI first answers that leftover `<task-notification>` — a turn of its own ending in `origin: task-notification`, `num_turns` 0, about 100 ms in — and only then reads the opening. That task is not one of this turn's and the opening is not a `turn_input`, so the rule used to hold and closed the input before the assistant had read its prompt: the turn ran on for 34 minutes and every `turn_input` was rejected `turn_ending`. A bridge without `hello.input_closed` may still do this.

  A `result` before that is **not** terminal. Captured on 2.1.280 with stdin open: a background shell command yields a `result` as soon as the reply ends (no `origin`), and a second one (`origin: task-notification`) when the CLI later answers the command's end; each mid-turn message adds one more. `done` carries the **last** result's fields with `usage` and `num_turns` **summed** across all of them (`cost_usd`, `duration_api_ms` and `subagent_stats` are already running totals in the CLI's own results, so they are taken from the last). That holds however the turn ends: after an error `result` (the CLI then exits 1, and the error is reported as usual — `session_lost` included — ahead of that `done`), and on a turn a `cancel`, a bound or a crash stopped, whose `done` would otherwise be empty.
- **Background tasks are on** for this turn: the bridge leaves `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` unset rather than applying its default of `"1"` (see [`bridge_env`](#additive-fields-bridge_env-and-bridge_prompt)). Every other turn keeps the default. A server's explicit `bridge_env` value still wins.
- **The addendum says so.** It tells the model the process stays until everything it started is done, that messages can arrive meanwhile, that background tasks are available, that a failed or stopped task is reported with its output file and can be re-run, and that a background command must end. It still forbids detaching work with `&`, `nohup`, `disown` or `setsid`.
- **The clocks are unchanged.** An accepted `turn_input` and every `main_state` count as activity for the silence bound. So does a background shell command whose output keeps **growing**, whether the main assistant or a helper started it, and including one moved to the background after it outlived its tool timeout: the CLI writes nothing to the stream while such a command runs, so the bridge looks at the output file the CLI named in its reply to the call (every 30 s at the default bound, a quarter of the bound when it is shorter), and growth since the last look resets the clock. Only growth counts, never merely "a command is running". That bound (900 s by default) is therefore still the backstop for a background command that never ends or has gone quiet: the turn is stopped and reported as `silence_timeout_exceeded` (except when only finished helpers' commands are left, which ends it gently as `input_closed` `leftovers_silent`), the next turn is told by the CLI, and the command's output file stays on disk. If the CLI's reply ever stops naming the file, nothing is watched and the bound behaves as it did before.
- **Stopping the turn stops what it started.** Every CLI is spawned as the leader of its own process group, and a `cancel` or a bound signals the group (SIGINT, then SIGTERM, then SIGKILL, as before). Claude Code runs each shell command in a session of its own, so on the last step the bridge also kills the groups of the CLI's descendants — found while they are still its descendants — because a SIGKILLed CLI cannot stop its own background commands. Accepted messages not yet read are dropped with the turn and named in `cancelled.pending_inputs`.

It is still one process per turn: the process ends when the turn does. There is no long-lived process per conversation.

#### Additive option: `effort` — the Claude thinking level

```json
"options": { "effort": "high" }
```

Since ai-bridge 0.32.0. Claude only. One of `hello.effort_levels` — `low`, `medium`, `high`, `xhigh`, `max` — and the bridge starts the CLI with `--effort <level>`, on a fresh turn and on a resumed one alike (like `--model`, it is per invocation, so a server sends it on every turn it wants it for). Verified on Claude Code 2.1.287, also together with `--resume`. `--effort` itself is older; `xhigh` needs Claude Code 2.1.111+; on models without `xhigh` the CLI falls back to `high`.

Any other value is **ignored**, logged at debug: the turn runs exactly as if the option were absent, at the CLI's default level, and nothing is reported to the server. Absent, `null` or `""` means today's behaviour exactly — no flag. Codex and Gemini ignore the option, and so does a bridge without `hello.effort_levels`.

#### Additive field: `working_dir`

Where the CLI should be spawned. Optional; **absent means today's behaviour exactly** — a freshly made empty directory under `~/.cache/ai-bridge/`.

```json
{
  "type": "ai_request",
  "request_id": "req_abc123",
  "working_dir": "/Users/jasper/zp-studio/zeroplex-studio/ZeroPlex_Studio__D09042"
}
```

It is honoured **only** when the operator started the bridge with `--allow-dir` and the path resolves inside one of those roots. Otherwise the turn is refused. The rules, all of them refusals rather than corrections:

| Condition | Result |
|---|---|
| Absent, on a fresh session | The empty scratch directory, as before. |
| Absent, on a resume | The directory that session already runs in — re-checked against the allow-list as it stands now, so a revoked directory is refused rather than reused. Servers **should** resend `working_dir` on every turn anyway — see the note below. |
| Bridge started without `--allow-dir` | `working_dir_not_allowed` |
| Not absolute, or contains a null byte | `working_dir_not_allowed` |
| Resolves outside every allowed root (after `realpath`, so a symlink inside a root that points out of it is caught) | `working_dir_not_allowed` |
| Inside an allowed root but does not exist, or is not a directory | `working_dir_not_found`. **The bridge never creates it.** |
| Present, and differs from the directory the resumed `cli_session_id` was started in | `working_dir_changed` |

There is deliberately **no silent fallback to the scratch directory**. A turn that quietly ran in an empty directory looks exactly like a turn that worked, and every answer in it is wrong.

A path outside the allow-list is reported identically whether or not it exists, so the bridge cannot be used as a filesystem probe.

**A working directory belongs to a CLI session for that session's life.** Resuming a session started elsewhere is incoherent — its history is all about another checkout — so it is refused with `working_dir_changed` and the server starts a fresh session deliberately.

A resume that names nothing keeps the directory the session already has. The bridge remembers that mapping across restarts (it persists to `~/.cache/ai-bridge/sessions.json`, shared by every bridge that user runs on the machine), but it is still a local record, bounded and advisory. Two cases follow from that:

- **A session it has no record of** — evicted by age, or started on another machine — resumes in the scratch directory, which for a workspace conversation is the wrong answer.
- **A remembered directory that is no longer permitted** — the operator narrowed `--allow-dir` — is refused with `working_dir_not_allowed`, and the turn does not run. The record never outlives the revocation.


So a server that supports workspaces **should send `working_dir` on every turn**, not only the first. It costs nothing, and it is the only thing that makes the outcome independent of what the bridge happens to remember.

**Consequence, and it is intended:** once `working_dir` is a real checkout, that repository's own `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` load, because the CLIs read them from cwd. That is the point of working in a checkout, not a leak. User-level files (`~/.claude/CLAUDE.md`) are a separate matter and load regardless — see `cli_isolation`.

#### Additive field: `attachments`

Files the assistant should be able to read this turn. References, never bytes:

```json
"attachments": [
  {
    "id": "att_9f3c",
    "name": "invoice.pdf",
    "mime_type": "application/pdf",
    "size": 482113,
    "sha256": "9f3c...",
    "url": "https://studio.example.com/ai-bridge/attachments/att_9f3c"
  }
]
```

Inlining the bytes is not an option worth trying. The server's WebSocket message cap is 1 MB, the bridge's client accepts 10 MB frames and the HTTP relay body cap is 16 MB — so a single screenshot, once base64 has added a third, already exceeds the tightest of them, and it would exceed it as a *dropped WebSocket message* rather than as an error anybody could act on.

So the bridge fetches each one instead:

1. **The URL must be on the origin this bridge is connected to** (derived from `--server`, or the explicit `--api` override), and it must be HTTPS — the sole exception being a loopback host, where there is no wire to eavesdrop on. Redirects are **not** followed, since an allowed origin answering `302` to anywhere it likes would make the check decorative. Anything else is refused with `attachment_refused`. Without this, a compromised or hostile server turns every connected bridge into a fetcher for arbitrary hosts, with the operator's own connection token attached.
2. It is streamed to a per-request directory under `~/.cache/ai-bridge/attachments/` — named from the request id plus a short digest of it, since two ids that sanitise alike must not share a directory and delete each other's files. **Never into the working directory**: a checkout must not be dirtied by the transport. If the file belongs in the repo, the developer asks the assistant to copy it there.
3. `name` is reduced to a single safe path component (separators of both kinds stripped, leading dots removed, length capped, collisions numbered). The server's filename is never trusted to be a path.
4. Per-file, per-request and count caps apply (`--attachment-max-mb`, `--attachment-total-mb`, `--attachment-max-count`; 25 MB, 100 MB and 50 files by default, and reported in [`hello`](#additive-field-attachment_limits)), enforced against the *declared* size before fetching and against the *actual* bytes while streaming. Over a cap is `attachment_too_large`. A download that receives nothing for `--attachment-stall-seconds` (60 by default) or runs past `--attachment-timeout-minutes` (60) fails with `attachment_failed`, and the message says which and how many bytes had arrived. There is no fixed per-file duration any more: a large file that keeps moving is not cut off.
5. `size` and `sha256` are verified afterwards. A mismatch fails the whole request with `attachment_failed` — a half-downloaded PDF is, to the model, indistinguishable from a genuinely corrupt one, so it would confidently report the wrong problem.
6. A short preamble naming the absolute paths, types and sizes is prepended to `message`, so the model knows the files exist and where they are. In `isolated`, where Claude's tool surface is otherwise restricted to `mcp__bridge__*`, a turn carrying attachments also gets a read rule **scoped to that turn's attachment directory** (`Read(/<dir>/**)`). Without it the preamble would name paths the model is not permitted to open, and the turn would end with it saying it cannot see a file the user had just attached. A bare `Read` would instead grant the whole filesystem — a server controls both the attachments and the message, so that would be arbitrary file read switched on by sending a field.
7. The request's attachment directory is deleted when the turn terminates — on `done`, `error` and `cancelled` alike. `--keep-attachments` retains it for debugging.
8. The bytes are also kept, for a while, in a store keyed by `sha256` — one per installed bridge, never shared between bridges pointed at different servers — and a later turn that attaches the same file gets it hard-linked (or copied) into its own directory without a download. The kept copy is re-verified against the checksum in the new turn's reference first; anything wrong with it is a silent re-download, never an error. Unused files expire after 72 hours and the store is capped at 1 GB, least recently used first (`--attachment-cache-ttl-hours`, `--attachment-cache-max-mb`; `0` turns it off). Nothing changes on the wire: the server sends the same reference each time, and the bridge decides whether it needs to fetch it. The preamble tells the model, in one line, that a file from an earlier turn may still be on the machine.

#### Additive fields: `bridge_env` and `bridge_prompt`

Session defaults the bridge owns, and the two levers a server has over them. **Both are optional, and a server that sends neither gets the behaviour described here** — which is the point of putting it in the bridge rather than in every consuming server.

##### Why the bridge owns this at all

Every turn is answered by a **separate CLI process that exits the moment that turn ends**. Nothing the assistant started survives it. So when the model reaches for a background shell command, the result is never collected: the process tracking it is gone, its output reaches nobody, and the next turn opens with a notice that the work was orphaned. To the reader it looks as though the assistant forgot what it was doing.

That is not a product decision any one server should have to rediscover. The bridge is the only component that knows a turn is a process, so the bridge states it.

```json
"bridge_env": { "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS": "0" },
"bridge_prompt": { "mode": "append", "text": "Answer in Dutch." }
```

**`bridge_env`** — environment keys to set or unset on the spawned CLI. Only allow-listed keys are honoured:

| Key | Default | Why |
|---|---|---|
| `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` | `"1"`, **unset on a turn with [`accepts_input`](#additive-option-accepts_input--a-turn-that-takes-messages-while-it-runs)** | Architectural. Background work cannot be collected by a turn whose input is closed, so it is off for every such turn equally — and it switches helpers to the foreground too (captured on 2.1.280). A turn with `accepts_input` stays until everything it started has ended, so there it is on. |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | `"1"` | Privacy. One machine user serves many projects, so notes written from one client's chat can surface in another's — a leak between tenants rather than a lost convenience. An operator who wants memory back says so with `bridge_env`. |
| `CLAUDE_CODE_FORK_SUBAGENT` | *(none)* | Settable, not defaulted. The bridge has no architectural reason for it, and it changes cost and behaviour for every project that never asked. |

`null` or `""` **unsets** a key — which is how a project removes a bridge default rather than only overwriting it. "Not mentioned" and "deliberately off" must never look alike, so the unset is written explicitly.

A key the bridge does not allow is **dropped and named in the ack**, not refused. A server on a newer protocol than the bridge is ordinary version skew, and failing the turn would make every bridge upgrade a flag day. Restricting the keys is a security boundary rather than tidiness: an open map would let a server point the CLI at another endpoint, or rewrite its search path, inside a process holding the operator's credentials.

**`bridge_prompt`** — how the bridge's own addendum is handled. The addendum carries the session **lifecycle** and nothing else; the server keeps ownership of the voice and the product rules through `system_prompt`, which it is passed beside rather than instead of.

| Mode | Meaning |
|---|---|
| `default` | Bridge addendum only. The default for every project that says nothing. |
| `off` | No addendum at all. The project owns the whole prompt and takes on explaining the lifecycle itself. |
| `append` | Bridge addendum, then the project's text. The expected way to add project-specific rules. |
| `replace` | The project's text instead of the bridge addendum. |

Validation is strict, and a contradictory spec is refused with `bridge_prompt_invalid` rather than guessed at — a chat whose instructions are not what either side believes is worse than a refused turn:

| Mode | Text | Result |
|---|---|---|
| `default` / `off` | present | **Refused.** The text would be silently discarded. |
| `append` | absent or empty | **Refused.** Says it is adding something and adds nothing. |
| `replace` | absent or empty | **Refused.** Would silently mean `off`. |

Server-supplied text is capped at 8 KB. A cap with a clear refusal beats a `spawn E2BIG` at launch, which surfaces as a turn that failed for no visible reason.

**The addendum is generated from the resolved environment, not shipped as a fixed string.** If a project uses `bridge_env` to turn background work back on, an addendum still saying the capability is disabled would be lying to the model about something it can observe directly in its own tool schema. The lifecycle bullets change with the configuration; "one process per turn, nothing survives it" is stated either way, because it is true either way.

`off` and `replace` are the project's right, and both are logged at warning level naming what was dropped: a project that takes them on owns explaining the lifecycle itself.

#### Additive field: `subagent_prompt` — text for every subagent

A string the bridge appends to the system prompt of every subagent (helper) the assistant starts during this turn — for example the house rules a delegated task must still follow. It sits next to `system_prompt`, which only reaches the main assistant.

```json
"subagent_prompt": "Answer in Dutch. Never quote vault values back."
```

- **Claude**: written to a `0600` file in a per-turn temp directory and passed as `--append-subagent-system-prompt-file <file>`; the file is removed when the CLI exits. Claude Code appends it to every subagent's system prompt, **nested subagents included**. **Forks do not get it**: a fork reuses the main assistant's system prompt, so whatever a fork must know belongs in `system_prompt`. Like `system_prompt`, it is per-invocation and **not retained across `--resume`** — send it on every turn that should have it.
- **Needs Claude Code 2.1.261+.** An older CLI exits on the unknown flag, so the bridge checks the version it detected at startup (`claude --version`) and, on an older or unknown version, **skips the flag with a warning** and runs the turn without it. Verified on 2.1.283 (a `general-purpose` subagent obeyed the appended text; the main assistant did not see it).
- **Codex / Gemini**: ignored (debug log). Neither CLI has subagents to give it to.
- **Absent, `null`, empty or whitespace-only**: no flag, today's behaviour. A non-string is ignored with a warning, never the turn.
- **Isolation is unchanged.** It is prompt text only; it grants nothing. Subagents run under the turn's permission posture as before.

### Bridge → Server: `ai_request_ack`

The bridge acknowledges receipt before starting the CLI process, echoing the session it was asked to use and what it resolved for this turn:

```json
{
  "type": "ai_request_ack",
  "request_id": "req_abc123",
  "cli_session_id": null,
  "bridge_session": {
    "prompt_mode": "default",
    "prompt_server_text": false,
    "env_overridden": [],
    "env_rejected": ["ANTHROPIC_BASE_URL"]
  },
  "input_open": true
}
```

**`input_open`**: Present, and `true`, only when the turn runs with its input open ([`accepts_input`](#additive-option-accepts_input--a-turn-that-takes-messages-while-it-runs)). Absent otherwise, and absent from every bridge that predates it: a server reads absence as "not open" and holds a mid-turn message until the turn is over.

**`cli_session_id`**: The `cli_session_id` from the `ai_request` (the session being resumed, or `null` for a fresh start). Informational. The *resulting* session id — the one created or continued — is reported later on the `done` event.

**`bridge_session`**: What the bridge resolved for `bridge_env` and `bridge_prompt`, so a server can **assert** it got what it asked for instead of inferring it from the assistant's behaviour three turns later. Same instinct as `origin` stamping: make it observable rather than deducible.

A bridge that predates this field omits it entirely, so a server must treat absence as *unknown* — never as *defaults applied*.

### Server → Bridge: `cancel`

Stop a turn that is running, and leave a session that can be resumed.

```json
{
  "type": "cancel",
  "request_id": "req_abc123"
}
```

This is the other half of `ai_request` — a person pressing stop, or the server noticing an abort flag mid-turn. Without it the only thing that can end a turn is a bound, and every bridge-side bound is measured in minutes.

The bridge does what it does when one of its own bounds fires: it ends the CLI's turn (SIGINT, escalating only if that is ignored), keeps everything the turn produced, closes any open block, and sends the turn's own `done`.

**A cancelled turn is not reported as an error.** Three paths used to say otherwise and no longer do: the CLI exiting non-zero because the signal landed mid-tool, the CLI writing an error `result` on its way out, and the cancel interrupting the work that runs *before* the CLI (an attachment download, say). The last mattered most on a resumed turn, where a failure is what `session_lost` is read from — the server would have wiped the session and silently re-issued the turn somebody had just stopped.

A turn stopped by one of the bridge's own bounds is reported the other way round, and deliberately: `silence_timeout_exceeded` or `request_timeout_exceeded` with `limit_seconds`, because the server did not ask for that and has no other way to learn it happened.

**An unknown `request_id` is ignored, not answered.** A cancel arriving just after the turn ended is the ordinary race — somebody pressed stop as the answer landed — and there is nothing left to report about it.

### Bridge → Server: `cancelled`

The turn named by a `cancel` has stopped.

```json
{
  "type": "cancelled",
  "request_id": "req_abc123"
}
```

**Sent after the turn's own events, not on receipt of the cancel.** The CLI is asked to stop rather than shot, so it commonly writes a little more on the way out; a server treats `cancelled` as terminal, so a reply that went out first would cut off the partial answer that stopping cleanly exists to keep.

Sent only in response to a `cancel`. A turn ended by one of the bridge's own bounds reports a timeout on the `error` event and ends with `done`, like any other turn.

On a turn with its input open it also carries **`pending_inputs`**: the `message_id` of every `turn_input` that was accepted and never read, oldest first — always present on such a turn, empty when nothing was pending. They are dropped with the turn; the server decides whether to offer them again.

```json
{ "type": "cancelled", "request_id": "req_abc123", "pending_inputs": ["msg_42"] }
```

The same list rides on the `error` `bridge_disconnected` the bridge replays after a reconnect for a turn the dropped connection aborted (see [Error Response](#bridge--server-error-response)). With `cancelled` and `done`, that makes the accounting exact: **every accepted `turn_input` is either listed in the terminal frame's `pending_inputs` (never read — offer it again if you like) or it was read**, whether or not its `user_input` reached you. A message the assistant read while the socket was down has no `user_input` the server ever saw; it is read all the same, and must not be sent again.

### Server → Bridge: `turn_input`

A message for a turn that is still running. Only meaningful for a turn whose ack said `input_open: true`.

```json
{
  "type": "turn_input",
  "request_id": "req_abc123",
  "message_id": "msg_42",
  "content": "Also check the staging config while you are at it."
}
```

**`message_id`**: The server's id for the message. Echoed on the ack and on `user_input`. **Idempotent within the turn:** a `turn_input` repeating a `message_id` the turn already accepted — a retry after a lost or late ack — is answered `accepted` again and not delivered again. A rejected one was never delivered, so its retry is judged afresh.

**`content`**: The text, as a string. Text only: files are fetched per turn, before the CLI starts.

A frame without a string `request_id`, `message_id` and a non-empty string `content` is dropped with a warning and not answered.

### Bridge → Server: `turn_input_ack`

The answer to every `turn_input`, sent at once.

```json
{ "type": "turn_input_ack", "request_id": "req_abc123", "message_id": "msg_42", "status": "accepted" }
{ "type": "turn_input_ack", "request_id": "req_abc123", "message_id": "msg_42", "status": "rejected", "reason": "turn_not_running" }
```

| `status` | `reason` | Meaning | What the server does |
|---|---|---|---|
| `accepted` | — | Written to the running CLI and queued there. The assistant reads it at its next step; [`user_input`](#user_input) says when. | Wait for `user_input`. |
| `rejected` | `turn_ending` | The turn is still running but takes nothing more: the bridge has closed its input (the turn is finishing; announced as [`input_closed`](#input_closed)), or it is being stopped — a `cancel`, a bound, a dropped connection; stopping can take up to ~10 s. **Its CLI may still be alive and writing to the session.** | **Hold it until this request's terminal frame** — `done`, `cancelled`, or the `error` `bridge_disconnected` replayed after a reconnect — **then** start a new turn with it. Never sooner: a new turn resumes the same session, and there is no lock on it, so two CLIs would write to it at once. |
| `rejected` | `turn_not_running` | No turn by that id is running: it never existed, or it has ended and its terminal frame went out ahead of this ack. | Start a normal new turn with it. |
| `rejected` | `input_not_open` | The turn is running but cannot take it: it was not started with `accepts_input`, or its CLI has not started its session yet (input opens at the CLI's first `system/init`, so a CLI that fails before it has a session — a resumed session that is gone — never takes a message it would lose). | Hold it until the turn is over. |

A `reason` the server does not know is to be treated like `turn_ending`: hold the message until the request's terminal frame. Holding is always safe; starting a turn early is not.

Nothing promises the assistant will change course. A message is read **after the step the assistant is in**: straight away when it is idle (for example while only background tasks run), otherwise when its current tool call returns — captured on 2.1.280, a message sent 15 s into a 40 s foreground command was read when the command finished, and then answered.

The same holds while the main assistant waits on a **foreground helper** (the Agent/Task tool, not backgrounded): the input is open and the main assistant `working`, so the message is accepted and written to the CLI at once, and the CLI reads it when the helper hands back — after the helper's last `task` event and the Agent call's `tool_result`. Captured on 2.1.280: a message sent 15 s in was read when the helper returned, 35 s later, and then answered. That capture ran with `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` (a server's `bridge_env` can set it), because with background tasks on — this mode's default — the model asked for a foreground helper started it in the background anyway, and the main assistant was idle and read the message straight away. The bridge holds nothing back in either case; when the message is read is the CLI's doing.

A turn on a resumed session can open with a turn of the CLI's own (a notification left over from an earlier, stopped turn) before the CLI reads the opening message. A message sent in that window is accepted and read after the opening — see the terminal rule under [`accepts_input`](#additive-option-accepts_input--a-turn-that-takes-messages-while-it-runs); a bridge before `hello.input_closed` could close the input there and reject it `turn_ending`.

---

## Person uploads

A file somebody picks in the server's chat composer, sent to this machine **at the moment it is picked** and not kept by the server. The server is a pipe: the browser's upload body is streamed into an HTTP response the bridge is reading, and nothing is written to the server's disk. So the machine has to be connected when the file is picked, and the file then exists on exactly one machine.

The bytes do not travel over the WebSocket, for the reasons given under [`attachments`](#additive-field-attachments). The socket carries three small frames from the server and one answer; the bytes come over one authenticated HTTP GET.

```
browser ──POST (body)──▶ server ──upload_offer──▶ bridge
                          server ◀──GET url────── bridge      (Bearer token, same origin rules as attachments)
         body bytes ────▶ server ──response body─▶ bridge     (piped, hashed and counted on the way through)
                          server ──upload_sent──▶ bridge      (size + sha256 of what passed)
                          server ◀─upload_done─── bridge      (committed path, or a refusal)
browser ◀──JSON────────── server
```

### Server → Bridge: `upload_offer`

```json
{
  "type": "upload_offer",
  "id": "5f1c…",
  "url": "https://studio.example.com/ai-bridge/uploads/5f1c…",
  "working_dir": "/Users/jasper/zp-studio/ZeroPlex_Studio__D09042",
  "name": "contract.pdf",
  "mime_type": "application/pdf",
  "size": 482113
}
```

| Field | Meaning |
|---|---|
| `id` | Names this upload. Unguessable; the URL is single-use. |
| `url` | Where to GET the bytes. Checked exactly as an attachment URL: same origin as the connection (or `--api`), HTTPS unless loopback, redirects not followed. Otherwise `upload_refused`. |
| `working_dir` | The chat's working folder. Checked by the same rules as `ai_request.working_dir`, with the same refusal codes (`working_dir_not_allowed`, `working_dir_not_found`). |
| `name` | Reduced to one safe path component, as attachment names are. |
| `size` | Exact byte count. More is cut off, fewer is a failure. Over `--attachment-max-mb` is `upload_too_large`, before anything is fetched. |

The bridge:

1. Refuses with `upload_refused` when it has no allowed folder.
2. Creates `<working_dir>/file-uploads/` if it is missing (with a `.gitignore` of `*` inside, on creation only), and refuses if it is a symlink or not a directory.
3. Opens a hidden `.<id>.part` exclusively, GETs `url` with `Authorization: Bearer <token>`, and writes, counts and hashes what arrives. The stall and ceiling clocks are the attachment ones (`--attachment-stall-seconds`, `--attachment-timeout-minutes`).
4. Waits (up to 60 s after its body ended) for `upload_sent`, and requires its `size`, the declared `size` and the bytes received to agree and its `sha256` to match the digest computed here. Otherwise `upload_failed`.
5. Gives the file its real name with an operation that cannot replace an existing file (`link`, falling back to an exclusive copy); a name that is taken is numbered (`report-2.pdf`).
6. Removes the `.part` on every path.

### Server → Bridge: `upload_sent`

```json
{ "type": "upload_sent", "id": "5f1c…", "size": 482113, "sha256": "9f3c…" }
```

Sent when the last byte has passed through the server. May overtake the end of the HTTP body; the bridge waits for both.

### Server → Bridge: `upload_abort`

```json
{ "type": "upload_abort", "id": "5f1c…", "reason": "the person removed the file" }
```

The browser went away, the server gave up, or anything else ended the upload early. The bridge stops, deletes the partial file and still answers with `upload_done` (`upload_cancelled`). A bridge also abandons every upload in progress when its socket drops.

### Bridge → Server: `upload_done`

Exactly one per offer, on every path.

```json
{ "type": "upload_done", "id": "5f1c…", "ok": true,
  "path": "/Users/jasper/zp-studio/ZeroPlex_Studio__D09042/file-uploads/contract.pdf",
  "name": "contract.pdf", "size": 482113, "sha256": "9f3c…",
  "file_id": "b7e2…" }
```

`file_id` is the id this bridge recorded the file under, and the only thing a server can later ask for it by ([`file_read`](#handing-files-back)). `path` is for showing to the person.

```json
{ "type": "upload_done", "id": "5f1c…", "ok": false, "code": "upload_too_large",
  "error": "\"holiday.mov\" is 3.1 GB, over this machine's 25.0 MB per-file limit." }
```

| `code` | Meaning |
|---|---|
| `upload_refused` | No allowed folder, a URL on another host, or a `file-uploads` that is not a plain folder. |
| `working_dir_not_allowed` / `working_dir_not_found` | As for `ai_request.working_dir`. |
| `upload_too_large` | Declared size over `--attachment-max-mb`. |
| `upload_failed` | The download failed or stalled, the sizes or digests disagree, or the file could not be written. |
| `upload_cancelled` | `upload_abort`, or the socket dropped. |

`error` is written for a person and may be shown as it is.

**What this is not.** The file is not referenced by later `ai_request`s as an attachment, and the bridge does not fetch it again or cache it: it is already where the chat works. A server tells the model about it in the message text, by the `path` it was given.

## Handing files back

The reverse of [person uploads](#person-uploads): a file that lives on this machine, fetched for the person's browser, with the server keeping none of it.

**The rule, and it is the security boundary:** the bridge hands back **only files it recorded itself** — ones it received into `file-uploads/`, and ones the assistant handed back in `device` mode (`attachment` event, which now carries `file_id`) — **looked up by an id it minted, never by a path the server sends.** A compromised server can name an id it was given; it has no way to name `~/.ssh/id_ed25519`. The record is persisted per installation and server (`~/.cache/ai-bridge/served-files/<scope>.json`).

The older `attachment_read` frame, which named a path and resolved it against the working directory, is **refused** (`stream_end` with an error).

```
browser ──GET (Range)──▶ server ──file_read──────────▶ bridge
                          server ◀─file_read_result──── bridge   (found and unchanged: size + range; or why not)
browser ◀──status/headers server
                          server ◀─POST url (bytes)──── bridge   (Bearer token, same origin rules)
browser ◀──body (piped)── server
```

### Server → Bridge: `file_read`

```json
{ "type": "file_read", "id": "c41a…", "file_id": "b7e2…",
  "url": "https://studio.example.com/ai-bridge/downloads/c41a…",
  "range": "bytes=1048576-", "head": false }
```

| Field | Meaning |
|---|---|
| `id` | Names this transfer. |
| `file_id` | The id from `upload_done` or the `attachment` event. Unknown ids are refused (`file_unknown`). |
| `url` | Where to POST the bytes. Checked as an attachment URL; otherwise `file_refused`. |
| `range` | The browser's `Range` header, passed through. One range is honoured; anything else gets the whole file; a start past the end is 416. |
| `head` | Answer only; send no bytes. |

At serve time the bridge re-checks the file: `lstat` must show a regular file (not a symlink), it is opened with `O_NOFOLLOW`, the opened inode must be the one checked, and its size must equal the recorded size. Otherwise `file_gone` or `file_changed`, with a sentence saying which.

### Bridge → Server: `file_read_result`

```json
{ "type": "file_read_result", "id": "c41a…", "ok": true, "size": 482113, "status": 206, "start": 1048576, "end": 482112 }
```

```json
{ "type": "file_read_result", "id": "c41a…", "ok": false, "code": "file_changed",
  "error": "/…/file-uploads/contract.pdf has changed since it was sent: it is 90112 bytes now and was 482113. Open it on the machine itself." }
```

| `code` | Meaning |
|---|---|
| `file_unknown` | No record of that id. |
| `file_gone` | The recorded path no longer exists or cannot be opened. |
| `file_changed` | Not a plain file any more, replaced, or a different size. |
| `file_refused` | The URL is not on the connected origin. |
| `file_failed` | Anything else. |

Then, unless `head`, 416, or an empty range, the bridge POSTs exactly `end - start + 1` bytes to `url` with `Authorization: Bearer <token>`. The server holds that request open until the browser has the bytes.

### Server → Bridge: `file_read_cancel`

```json
{ "type": "file_read_cancel", "id": "c41a…" }
```

The browser went away; stop reading and abort the POST.

## Space files

A server that keeps no file bytes of its own (Engram) keeps each space's files on ONE machine, and asks that machine's bridge to write, read, move and remove them. Everything is under

```
<first --allow-dir folder>/files/                 (.gitignore of * made with it)
<first --allow-dir folder>/files/<space>/<path>   a space's files
<first --allow-dir folder>/files/<space>/.bin/…   its bin
```

**The rules, enforced here:** `space` is one plain name (`[A-Za-z0-9][A-Za-z0-9._-]{0,63}`); `path` is up to 8 plain names joined by `/` (no `..`, no `\`, no control characters, nothing hidden except `.bin` as the first part). Every folder on the way must be a real folder, never a symlink. **Nothing is ever replaced**: a write lands as a hidden `.part` and gets its name with `link`, which fails when the name is taken (`files_exists`); a move is `link` then `unlink`. **Only the bin is ever emptied** (`files_purge` refuses a path not under `.bin/`). Deleting is the server's `files_move` into `.bin/`.

Every request is answered with exactly one `files_result` carrying its `id`.

### Server → Bridge: `files_write`

```json
{ "type": "files_write", "id": "…", "space": "personal", "path": "contract.v2.pdf",
  "from_file_id": "b7e2…", "sha256": "9f3c…" }
```

Exactly one source:

| Field | Meaning |
|---|---|
| `content_base64` | The bytes in the frame, at most 512 KB decoded (`files_too_large`). |
| `from_file_id` | A file this bridge recorded (an upload, a handed-back file), by the id it minted — never a path. |
| `from_path` | An absolute path on this machine, which must resolve inside an allowed folder and outside `files/` (`files_refused`), to a plain file. |

`sha256`, when given, must match what was written; otherwise `files_failed` and nothing is left.

### Server → Bridge: `files_read`

```json
{ "type": "files_read", "id": "…", "space": "personal", "path": "notes.txt",
  "sha256": "…", "inline_max": 262144, "serve": true }
```

Reads and hashes the file (`lstat` regular file, opened `O_NOFOLLOW`, same inode). A `sha256` that no longer matches is `files_changed`. The bytes come back as `content_base64` only when the file is at most `inline_max` (capped at 512 KB). `serve: true` records the file the way an upload is recorded and answers its `file_id`, so a person can then fetch it with [`file_read`](#handing-files-back).

### Server → Bridge: `files_move`

```json
{ "type": "files_move", "id": "…", "space": "personal", "from": "notes.txt", "to": ".bin/notes.txt" }
```

### Server → Bridge: `files_purge`

```json
{ "type": "files_purge", "id": "…", "space": "personal", "path": ".bin/notes.txt" }
```

Removes the file for good. Only under `.bin/`.

### Bridge → Server: `files_result`

```json
{ "type": "files_result", "id": "…", "ok": true, "path": "/home/me/work/files/personal/notes.txt",
  "size": 5, "sha256": "2cf2…", "content_base64": "aGVsbG8=", "file_id": "…" }
```

```json
{ "type": "files_result", "id": "…", "ok": false, "code": "files_exists", "error": "… already exists; nothing is ever replaced." }
```

| `code` | Meaning |
|---|---|
| `files_no_folder` | No `--allow-dir`, so nowhere to keep files. |
| `files_refused` | A name or path outside the rules, a source outside the allowed folders, a purge outside the bin. |
| `files_exists` | The target name is taken. |
| `files_gone` | The file (or the recorded upload) is not there. |
| `files_changed` | Not a plain file any more, or its digest differs. |
| `files_too_large` | Inline content over 512 KB. |
| `files_failed` | Anything else, a digest mismatch on write included. |

`path` (absolute) is for showing to a person; `size` and `sha256` describe the file written or read (for a move or purge, `sha256` echoes the request's).

## Conversation Continuity

### The Problem

Web apps maintain conversation history as a list of messages. CLI tools maintain their own session state internally. We bridge these two models without duplicating context or losing history.

### The Solution: server-owned session resume

Each CLI maintains its own resumable session:

| Provider | Resume Command |
|----------|---------------|
| Codex    | `codex exec resume <SESSION_ID> "prompt"` |
| Claude   | `claude -p --resume <UUID> "prompt"` |
| Gemini   | `gemini -p "prompt" --resume <UUID>` |

The **server** owns the `conversation_id → cli_session_id` mapping (persisted in its database). The bridge is stateless about sessions: it does exactly what each `ai_request` tells it.

### How It Works

1. **First message** (`cli_session_id: null`): the bridge starts a fresh CLI session with the system prompt and user message; `history` (if any) is folded in as context. The CLI creates a session.

2. **Bridge reports the session id**: the resulting `cli_session_id` is returned to the server on the `done` event. The server persists it on the conversation.

3. **Subsequent messages**: the server sends the new user message with the stored `cli_session_id` (and no `history` — the session holds it). The bridge resumes that CLI session.

4. **Prompt caching**: works automatically — session resume uses each CLI's native context caching.

5. **Lost session** — see below.

### Session Lifecycle

```
Server                          Bridge                          CLI
  │                               │                              │
  │─ai_request(conv_1,msg,sess:null,history)─>│                  │
  │                               │──new session + msg─────────>│
  │                               │<─session_1 + response───────│
  │<─streaming events + done(cli_session_id: session_1)─────────│
  │  persist: conv_1 → session_1  │                              │
  │                               │                              │
  │─ai_request(conv_1,msg2,sess:session_1)──>│                   │
  │                               │──resume session_1 + msg2───>│
  │<─streaming events + done(cli_session_id: session_1)─────────│
```

### Lost session recovery (`session_lost`)

If the server sends a `cli_session_id` the bridge's CLI cannot resume (the session expired, the cache was cleared, or it was created on another machine), the bridge emits a stream `error` event with code **`session_lost`** and does **not** send `done`.

`session_lost` is recoverable, not fatal. The server:

1. Wipes the dead `cli_session_id` from the conversation.
2. Silently re-issues the **same** `request_id` as a fresh request (`cli_session_id: null`, full `history` included).
3. The browser keeps streaming on the same request — it never sees the lost session.

The re-issued turn produces its own `done` carrying a new `cli_session_id`, which the server persists. Recovery is attempted once per turn; a second failure surfaces as a normal error.

---

## Streaming Events

All AI responses are streamed as a series of events from bridge to server. The bridge normalizes different CLI output formats into this single protocol.

### Event Envelope

Every streaming event follows this structure:

```json
{
  "type": "stream",
  "request_id": "req_abc123",
  "event": "<event_type>",
  "data": {}
}
```

### Block Model

Responses consist of **blocks** — logical units of content that have explicit open and close events. This allows the server to track what's currently being generated and render it appropriately.

Block types:
- `thinking` — internal reasoning (if supported by provider)
- `text` — visible response text
- `tool_call` — a tool invocation

### Event Types

#### `block_start`

Opens a new block. The `block_index` is sequential within the response (0, 1, 2, ...).

```json
{
  "type": "stream",
  "request_id": "req_abc123",
  "event": "block_start",
  "data": {
    "block_index": 0,
    "block_type": "thinking"
  }
}
```

For `tool_call` blocks, includes the tool name and id:

```json
{
  "type": "stream",
  "request_id": "req_abc123",
  "event": "block_start",
  "data": {
    "block_index": 1,
    "block_type": "tool_call",
    "tool_name": "Bash",
    "tool_call_id": "toolu_01SXtmUHX3mr4tSyyHMNNxsv"
  }
}
```

`tool_name` is the provider's own name for the tool, **verbatim** — `Bash`, `Read`, `Edit`, or an MCP tool's full namespaced name such as `mcp__bridge__roll_dice`. It is not prettified, split or title-cased; display formatting is the consumer's decision, and a name the consumer cannot map back to the provider's own is worse than useless.

Two kinds of call arrive as `tool_call` blocks, and a consumer usually wants to treat them differently:

| Where it ran | Also arrives as |
|---|---|
| The **server** resolves it | a separate [`tool_call`](#tool-resolution-flow-cli-bridge) frame carrying parsed arguments |
| The operator's **own machine** — the CLI's shell, file reader, editor, or a tool the bridge itself runs | nothing else |

For a server-resolved tool the block is a shadow of the `tool_call` frame; render one or the other, not both. For every other call the block is the **only** record that will ever exist, and its `tool_result` the only account of what it did — dropping it is why a chat can end up able to say "4 tool calls" and nothing more.

**The `mcp__bridge__` prefix does not tell the two apart.** It says the tool was declared by the server, not that a frame is coming: a server-declared tool with `execute: "local"` runs on the bridge and reaches the model under the same prefix, with no frame of its own. A consumer that discards a prefixed block on sight therefore deletes exactly those calls and orphans their results. Keep every block, and treat one as a shadow only once the matching `tool_call` frame has actually arrived — reconciling at the end of the turn, since the order of the two is not pinned down.

`tool_call_id` pairs the call to its [`tool_result`](#tool_result).

##### Which helper a block belongs to: `parent_tool_use_id`

When the assistant hands work to a **helper** (a sub-agent — Claude's `Agent` tool), the helper's own blocks and results arrive in the same stream, interleaved with the main assistant's. `parent_tool_use_id` says which is which:

```json
{
  "type": "stream",
  "request_id": "req_abc123",
  "event": "block_start",
  "data": {
    "block_index": 3,
    "block_type": "tool_call",
    "tool_name": "Bash",
    "tool_call_id": "toolu_01Qm…",
    "parent_tool_use_id": "toolu_01A4…"
  }
}
```

- **Absent means the main assistant** — never `null`, never an empty string. That is what every block meant before the field existed, so a consumer that ignores it sees exactly the stream it always did.
- **Present** on a helper's `text`, `thinking` and `tool_call` blocks alike, and on the `tool_result` of every call the helper made. Its value is the `tool_call_id` of the `Agent` block that spawned the helper, and the `tool_use_id` of that helper's [`task`](#task) events — so a consumer can nest the helper's calls under it by identity, even when they arrive long after it started or after the main assistant has finished its reply.
- A helper's text is the helper's, not the main assistant's answer. A consumer that shows only helper summaries (from `task` `finished`) and drops helper prose is using the field as intended.
- A helper of a helper is marked with **its own** spawning call. Its `task` `started` carries `spawn_depth: 2`.
- `block_index` stays one sequence across the whole turn, main assistant and helpers together.

Carried by the Claude adapter. The Codex and Gemini adapters have no helper concept to report and never send it.

#### `block_delta`

Incremental content within an open block.

For `thinking` and `text` blocks:

```json
{
  "type": "stream",
  "request_id": "req_abc123",
  "event": "block_delta",
  "data": {
    "block_index": 0,
    "content": "Let me consider the"
  }
}
```

For `tool_call` blocks (streaming the arguments JSON):

```json
{
  "type": "stream",
  "request_id": "req_abc123",
  "event": "block_delta",
  "data": {
    "block_index": 1,
    "content": "{\"notation\": \"1d20\"}"
  }
}
```

##### Blocks do not overlap

A block's `block_start` … `block_stop` never encloses another block's. A
consumer may therefore keep a single "current block" and treat any
`block_start` as proof the previous block ended — which is what the reference
consumers do.

The bridge guarantees this even where a provider CLI does not. The Claude
adapter, for example, receives sub-agent messages whole while the main agent's
text is still streaming; it holds them back until the open block closes rather
than interleaving them.

##### How fine the deltas are

A block carries **one or many** deltas; a consumer must concatenate them and
must not assume either shape. Granularity depends on the provider CLI, and it
changes as those CLIs change:

| Provider | Granularity | Why |
|---|---|---|
| `claude` | Chunks as the model writes them | The bridge passes `--include-partial-messages` when the installed CLI supports it. Measured on Claude Code 2.1.261: a 650-word answer arrived as 31 deltas averaging ~136 characters, against 1 delta before. |
| `gemini` | Chunks as the model writes them | The CLI's `stream-json` output is delta-based already. |
| `codex` | One delta per block | `codex exec --json` reports `item.completed`, which by definition fires once the item is finished. Nothing finer is available on the event schema the adapter consumes. |

Claude's `tool_call` blocks are the deliberate exception: the CLI streams
tool arguments as JSON fragments, and the bridge reassembles them into a
single delta carrying the complete arguments object. Individual fragments are
not valid JSON, so forwarding them would break any consumer that parses a
delta on arrival — and there is nothing to gain, since arguments are rendered
as a unit rather than read as they are typed.

An older Claude CLI that does not offer `--include-partial-messages` falls
back to one delta per block. That is a difference in smoothness only: the
events, their order, and the reassembled text are identical.

#### `block_stop`

Closes a block. No further deltas for this `block_index` will be sent.

```json
{
  "type": "stream",
  "request_id": "req_abc123",
  "event": "block_stop",
  "data": {
    "block_index": 0
  }
}
```

#### `tool_result`

What a tool returned. Emitted for **both** kinds of tool call:

- a tool the **server** resolved (see [Tool Calls](#tool-calls)), acknowledged before generation continues;
- a tool that ran on the **operator's own machine** — the CLI's shell, file reader, editor. The server never sees these run, so this event is the only account of what they did.

```json
{
  "type": "stream",
  "request_id": "req_abc123",
  "event": "tool_result",
  "data": {
    "tool_call_id": "toolu_01SXtmUHX3mr4tSyyHMNNxsv",
    "result": "hello",
    "is_error": false
  }
}
```

`tool_call_id` is the same id carried on the matching `tool_call` block's `block_start`, so a consumer can pair a result to the call that produced it.

`parent_tool_use_id` is present when the call was a helper's, exactly as on the call's `block_start` (see [Which helper a block belongs to](#which-helper-a-block-belongs-to-parent_tool_use_id)), and rides on every chunk of a chunked result.

`is_error` is the authoritative failure signal, and is **absent when the provider did not report one** — absent never means "succeeded". Do not infer failure from the text: a tool legitimately printing `Error: no matches` is indistinguishable from one that failed. (For historical reasons the Codex and Gemini adapters additionally prefix `Error: ` onto a failed result; that prefix is not a substitute for the field.)

##### Chunked results

A result larger than one frame arrives **in pieces**, keyed by `tool_call_id`:

```json
{
  "type": "stream",
  "request_id": "req_abc123",
  "event": "tool_result",
  "data": {
    "tool_call_id": "toolu_01SXtmUHX3mr4tSyyHMNNxsv",
    "result": "…the first 256 KB…",
    "chunk_index": 0,
    "final": false,
    "is_error": false
  }
}
```

- **`chunk_index`** — 0-based, ascending, one sequence per `tool_call_id`. Two calls can chunk at the same time, so a consumer must key its buffer by the call id and not by arrival order.
- **`final`** — `true` on the last chunk and only then. Concatenate `result` in index order; the join is exact, with no separator.
- **`truncated_bytes`** — on the final chunk only, and only when the whole result exceeded the 16 MB ceiling below. It names how many bytes were dropped.

**A result that fits in one frame carries neither `chunk_index` nor `final`** — the shape this event has always had. Chunk fields appear only where a result would previously have been truncated, so a consumer written before chunking existed sees no change to anything it could already receive.

If the stream ends before a `final` chunk arrives, keep what you have and mark it partial. Discarding it loses the only account of what the tool did, which is the thing this event exists to carry.

**Size.** Three ceilings:

- A **single frame's result** holds at most 256 KB of JSON-encoded bytes. Longer results are chunked, not cut.
- A **whole result**, across all its chunks, is bounded at **16 MB of JSON-encoded bytes** — the wire cost, which is what the receiver has to hold. Past that the final chunk carries `truncated_bytes` (counting the raw content bytes dropped) and a marker. There has to be some limit: the reassembling side holds every chunk until the result completes, so an unbounded result is an unbounded allocation on a machine that did not choose to make it.
- A **`tool_call` block's arguments** are bounded at **64 KB** — the same number the reference server caps them at, so that two truncations cannot compose and destroy each other's evidence. Arguments are not chunked; they are bounded by structure, below.

A consumer that **stores** results has its own decision to make, separate from the transport, and needs more than one bound. The reference server keeps a reassembled result whole in the live stream and, before writing to the transcript, applies:

| Bound | Value | Why |
|---|---|---|
| one stored result | 1 MB | a `cat` of a large file should not dominate a row |
| one turn's blocks — **results and arguments together** | 8 MB | bounding results alone bounds nothing: the number of tool calls is the model's choice, and 200 calls at 64 KB of arguments is 12 MB on its own |
| one turn's **prose** (text and thinking) | 4 MB, budgeted separately | it grows delta by delta with no ceiling of its own and shares the row; kept apart from tool output because an answer is what a reader came for, and cutting it to make room for a `cat` is the wrong trade |
| one assembling result | 16 MB | held in memory until its final chunk arrives |
| all assembling results at once | 32 MB | the sender picks the `tool_call_id` each buffer is keyed by, so the count is not the receiver's to choose |
| results assembling at once | 64 | as above, for the number of buffers rather than their size |

None of that is the protocol's business, but the reasoning is worth stating: a database write that is too large tends to fail as a whole row, and a turn's prose is in the same row as its tool results. Losing the entire assistant message to one large `cat` is a worse outcome than a marked truncation.

Three consequences a consumer should copy. **Spend a turn budget, do not zero it** — cutting one result must not make every later result in the turn store empty. **Say which bound was reached**: "this result was too large" is false about a small result that merely arrived after the budget was gone, and sends a reader at the wrong thing. And **never replace content with a longer notice** — past the budget a truncation marker is bigger than a short result, so swapping one for the other grows the row it exists to shrink.

That last rule makes a turn budget a target rather than a hard ceiling: once it is spent, short blocks are kept whole and the total can drift past it by up to a marker's length per block. The alternative is storing an empty result, which renders as "the tool returned nothing" — a false statement about a call that produced output. The reference server takes the drift and measures it: under 30 KB across a 500-call turn, against a `max_allowed_packet` counted in megabytes.

Arguments are bounded by **structure**, not by cutting the text. Every key survives that can, and only values too large to carry are replaced, by an object saying what was there:

```json
{ "file_path": "/etc/hosts", "content": { "__truncated__": { "bytes": 2000002, "head": "127.0.0.1 …" } } }
```

That keeps the result valid JSON. Cutting the encoded text instead makes it stop parsing, and a consumer then loses *every* argument — including the twenty-byte `file_path` that says what the call actually did. When breadth rather than size is the problem, the entries that fit are kept and a `__truncated__` key reports how many were not; if the input already uses that name, a free variant is chosen instead.

None of this is squeamishness about size: an oversized frame is not delivered-and-ignored, it is answered with a `CLOSE_TOO_BIG` that tears down the WebSocket connection and every in-flight request on it. A marked truncation is what a consumer can act on.

Binary parts — an image or audio block, an MCP embedded resource carrying a base64 blob — are replaced by a short description of their kind and size rather than inlined. A screenshot is around 600,000 characters of base64: unreadable as output, and two of them exceed the frame cap on their own. A file the assistant means to hand back has its own route in the [`attachment`](#attachment) event.

#### `rate_limit`

The provider's own rate-limit status, forwarded as the CLI reports it. **Informational and non-terminal** — the turn continues, and a consumer that treats this as an error will abort a perfectly healthy turn.

```json
{
  "type": "stream",
  "request_id": "req_abc123",
  "event": "rate_limit",
  "data": {
    "provider": "claude",
    "info": { "status": "allowed", "rateLimitType": "five_hour", "resetsAt": 1788991200 }
  }
}
```


`info` is the provider's own shape, passed through unchanged rather than normalised — its contents differ per provider and are expected to change. Carried so a server can show what the operator's CLI already knows, instead of discovering a limit by hitting it.

#### `task`

The life of a **helper** the CLI runs for the main assistant: a sub-agent, or a background shell command. **Informational and non-terminal**, like `rate_limit`. Blocks say what a helper *did*; this says what it *is* — its kind, whether the main assistant waits for it, what it has spent, whether it is still alive, and how it ended.

```json
{
  "type": "stream",
  "request_id": "req_abc123",
  "event": "task",
  "data": {
    "phase": "started",
    "task_id": "af2e05936428f6e8e",
    "tool_use_id": "toolu_018UGfE8HLBqgFmXMDrzDgD5",
    "task_type": "local_agent",
    "subagent_type": "general-purpose",
    "description": "Run the migration dry-run",
    "spawn_depth": 1,
    "is_backgrounded": true
  }
}
```

`phase` is a string, one of:

| Phase | When | Fields beside `task_id`, `tool_use_id` and `task_type` |
|---|---|---|
| `started` | The helper was started. | `subagent_type`, `description`, `spawn_depth`, `is_backgrounded` |
| `progress` | The helper moved on to another step. | `description` (what it is doing now), `subagent_type`, `last_tool_name`, `usage` |
| `heartbeat` | Every ~30 s while the main assistant is **blocked waiting** on the helper. | `elapsed_seconds` |
| `updated` | The helper's state changed. | `status` |
| `finished` | The helper ended. | `status`, `summary`, `usage`, `subagent_type`, `description` |

```json
{ "phase": "progress",  "task_id": "af2e…", "tool_use_id": "toolu_018U…", "subagent_type": "general-purpose",
  "description": "Running php artisan migrate --pretend", "last_tool_name": "Bash",
  "usage": { "total_tokens": 23921, "tool_uses": 1, "duration_ms": 2976 } }
{ "phase": "heartbeat", "task_id": "ad5d…", "tool_use_id": "toolu_01A4…", "elapsed_seconds": 60 }
{ "phase": "updated",   "task_id": "af2e…", "tool_use_id": "toolu_018U…", "status": "completed" }
{ "phase": "finished",  "task_id": "af2e…", "tool_use_id": "toolu_018U…", "status": "completed",
  "summary": "The dry-run lists 3 pending migrations…",
  "usage": { "total_tokens": 24742, "tool_uses": 1, "duration_ms": 45887 } }
```

- **`tool_use_id` is the key to group by.** It is the `tool_call_id` of the block that spawned the helper, and the `parent_tool_use_id` on the helper's own blocks. The CLI omits it on some phases; the bridge fills it in from the task's `started`. `task_id` is the CLI's own id and is present on every phase. `task_type` is repeated on every phase too, though the CLI names it only at `started`.
- **Every task a consumer sees was introduced by a `started`** in the same turn. On a resumed session the CLI first reports on work an *earlier* turn left running; those reports are not forwarded, because they are not helpers of this turn.
- **A helper is finished only when `finished` says so.** Not when its spawning call's `tool_result` arrives, and not when the main assistant's reply ends: a background helper's spawning call returns at once ("launched"), and the helper keeps working — and keeps sending `task` events and blocks — after the main assistant has written its whole answer. `done` still comes last.
- **The end of the request ends every task.** `done`, a stream `error`, or `cancelled` for this `request_id` ends every task of that request, whatever phase it last reported. Most endings that cut a turn short send no `finished` at all — a stop, a silence or request timeout, a CLI that crashed, a `result` while a background shell was still running — so a consumer that waits for `finished` alone keeps a helper spinning forever after a stopped turn. Close them all on the terminal frame; show them as ended with the request, not as `completed`.
- **`is_backgrounded`** says whether the main assistant waits. `false`: it is blocked inside the spawning call until the helper finishes, and `heartbeat`s arrive meanwhile. `true`: it is free to reply while the helper works; the CLI sends no heartbeat for such a helper, so `progress` and the helper's own blocks are its only signs of life.
- **`task_type`** is the CLI's word for what the task is: `local_agent` for a helper, `local_bash` for a shell command run as a task — including one a helper runs for itself, whose `tool_use_id` is then the helper's call, not the main assistant's. Show `local_agent` tasks as helpers; do not assume the list is closed.
- **`elapsed_seconds`** comes from the CLI's own clock, counted from the spawning call. Two buffers can sit between the bridge and a browser, and neither preserves timing, so compute nothing from arrival times.
- **`status`** is the CLI's own word — `completed`, `failed`, `stopped`, `killed` have been seen.
- **`usage`** is the helper's running total: `total_tokens`, `tool_uses`, `duration_ms`, each present when the CLI reported it.
- **`summary`** is the helper's closing report, meant to be shown. It is bounded to **8 KB** (JSON-encoded), cut on a character boundary and ending in a `…[truncated by the bridge: showing N of M characters]` marker when cut. `description` has the same bound.
- **The helper's instructions are never sent.** The CLI reports the helper's whole prompt at `started`; it is the largest frame in the family, and a non-terminal frame over the frame cap is not trimmed: the bridge sends a `frame_too_large` stream `error` in its place, which ends the turn. Forwarding the prompt would put the whole turn at risk. `description` is what a person reads. Local file paths the CLI reports (the helper's output file) are not forwarded either.
- A `task` event counts as activity for the bridge's silence bound, like every other event. A helper busy in one long step keeps a turn alive through its heartbeats.

Carried by the Claude adapter; Codex and Gemini never send it. A consumer that does not know the event ignores it.

On a turn with its input open, the bridge counts tasks from `started` to `finished` to decide when the turn is over — see [`accepts_input`](#additive-option-accepts_input--a-turn-that-takes-messages-while-it-runs).

#### `user_input`

On a turn with its input open: the assistant has just taken in a message the bridge accepted as [`turn_input`](#server--bridge-turn_input).

```json
{ "type": "stream", "request_id": "req_abc123", "event": "user_input", "data": { "message_id": "msg_42" } }
```

Sent when the CLI echoes the message back (`--replay-user-messages`), which it does at the moment it dequeues it — so everything after this event is the assistant's response to it, or later. Messages are read in the order they were accepted. The opening message's echo is not reported.

#### `main_state`

On a turn with its input open: whether the **main** assistant (not a helper) is working or free.

```json
{ "type": "stream", "request_id": "req_abc123", "event": "main_state", "data": { "state": "idle" } }
```

- `working` — once at the start of the turn, right after the ack; again whenever the main assistant takes in a message (right after its `user_input`), starts a turn of the CLI's own (answering a finished background task), or writes again after having been idle.
- `idle` — when the main assistant's message ends (`stop_reason` other than `tool_use`), or a `result` arrives.
- Never sent twice in a row with the same state.

A message sent while it is `idle` is read straight away; one sent while it is `working` is read after its current step. `idle` is not the end of the turn: background tasks may still be running, and the turn goes on until they end.

`idle` is never sent before the main assistant has taken in the opening message: a `result` the CLI writes for work of its own ahead of it (one with an `origin`) leaves the state `working`.

#### `input_closed`

On a turn with its input open: the bridge has closed the CLI's input, and the turn takes no more messages. Advertised by `hello.input_closed`.

```json
{ "type": "stream", "request_id": "req_abc123", "event": "input_closed", "data": { "reason": "idle" } }
```

- Sent when the terminal rule closes the input (see [`accepts_input`](#additive-option-accepts_input--a-turn-that-takes-messages-while-it-runs)), while the turn is still running — the CLI then finishes what it has and exits, and `done` follows. That gap is usually short, but it is not bounded by anything the bridge controls.
- At most once per turn, and never after the turn's terminal frame. A turn that ends any other way — a `cancel`, a bound, a dropped connection, a CLI that exits or crashes with its input still open — does not send it.
- **`reason`**: one of
  - `idle` — the main assistant has taken in the opening message and is idle, no task it or a helper started is running, and every accepted `turn_input` has been read.
  - `leftovers_silent` — the silence bound ran out while the main assistant had answered (idle, every accepted `turn_input` read) and the only tasks still running were commands left behind by helpers that have all finished. Instead of stopping the turn as `silence_timeout_exceeded`, the bridge closes the input; the CLI stops those commands itself (`task_updated` `killed`, `task_notification` `stopped`) and exits, and the turn ends with an ordinary `done`, no `error`. Carries **`stopped_tasks`**, how many such commands were stopped, so a server can say so beside the finished answer. A command whose output kept growing was not silent, so it was never stopped this way. If the CLI then does not exit, the bound fires on its next run-out and ends the turn as before.

  **A server must accept a reason it does not know** and treat it the same way.
- Every `turn_input` after it is answered `turn_ending`: hold the message until the request's terminal frame, then start a new turn with it. A server can stop offering at this event rather than learn it from the ack.

Like every stream event it counts as activity for the silence bound.

#### `attachment`

A file the assistant produced and chose to hand back. Emitted when the model calls the bridge-owned `bridge__attach_file` tool and the upload succeeded.

```json
{
  "type": "stream",
  "request_id": "req_abc123",
  "event": "attachment",
  "data": {
    "id": "att_new123",
    "name": "report.md",
    "mime_type": "text/markdown",
    "size": 4096,
    "description": "The migration report you asked for"
  }
}
```

`id` is the identifier the server assigned when the bridge uploaded the file to `POST /ai-bridge/attachments`, so the UI can render it from the server's own attachment store. A server that does not understand the event ignores it.

In `device` mode (`welcome.config.attachments: "device"`) nothing is uploaded: `id` is null, and the event carries `path` (for showing) and `file_id`, the id the bridge recorded the file under. The server fetches it later with [`file_read`](#handing-files-back), never by `path`.

The tool is offered in `workspace` and `native` only. In `isolated` the CLI reaches server-declared tools and nothing else.

The model has to nominate the file, and that is not a limitation to work around: a transport cannot guess which of the hundred files a turn just touched is the answer. The path it names must resolve — **after `realpath`, because in `workspace` mode the model has a shell and can create a symlink** — inside the working directory or that turn's attachment directory, and it is subject to the same per-file cap and the same host binding as the inbound direction.

#### `done`

Signals the end of the AI response. No more events for this `request_id`.

```json
{
  "type": "stream",
  "request_id": "req_abc123",
  "event": "done",
  "data": {
    "usage": {
      "input_tokens": 6,
      "output_tokens": 183,
      "cache_creation_input_tokens": 5429,
      "cache_read_input_tokens": 66013
    },
    "model": "claude-sonnet-5",
    "provider_version": "2.1.261",
    "stop_reason": "end_turn",
    "cost_usd": 0.0377526,
    "duration_ms": 7034,
    "duration_api_ms": 7597,
    "num_turns": 3,
    "subtype": "success",
    "permission_denials": [],
    "cli_session_id": "session_def456"
  }
}
```

`usage` is optional — not all CLIs report token counts.

**The cache counts are not a detail.** On a resumed conversation they dominate: the example above is a real turn that read 66,013 cached tokens against six new input tokens. A consumer showing only `input_tokens` and `output_tokens` understates the turn by orders of magnitude and cannot reconcile its own numbers with the provider's bill.

Everything beside `usage` is likewise provider-reported and optional. **Absent means the CLI did not say — never that the value was zero.** The bridge forwards what it is given rather than deciding what a server ought to care about:

| Field | What it is |
|---|---|
| `model` | The model that actually ran, resolved from whatever alias was requested. A server asking for `sonnet` learns here what that became. |
| `provider_version` | Version of the provider CLI that ran the turn. |
| `stop_reason` | Why the model stopped — `end_turn`, `max_tokens`, and so on. |
| `cost_usd` | What the provider says the turn cost. |
| `duration_ms` / `duration_api_ms` | Wall-clock duration of the turn, and of the API portion. |
| `num_turns` | How many assistant turns the CLI took internally to answer. |
| `subtype` | How the CLI itself classified the end of the turn — `success`, `error_during_execution`, `error_max_turns`. Worth showing when a turn arrives with no text at all: `stop_reason` is null on several of those paths, so this is the only thing that says what happened. |
| `permission_denials` | Tool calls the CLI's own permission system refused. In `isolated` this is the record of what the posture actually stopped — an empty answer with three denials reads very differently from an empty answer with none. |
| `pending_inputs` | Turn with its input open only, and only when non-empty: accepted `turn_input` messages the assistant never read because the turn ended first (a timeout, a crash). A turn that ends normally has none, by the ending rule. |
| `subagent_stats` | What the turn spent on helpers, in the CLI's own shape: `spawned`, `completed`, `failed`, `started_in_background`, `max_depth`, `by_type{}`, `killed{}`, `refused{}` and so on. Passed through unchanged. Tokens per helper come from the [`task`](#task) events. |

`cli_session_id` is the CLI session this turn ran under — the id created on a fresh start, or the id resumed. The server persists it on the conversation so the next turn can resume. Absent/`null` when no session id was produced.

#### `error`

An error occurred during generation.

```json
{
  "type": "stream",
  "request_id": "req_abc123",
  "event": "error",
  "data": {
    "code": "provider_error",
    "message": "Claude CLI exited with code 1: Rate limit exceeded"
  }
}
```

Notable `code` values:

- **`session_lost`** — the request asked to resume a `cli_session_id` the CLI could not find. Recoverable: the server wipes the stored session and silently re-issues the turn fresh (see [Lost session recovery](#lost-session-recovery-session_lost)). No `done` follows a `session_lost`.
- **`provider_error`** — a generic CLI/provider failure. Terminal; surfaced to the user.

### Example: Full Response Flow

A typical response with thinking, text, and a tool call:

```
→ block_start   {block_index: 0, block_type: "thinking"}
→ block_delta   {block_index: 0, content: "The player wants to attack..."}
→ block_delta   {block_index: 0, content: " I should ask for an attack roll."}
→ block_stop    {block_index: 0}
→ block_start   {block_index: 1, block_type: "text"}
→ block_delta   {block_index: 1, content: "You swing your sword at the goblin! "}
→ block_delta   {block_index: 1, content: "Let me roll for your attack..."}
→ block_stop    {block_index: 1}
→ block_start   {block_index: 2, block_type: "tool_call", tool_name: "roll_dice", tool_call_id: "tc_001"}
→ block_delta   {block_index: 2, content: "{\"notation\": \"1d20+5\"}"}
→ block_stop    {block_index: 2}
                                        ← tool_resolve (tc_001, result: "18")
→ tool_result   {tool_call_id: "tc_001", result: "18"}
→ block_start   {block_index: 3, block_type: "text"}
→ block_delta   {block_index: 3, content: "Your blade strikes true! With an 18, you hit the goblin..."}
→ block_stop    {block_index: 3}
→ done          {usage: {input_tokens: 850, output_tokens: 120}}
```

---

## Tool Calls

Tools allow the AI to invoke server-side functions (dice rolls, rule lookups, database queries, etc.) during a response. Tool definitions are dynamic — sent from server to bridge during the handshake.

### How Tools Work Per Mode

#### CLI Bridge Mode

CLI tools have varying levels of native tool support:
- **Codex**: Supports tools natively via MCP servers (`codex exec` with `--mcp-server`)
- **Claude**: Supports tools via `--allowedTools` and MCP, or via Bash tool
- **Gemini**: Tools via Bash approach

**Universal approach (Bash fallback)**: The bridge generates a temporary Bash script for each tool that, when called by the CLI, sends the tool call back through the WebSocket and waits for the result.

```bash
#!/bin/bash
# Auto-generated by ai-bridge for tool: roll_dice
# Sends tool call through WebSocket and blocks until result
ARGS="$1"
RESULT=$(ai-bridge-tool-call "roll_dice" "$ARGS")
echo "$RESULT"
```

The `ai-bridge-tool-call` helper is a small utility bundled with the bridge that:
1. Sends the tool call to the server via the existing WebSocket
2. Blocks until the server responds with the result
3. Prints the result to stdout for the CLI to consume

**Codex MCP approach**: For Codex specifically, the bridge can start an in-process MCP server that exposes the server's tools as MCP tools. This is more elegant but Codex-specific.

#### BYOK / Managed Mode

No bridge involved. The server calls the Chat Completions API directly. Tools are passed as the `tools` parameter in the API request. When the API returns a `tool_calls` response, the server executes the tools locally and sends the results back in the next API call. Standard Chat Completions tool calling flow.

### Tool Resolution Flow (CLI Bridge)

```
Server                          Bridge                          CLI
  │                               │                              │
  │                               │                              │
  │                               │   CLI calls bash tool ←──────│
  │                               │                              │
  │<──tool_call (roll_dice, {})──│   (bridge intercepts)        │
  │                               │                              │
  │   execute roll_dice locally   │                              │
  │                               │                              │
  │──tool_resolve (result: 18)──>│                              │
  │                               │   return "18" to CLI ───────>│
  │                               │                              │
```

### Server → Bridge: `tool_resolve`

After the server executes a tool, it sends the result back:

```json
{
  "type": "tool_resolve",
  "request_id": "req_abc123",
  "tool_call_id": "tc_001",
  "result": "You rolled a 17 (1d20+5: natural 12 + 5)"
}
```

### Server → Bridge: `tool_error`

If a tool execution fails:

```json
{
  "type": "tool_error",
  "request_id": "req_abc123",
  "tool_call_id": "tc_001",
  "error": "Unknown dice notation: 2z6"
}
```

The bridge passes this error back to the CLI, which typically incorporates it into its response ("I'm sorry, I made a mistake with the dice notation...").

---

## MCP Apps

[MCP Apps](https://github.com/modelcontextprotocol/ext-apps) (ext-apps, spec
revision `2026-01-26`): a tool definition names a view in
`_meta.ui.resourceUri` (a `ui://` resource, `text/html;profile=mcp-app`), and the
web application draws that view as the **host**, in a sandboxed frame, next to
the call that produced it. The bridge carries what the host needs; it never
renders anything.

There are two sources of tools with views:

- **The server's own tools** (from `welcome.tools`). The server already knows
  each definition; the bridge only has to let the CLI see `_meta` and tell the
  server which stream call a `tool_call` is.
- **Upstream MCP servers** the person running the bridge configured with
  `--mcp-upstreams` (see [docs/mcp-upstreams.md](docs/mcp-upstreams.md)). The
  bridge is their MCP client, so only it sees their definitions: it tells the
  server which call has a view (`tool_result.ui`) and relays the view's own
  requests (`mcp_request` / `mcp_result`). A server cannot add an upstream.

### Handshake: `hello.mcp_apps`

```json
{ "type": "hello", "...": "...", "mcp_apps": { "spec": "2026-01-26", "revision": 1 } }
```

`spec` is the ext-apps revision implemented; `revision` the revision of the
bridge's own frames below, bumped whenever one of them changes shape. A bridge
without the field predates MCP Apps: a server must not send it `mcp_request`
(it would be logged as unknown and never answered) and should tell the person
to update the bridge. Bridges follow the server's version by themselves
([`desired_bridge_version`](#desired_bridge_version)), so the expected fix is a
`desired_bridge_version` at or above the first release with `mcp_apps`.

### Server tools: `_meta` and `provider_tool_call_id`

- A `welcome.tools[]` definition may carry `_meta` (any JSON object). The bridge
  passes it **unchanged** to the CLI's `tools/list`, so `ui.resourceUri` and
  `ui.visibility` reach a CLI that hosts views itself.
- A `tool_call` frame carries `provider_tool_call_id` when the CLI sent its own
  id for the call (Claude Code: `_meta["claudecode/toolUseId"]` on
  `tools/call`). It is the id the stream later names as
  `tool_result.tool_call_id` (and the `tool_call` block's id), so the server can
  join the call it is running to the call it sees in the stream. Absent when the
  CLI sent none (Codex, Gemini): such a call cannot be given a view.

```json
{ "type": "tool_call", "request_id": "req_1", "tool_call_id": "tc_9", "tool_name": "approve",
  "arguments": {}, "provider_tool_call_id": "toolu_01AbC" }
```

### Upstream tools: names, visibility and what the model gets

- Offered to the CLI as `<server>__<tool>` beside the server's tools, with their
  `_meta`, in `workspace` isolation only (like `bridge__attach_file`, they are
  the machine's own; an `isolated` CLI never sees them). They run on the
  bridge and **never** produce a `tool_call` frame.
- `_meta.ui.visibility` (default `["model", "app"]`): a tool without `"model"`
  is not offered to the CLI and is refused if called by name; a tool without
  `"app"` is refused to a view.
- The model gets the text content only (or the JSON of `structuredContent` when
  there is no text). The whole `CallToolResult` goes to the host in
  `tool_result.ui.result`, never into the turn.
- Every secret the upstream's config resolved (see
  [docs/mcp-upstreams.md](docs/mcp-upstreams.md)) is redacted from what goes
  out: model text, `ui.result`, `mcp_result` and error messages.

### `tool_result.ui`

On the **first** `tool_result` stream event of a call to an upstream tool whose
definition names a view (and only when the CLI sent its call id):

```json
{ "type": "stream", "request_id": "req_1", "event": "tool_result", "data": {
  "tool_call_id": "toolu_01AbC", "content": "Shown 3",
  "ui": {
    "server": "weather",
    "tool_name": "show_forecast",
    "resource_uri": "ui://weather/view.html",
    "arguments": { "city": "Utrecht" },
    "result": { "content": [{ "type": "text", "text": "Shown 3" }], "structuredContent": { "...": "..." }, "_meta": {} }
  } } }
```

`server` is the name to put in `mcp_request.server`; `tool_name` the tool's own
name on that server (no prefix); `arguments` what the model passed; `result`
the whole `CallToolResult`. The host sends the view `ui/notifications/tool-input`
with `arguments` and `ui/notifications/tool-result` with `result`. Later chunks
of the same call carry no `ui`. A view not taken within 10 minutes (a CLI that
never reported the result) is dropped.

### Server → Bridge: `mcp_request`

A view's request, relayed by the host on behalf of the person looking at it.

```json
{ "type": "mcp_request", "id": "m_1", "server": "weather", "method": "resources/read", "params": { "uri": "ui://weather/view.html" } }
{ "type": "mcp_request", "id": "m_2", "server": "weather", "method": "tools/call", "params": { "name": "refresh", "arguments": { "city": "Utrecht" } } }
```

| Field | Meaning |
|-------|---------|
| `id` | Chosen by the server; echoed on the answer. Required. |
| `server` | The upstream, as `tool_result.ui.server` named it. |
| `method` | `resources/read` (a `ui://` uri only) or `tools/call` (a tool whose visibility includes `"app"`). Nothing else is relayed. |
| `params` | The MCP params of that method, unchanged. |

### Bridge → Server: `mcp_result`

Exactly one per `mcp_request`, with the same `id`: a `result`, or an `error`
with a `code`.

```json
{ "type": "mcp_result", "id": "m_1", "result": { "contents": [ {
  "uri": "ui://weather/view.html", "mimeType": "text/html;profile=mcp-app", "text": "<!doctype html>...",
  "_meta": { "ui": { "csp": { "connectDomains": ["https://api.weather.example"], "resourceDomains": ["https://cdn.example"] },
                     "permissions": { "geolocation": {} }, "domain": "...", "prefersBorder": true } } } ] } }
{ "type": "mcp_result", "id": "m_2", "error": "refresh is not callable from a view", "code": "refused" }
```

`result` is the upstream's MCP result **unchanged** (apart from secret
redaction). For `resources/read` that includes each content item's
`_meta.ui` — `csp` (`connectDomains`, `resourceDomains`, `frameDomains`,
`baseUriDomains`), `permissions` (`camera`, `microphone`, `geolocation`,
`clipboardWrite`), `domain`, `prefersBorder` — exactly as the server declared
them, so the host can show them to the person and ask for consent before
widening the frame's CSP or `allow`. When a content item carries no `_meta.ui`,
the bridge puts there the `_meta.ui` of that uri's `resources/list` entry: the
spec's fallback, done once here so the host needs no second request. The bridge
never grants, filters or rewrites a declaration; deciding is the host's.

| `code` | Meaning |
|--------|---------|
| `unknown_server` | No upstream of that name on this bridge (or none at all). |
| `unavailable` | Configured but not connected, and connecting now failed (process will not start, unreachable URL, a secret that could not be resolved). Retried in the background. |
| `timeout` | The upstream did not answer within its `timeout_ms` (default 60 s). |
| `refused` | Not something a view may do: a non-`ui://` uri, an unknown tool, a tool whose visibility leaves out `"app"`. |
| `unsupported` | A method the bridge does not relay. |
| `upstream_error` | The upstream answered with an error, or its connection broke mid-request (it is then reconnected). |

A view's tools/call runs on the machine whose bridge made the original call; if
that bridge is gone, the server has nobody to relay to.

---

## Upstream sign-in (OAuth)

An [upstream MCP server](#mcp-apps) that requires OAuth (the MCP authorization
spec: RFC 9728 protected resource metadata, RFC 8414 / OIDC discovery, RFC 7591
dynamic client registration, PKCE S256, RFC 8707 `resource`) can be used through
the bridge the way claude.ai uses a custom connector. The person signs in once
in their browser; the bridge holds and refreshes the tokens; the web
application only relays the one-time code and never sees a token.

**Why the code goes through the server.** The bridge usually runs on a machine
the person is not sitting at, so a `localhost` redirect cannot work. The
redirect goes to the web application, which the person's browser can reach, and
the web application passes the code to the bridge over this WebSocket. Only the
bridge holds the PKCE verifier, so only the bridge can turn the code into
tokens.

The operator opts an upstream in, in the `--mcp-upstreams` file
([docs/mcp-upstreams.md](docs/mcp-upstreams.md)):

```json
{ "mcpServers": {
  "kaizen": { "url": "https://kaizen.example/mcp", "auth": "oauth",
              "oauth": { "scope": "optional space-separated scopes", "client_name": "optional, default 'AI Bridge'" } }
} }
```

`auth` is `"oauth"` or absent; `"oauth"` only with `url`, never with an
`Authorization` header, and `oauth` takes no keys but these two. Anything else
stops the bridge at start.

### Handshake: `hello.mcp_upstream_auth`

```json
{ "type": "hello", "...": "...", "mcp_upstream_auth": { "revision": 1 } }
```

Present when the bridge implements everything in this section, whether or not
it has OAuth upstreams. A server must not send `upstream_auth_start`,
`upstream_auth_code` or `upstream_auth_forget` to a bridge without it.

### Handshake: `welcome.upstream_oauth`

```json
{ "type": "welcome", "...": "...", "upstream_oauth": { "redirect_uri": "https://app.example/ai-bridge/upstream-oauth/callback" } }
```

The absolute `http(s)` URL the authorization server sends the browser back to,
used exactly as sent (it is registered and compared character for character).
Absent (or not an absolute http(s) URL): the bridge cannot sign in to any OAuth
upstream through this server; those upstreams report `needs_auth` with
`error: "no_redirect_uri"`, and no `upstream_auth_required` is sent.

### Bridge → Server: `upstream_status`

Sent once after `welcome` (by a bridge with upstreams configured), and again
whenever any upstream's state, auth or tool count changes. Always the complete
list.

```json
{ "type": "upstream_status", "upstreams": [
  { "server": "kaizen", "transport": "http", "origin": "https://kaizen.example", "auth": "oauth",
    "state": "needs_auth", "tools": 0, "error": "no_token" },
  { "server": "weather", "transport": "stdio", "origin": null, "auth": "secrets",
    "state": "connected", "tools": 3, "error": null }
] }
```

| Field | Values |
|---|---|
| `transport` | `http` or `stdio` |
| `origin` | For http: scheme + host + port only, never a path or query. For stdio: null. |
| `auth` | `none`, `secrets` (env/headers resolved from env or vault), or `oauth` |
| `state` | `connecting`, `connected`, `needs_auth`, or `unavailable` |
| `tools` | The number offered (0 unless connected) |
| `error` | A short machine code or message when `unavailable` or `needs_auth`, else null. Never contains a secret. |

For `needs_auth`, `error` is a machine code: `no_token`, `refresh_failed`,
`rejected`, `no_redirect_uri`, or the `code` of the last failed sign-in
(`denied`, `discovery_failed`, `registration_failed`, `exchange_failed`,
`issuer_mismatch`). For `unavailable` it is the connection error, redacted.

### Bridge → Server: `upstream_auth_required`

```json
{ "type": "upstream_auth_required", "server": "kaizen", "state": "Xb3…",
  "authorization_url": "https://kaizen.example/oauth/authorize?response_type=code&client_id=…&redirect_uri=…&code_challenge=…&code_challenge_method=S256&state=Xb3…&resource=…",
  "expires_at": "2026-10-16T18:10:00Z", "reason": "no_token" }
```

Open `authorization_url` in the person's browser (or show them a "Connect
kaizen" link to it).

- `reason`: `no_token`, `refresh_failed`, `rejected` (the upstream answered 401
  to a token it had issued), or `requested` (answering `upstream_auth_start`).
- **When it is sent:** when an OAuth upstream has no usable token at connect,
  once per connection to this server; when refreshing fails, or the upstream
  rejects the token; in answer to `upstream_auth_start`.
- **`state`:** 32 random bytes, base64url. At most one sign-in is pending per
  upstream, so a new one invalidates the previous `state`. A `state` expires
  after 10 minutes (`expires_at`, UTC) and can be used once.
- **Before it is sent** the bridge has done discovery and client registration.
  A failure there is reported as `upstream_auth_result` with `ok: false` and
  `state: null` instead.

### Server → Bridge: `upstream_auth_start`

```json
{ "type": "upstream_auth_start", "server": "kaizen" }
```

The person asked to (re)connect. Answered with `upstream_auth_required`
(`reason: "requested"`), or with `upstream_auth_result` `ok: false`
(`unknown_server`, `not_oauth`, `no_redirect_uri`, `discovery_failed`,
`registration_failed`).

### Server → Bridge: `upstream_auth_code`

```json
{ "type": "upstream_auth_code", "server": "kaizen", "state": "Xb3…", "code": "def50200…", "iss": "https://kaizen.example" }
{ "type": "upstream_auth_code", "server": "kaizen", "state": "Xb3…", "error": "access_denied", "error_description": "The user denied the request" }
```

The query parameters of the redirect, passed on as they are. `iss` is optional
(RFC 9207). The bridge checks it when the authorization server's metadata says
it sends `iss` (`authorization_response_iss_parameter_supported`), and whenever
it is present: it must equal the metadata's `issuer`.

### Bridge → Server: `upstream_auth_result`

Exactly one per `upstream_auth_code`, and also the failure answer to
`upstream_auth_start` (and to a sign-in the bridge could not prepare by itself).

```json
{ "type": "upstream_auth_result", "server": "kaizen", "state": "Xb3…", "ok": true }
{ "type": "upstream_auth_result", "server": "kaizen", "state": "Xb3…", "ok": false, "code": "unknown_state", "error": "This sign-in link expired or was replaced by a newer one." }
```

| `code` | Meaning |
|---|---|
| `unknown_server` | No upstream of that name on this bridge (or none at all). |
| `not_oauth` | The upstream is not configured with `"auth": "oauth"`. |
| `unknown_state` | The `state` expired, was used, or was superseded by a newer link. Changes nothing. |
| `denied` | The person refused at the authorization server (`error=access_denied`). |
| `no_redirect_uri` | This server's `welcome` carried no `upstream_oauth.redirect_uri`. |
| `discovery_failed` | Protected resource or authorization server metadata could not be found, or it cannot do `code` + S256. |
| `registration_failed` | Dynamic client registration was refused or is not offered. |
| `exchange_failed` | The token endpoint refused the code, the redirect carried no code, or carried an `error` other than `access_denied`. |
| `issuer_mismatch` | `iss` missing where the metadata promises it, or not the metadata's `issuer`. |

`state` is null when there was none (`upstream_auth_start`). `error` is for
people and never contains a secret. On `ok: true` the bridge connects, lists the
tools, tells the CLI that its tool list changed, and sends `upstream_status`.

### Server → Bridge: `upstream_auth_forget`

```json
{ "type": "upstream_auth_forget", "server": "kaizen" }
```

Forget this upstream's tokens on this bridge. The client registration stays.
The upstream goes to `needs_auth`, followed by `upstream_status`. No
`upstream_auth_required` is sent, on this or a later server connection, until
`upstream_auth_start`. That holds until the bridge restarts: it is not
persisted, so a restarted bridge, finding no token, asks again (`no_token`). Unknown or non-OAuth server: ignored, with a log line; no
answer.

### What the bridge does

- **Discovery and registration.** A request without a token; a 401 with
  `WWW-Authenticate: Bearer resource_metadata=…` leads to the protected
  resource metadata, then the authorization server metadata (RFC 8414, falling
  back to OIDC discovery). Dynamic client registration with
  `redirect_uris: [redirect_uri]`, `grant_types: [authorization_code,
  refresh_token]`, `response_types: [code]`, `token_endpoint_auth_method: none`
  (a public client) and `client_name`. The authorization request carries
  PKCE S256, `state`, `resource` (RFC 8707, from the protected resource
  metadata) and `scope` (the configured one, else the resource's
  `scopes_supported`).
- **Storage**, under `AI_BRIDGE_DATA_DIR` (default `~/.ai-bridge`), in
  `mcp-oauth/`: the directory 0700, every file 0600. The client registration is
  keyed by (the upstream's `url`, `redirect_uri`), so a bridge serving two web
  applications registers once per redirect; tokens are keyed by the upstream's
  `url`. Tokens are never logged and never sent to the server; every token value
  joins the upstream's redaction set (model text, host results, errors, stderr).
- **While `needs_auth`:** none of that upstream's tools are offered to the CLI.
  A call by name answers with an error telling the model the person has been
  asked to sign in. `mcp_request` to it answers `code: "unavailable"` with an
  error saying a sign-in is needed. Not retried in the background.
- **Refresh:** a minute before expiry, or on a 401, refresh once. If that fails,
  `needs_auth` and `upstream_auth_required` with `refresh_failed`. A 401 to a
  token that has no refresh token, or to a freshly refreshed one, is `rejected`.
  A token that has expired with no refresh token is dropped, and the next
  request goes without one, so that is reported as `no_token`. A refresh token
  the authorization server refused is deleted; one that could not be tried
  (network, timeout) stays on disk for the next start, and an early refresh
  that got no answer keeps using the access token until it really expires. A
  401 that arrives for a request sent with a token that has since been
  refreshed is retried with the new one; it never discards it. A refresh uses
  the client registration that issued the tokens (stored with them).
- **Requests to the authorization server and for metadata** (not MCP traffic)
  time out after 15 s and read at most 1 MB. Their URLs come from documents the
  upstream serves, so they must be `https:` (plain `http:` only to loopback),
  and an internal address (loopback, private, link-local, CGNAT, unique-local)
  is refused unless the upstream's own host is one. Redirects are followed only
  within the same origin. Each `upstream_auth_start` / `upstream_auth_code`
  still gets exactly one answer when one of these fails.
- **One OAuth upstream per url**: two with the same `url` are refused at start,
  because they would share (and rotate away) one set of tokens.
- `mcp_request` / `mcp_result` semantics are otherwise unchanged.

---

## Heartbeat

Keeps the WebSocket alive and detects dead connections.

### Bridge → Server: `ping`

```json
{
  "type": "ping",
  "timestamp": 1718400000
}
```

### Server → Bridge: `pong`

```json
{
  "type": "pong",
  "timestamp": 1718400000
}
```

The bridge sends a `ping` every `config.heartbeat_interval` seconds (from `welcome` message, default 30s). If no `pong` is received within 10 seconds, the bridge considers the connection dead and initiates reconnection.

The server also tracks heartbeats. If no `ping` is received for 2x the heartbeat interval, the server marks the bridge as disconnected and notifies the browser (so the UI can show "Bridge disconnected").

---

## Error Handling

### Error Codes

| Code | Meaning | Recovery |
|------|---------|----------|
| `invalid_token` | Connection token invalid or expired | User generates a new token in web UI |
| `provider_unavailable` | Requested CLI not installed on bridge | Server falls back or notifies user |
| `provider_error` | CLI exited with non-zero code | Retry or notify user |
| `session_lost` | A resume of the requested `cli_session_id` failed (session expired/cleared/created elsewhere) | Recoverable: server wipes the stored session and silently re-issues the turn fresh with history. No `done` follows |
| `silence_timeout_exceeded` | Turn produced nothing for `silence_timeout` seconds; carries `limit_seconds` | Server notifies user, can retry |
| `request_timeout_exceeded` | Turn ran past the `request_timeout` wall clock; carries `limit_seconds` | Server notifies user, can retry |
| `bridge_disconnected` | WebSocket connection lost | Auto-reconnect with backoff |
| `tool_error` | Tool execution failed | CLI handles gracefully in response |
| `rate_limited` | CLI provider rate limit hit | Exponential backoff, notify user |
| `provider_warning` | Non-fatal provider warning (e.g. content policy notice). The request continues; the message is informational | Surface to user as informational notice |
| `invalid_request` | Malformed request from server | Log and respond with error |
| `working_dir_not_allowed` | The `working_dir` is not inside a root the operator permitted with `--allow-dir` (or none were permitted). Also emitted on a turn that named NOTHING, when the directory its CLI session is remembered in has since been revoked | Operator restarts the bridge with `--allow-dir`, or the server offers only the `workspaces` from `hello`. Terminal: `done` follows |
| `working_dir_not_found` | The named `working_dir` is inside an allowed root but does not exist, or is not a directory. The bridge never creates it | Check the path. Terminal: `done` follows |
| `working_dir_changed` | A resume named a different directory from the one its CLI session was started in | Server starts a fresh session deliberately. Terminal: `done` follows |
| `bridge_prompt_invalid` | The `bridge_prompt` contradicts itself — text with a mode that discards it, `append`/`replace` with nothing to add, an unknown mode, or text over the 8 KB cap | Server fixes the field. Terminal: `done` follows |
| `attachment_refused` | An attachment URL is not on the connected server's origin, or is not HTTPS | Server fixes the URL (or the operator sets `--api`). Terminal: `done` follows |
| `attachment_too_large` | An attachment exceeds the per-file, per-request or count cap (all three are reported in `hello` as `attachment_limits`) | Server sends a smaller file, or the operator raises `--attachment-max-mb` / `--attachment-total-mb` / `--attachment-max-count`. Terminal: `done` follows |
| `attachment_failed` | An attachment could not be downloaded — including one that stalled or ran past the per-file ceiling — or failed its size/checksum verification | Retry; for a stall or ceiling on a slow link, the operator raises `--attachment-stall-seconds` / `--attachment-timeout-minutes`. Terminal: `done` follows |
| `gemini_working_dir_unavailable` | Gemini cannot use this working directory: the repository already has a `.gemini/settings.json`, or another Gemini turn is running in it | Move the file aside, use Claude or Codex, or wait for the other turn. Terminal: `done` follows |

All of the above are **refusals**: they carry their own code and are followed by `done`, which ends the turn. They are deliberately not reported as `session_lost` — that code tells the server to wipe the session and silently re-issue the turn, which for a refusal would retry it forever and never surface the reason.

### Bridge → Server: Error Response

For request-level errors (not streaming):

```json
{
  "type": "error",
  "request_id": "req_abc123",
  "code": "provider_unavailable",
  "message": "Provider \"codex\" is not available on this bridge.",
  "fatal": true
}
```

**`fatal`**: Hint to the server whether this error is fatal (`true`) or recoverable (`false`). A `provider_unavailable` error is fatal — no recovery is possible without operator action.

**`bridge_disconnected`** is how a request the dropped connection aborted is reported, once the bridge is back: nothing could be sent over the closed socket, so this is sent after the next `welcome` in place of the turn's terminal frame. On a turn with its input open it carries **`pending_inputs`** — the accepted `turn_input` messages the assistant never read, oldest first, always present and possibly empty — and is sent only once that turn's CLI has actually stopped, which may be a few seconds after the `welcome`, so that the list is final. **Accepted and not listed means read**, even when its `user_input` was lost with the connection.

```json
{ "type": "error", "request_id": "req_abc123", "code": "bridge_disconnected",
  "message": "Request aborted: the bridge connection dropped while the response was streaming.",
  "fatal": false, "pending_inputs": ["msg_43"] }
```

---

## Provider Reference

### CLI Invocation

How the bridge invokes each provider:

**Working directory**: every provider CLI is spawned in a dedicated empty directory, not the bridge process's own working directory. This prevents the CLIs from auto-loading project context files (`CLAUDE.md` / `AGENTS.md` / `GEMINI.md`) from whatever directory the bridge happened to be started in. User-level context files (e.g. `~/.claude/CLAUDE.md`) are unaffected — they load regardless of working directory.

#### Codex

```bash
# New session
codex exec --json --skip-git-repo-check --ephemeral -m <model> -- "user message"

# Resume session
codex exec resume <SESSION_ID> --json -m <model> "user message"

# With MCP tools
codex exec --json --mcp-server "ai-bridge-tools" "system prompt" <<< "user message"
```

Output: JSON streaming (NDJSON) to stdout. Bridge parses and normalizes to protocol events.

#### Claude

```bash
# New session
claude -p --output-format stream-json --verbose "user message"

# Resume session
claude -p --session-id <UUID> --output-format stream-json --verbose "user message"

# With tools (bash approach)
claude -p --output-format stream-json --verbose --allowedTools "bash" "user message"
```

Output: JSON lines to stdout. Bridge parses and normalizes.

System prompt: Passed via `--system-prompt` flag on first message. Retained in session on resume.

#### Gemini

```bash
# New session
gemini --prompt "user message" --output-format stream-json --skip-trust

# Resume session
gemini --prompt "user message" --resume <UUID> --output-format stream-json --skip-trust
```

Output: NDJSON streaming to stdout. Bridge parses and normalizes.

### Feature Matrix

| Feature | Codex | Claude | Gemini |
|---------|-------|--------|--------|
| Streaming | Yes (JSON) | Yes (JSON lines) | Yes (text) |
| Thinking/reasoning | Yes | Yes (extended thinking) | Partial |
| Native tool calls | Yes (MCP) | Yes (allowedTools) | No |
| Bash tool fallback | Yes | Yes | Yes |
| Session resume | Yes | Yes | Yes |
| System prompt | Yes | Yes | Yes |
| Token usage reporting | Yes | Yes | No |
| Max output control | Yes | Yes | Partial |

### Output Normalization

Each provider outputs differently. The bridge normalizes:

**Codex** outputs structured JSON events:
```json
{"type": "thinking", "content": "..."}
{"type": "text", "content": "..."}
{"type": "tool_call", "name": "roll_dice", "arguments": {...}}
```

**Claude** outputs JSON lines:
```json
{"type": "content_block_start", "content_block": {"type": "thinking", ...}}
{"type": "content_block_delta", "delta": {"text": "..."}}
{"type": "content_block_stop"}
```

**Gemini** outputs structured NDJSON events that the bridge parses and normalizes:
```json
{"type":"init","session_id":"...","model":"...","timestamp":"..."}
{"type":"message","role":"assistant","content":"...","delta":true,"timestamp":"..."}
{"type":"tool_use","tool_name":"...","tool_id":"...","parameters":{},"timestamp":"..."}
{"type":"tool_result","tool_id":"...","status":"success","output":"...","timestamp":"..."}
{"type":"error","severity":"warning|error","message":"...","timestamp":"..."}
{"type":"result","status":"success|error","stats":{"input_tokens":...,"output_tokens":...},"timestamp":"..."}
```

The bridge maps all of these to the unified `block_start` / `block_delta` / `block_stop` event model defined in [Streaming Events](#streaming-events).

**One invocation can run more than one turn, and only one of them is yours.** Claude Code answers work it queued for *itself* before it dequeues the message the bridge sent — a `<task-notification>` for a background shell command an earlier turn left running, say — and each of those turns ends with a `result` frame of its own. Those frames carry an `origin` (`{"kind":"task-notification"}`); the result that answers the bridge's prompt does not. The bridge ends the turn on the unstamped one, so a server sees exactly one `done`, and it reports the turn the server asked for.

The stamping is on the `result` frame, so that is what this covers. Content from a turn the CLI queued for itself would be forwarded like any other frame — today those turns make no API call and write nothing at all, which is why they are invisible apart from the `result` they end with.

Treating the first `result` as terminal is what this replaces, and it was not a theoretical fault: the notification's result arrives within ~70ms with zero usage and no text, so the turn ended before the answer had started, the real reply was dropped frame by frame, and the person saw an empty message — then saw it again on the retry.

---

## Message Type Summary

### Bridge → Server

| Type | When |
|------|------|
| `hello` | After WebSocket connects |
| `ping` | Every heartbeat interval |
| `ai_request_ack` | After receiving an `ai_request` |
| `stream` (block_start) | Opening a content block |
| `stream` (block_delta) | Incremental content within a block |
| `stream` (block_stop) | Closing a content block |
| `stream` (tool_result) | Acknowledging tool result received |
| `stream` (task) | A helper started, progressed, is still alive, or ended |
| `stream` (user_input) | The assistant took in a `turn_input` message |
| `stream` (main_state) | The main assistant became working or idle (input-open turns) |
| `stream` (input_closed) | The bridge closed the CLI's input; the turn takes no more messages (input-open turns) |
| `turn_input_ack` | Answering a `turn_input`, accepted or rejected |
| `upload_done` | Answering an `upload_offer`: where the file is, or why not |
| `file_read_result` | Answering a `file_read`: size and range, or why not |
| `stream` (done) | Response complete |
| `stream` (error) | Error during streaming |
| `tool_call` | CLI invoked a server-side tool (via callback) |
| `mcp_result` | Answering an `mcp_request`: a result, or an error with a code |
| `upstream_status` | After `welcome`, and whenever an upstream's state, auth or tool count changes |
| `upstream_auth_required` | An OAuth upstream needs the person to sign in: a link to open |
| `upstream_auth_result` | Answering an `upstream_auth_code` (or a failed `upstream_auth_start`) |
| `cancelled` | A turn stopped because the server asked |
| `local_result` | Answering a `local_call`, run or refused |
| `error` | Request-level error (non-streaming) |

### Server → Bridge

| Type | When |
|------|------|
| `welcome` | After receiving `hello` |
| `pong` | After receiving `ping` |
| `ai_request` | New AI request for a conversation |
| `cancel` | Stop a turn that is running |
| `turn_input` | A message for a turn that is still running |
| `tool_resolve` | Returning tool execution result |
| `tool_error` | Tool execution failed |
| `local_call` | Asking the bridge to run one tool on this machine |
| `upload_offer` | A person's file is coming: fetch it into `file-uploads/` |
| `upload_sent` | Every byte of an upload has passed through; its size and digest |
| `upload_abort` | Stop receiving an upload and remove what arrived |
| `file_read` | Hand a recorded file back, by id, to a one-time URL |
| `file_read_cancel` | Stop handing a file back |
| `mcp_request` | A view asks its upstream MCP server for something (`resources/read`, `tools/call`) |
| `upstream_auth_start` | The person asked to (re)connect an OAuth upstream |
| `upstream_auth_code` | The sign-in redirect's parameters, passed on |
| `upstream_auth_forget` | Forget an OAuth upstream's tokens on this bridge |

---

## Security Considerations

### User Responsibility

The bridge runs **locally on the user's machine** using **their own CLI tools** authenticated with **their own subscriptions**. The server (Dungeon Maister or any other app using this protocol) never:

- Touches the user's OAuth tokens
- Accesses the user's CLI credentials
- Stores any authentication material for the AI providers

### Connection Token

- Long-lived JWT (default: 30 days) topped up by the server before it expires — see [Token lifetime](#token-lifetime)
- Scoped to `ai-bridge` (cannot be used for other API calls)
- User can revoke and regenerate at any time via the web UI; regenerating actively disconnects the previous bridge
- One active bridge connection per user (new connection supersedes old)

### Data in Transit

- WebSocket MUST use `wss://` (TLS) in production
- Tool results may contain sensitive game/app data — encrypted in transit via TLS
- Bridge should never log full request/response payloads by default (opt-in debug mode)

### CLI Tool Policies

Users are responsible for complying with their AI provider's terms of service. The bridge README, first-run prompt, web app settings page, and application ToS should include appropriate disclaimers.

**Current policy summary (May 2026):**
- **Codex**: Most permissive. Apache 2.0 SDK, official MCP support, subscription OAuth works in external tools
- **Claude**: Users CAN run third-party tools (draws from Agent SDK credit pool). Developers must NOT offer claude.ai login integration
- **Gemini**: OAuth piggybacking banned, but API key + headless mode (`gemini -p`) explicitly allowed

---

## Versioning

The protocol version is exchanged during handshake (`hello.version`). The server and bridge must agree on the major version. Minor version differences are backward-compatible.

- `0.x` — Pre-release, breaking changes allowed between minor versions
- `1.x` — Stable, semantic versioning applies

**Helper activity does not bump the version either.** `parent_tool_use_id` on `block_start` and `tool_result`, the `task` stream event and `done.subagent_stats` are additive: absent means what it always meant, and a consumer ignores an event it does not know.

**Person uploads and handing files back do not bump the version.** `hello.file_uploads`, `hello.file_downloads`, the four `upload_*` frames and the three `file_read*` frames are additive; a server must not send `upload_offer` to a bridge that did not advertise `file_uploads`.

**The thinking level does not bump the version.** `hello.effort_levels` and `options.effort` are additive: an older bridge ignores the option, and an older server ignores the field.

**Announcing the input's close does not bump the version.** `hello.input_closed` and the `input_closed` stream event are additive: a consumer ignores an event it does not know, and a server that does not see the flag learns the close the way it always did, from `turn_ending`.

**MCP Apps do not bump the version.** `hello.mcp_apps`, `welcome.tools[]._meta`, `tool_call.provider_tool_call_id`, `tool_result.ui`, `mcp_request` and `mcp_result` are additive; their own shape is versioned by `hello.mcp_apps.revision`.

**Upstream sign-in does not bump the version.** `hello.mcp_upstream_auth`, `welcome.upstream_oauth`, `upstream_status` and the `upstream_auth_*` frames are additive; their shape is versioned by `hello.mcp_upstream_auth.revision`, and a server must not send the server→bridge frames to a bridge without it.

**Self-update does not bump the version.** `welcome.desired_bridge_version` and `hello.self_update` are additive in both directions.

**App backends do not bump the version.** `hello.app_backends`, `app_call` and `app_result` are additive; a server must not send `app_call` to a bridge that did not advertise `app_backends`. `hello.app_items` and `app_call.use` are additive the same way.

**Workspaces, attachments and `workspace` isolation do not bump the version.** They stay on `0.1`, deliberately. Every one of them is optional in both directions — `hello.workspaces`, `ai_request.working_dir`, `ai_request.attachments`, the `attachment` stream event and the `workspace` value of `cli_isolation` are all additive, and both ends already ignore fields they do not recognise. Only the major number is enforced, so a bump would refuse every bridge already installed in exchange for nothing.

---

## BYOK / Managed: Server-Side Only

For BYOK and Managed modes, the bridge is not involved. The server handles everything:

1. User configures endpoint URL + API key in web UI (BYOK) or app provides its own (Managed)
2. Server sends Chat Completions API request directly:
   ```
   POST {endpoint_url}/v1/chat/completions
   Authorization: Bearer {api_key}
   ```
3. Server streams the response to the browser via SSE
4. Tool calls are handled server-side using standard Chat Completions `tools` parameter

The Laravel package (`laravel-ai-bridge`) provides a unified interface:

```php
// Same interface regardless of mode
$bridge->stream($conversation, $message, function (StreamEvent $event) {
    // Normalized events — same format whether from CLI bridge,
    // BYOK API, or managed endpoint
    match ($event->type) {
        'block_start' => handleBlockStart($event),
        'block_delta' => handleBlockDelta($event),
        'block_stop'  => handleBlockStop($event),
        'tool_call'   => handleToolCall($event),
        'done'        => handleDone($event),
    };
});
```

This is the core value proposition of the Laravel package: **one streaming interface, three AI modes**.
