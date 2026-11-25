Documentation: follows Engram documentation standard v1.

# ai-bridge: notes for agents

`@tetrixdev/ai-bridge` is a Node/TypeScript CLI that runs on a person's machine,
connects outward over WebSocket to a web application (the server half is
`tetrixdev/laravel-ai-bridge`), and runs that application's AI turns through the
locally installed Codex, Claude or Gemini CLI. Start with
[docs/README.md](docs/README.md) (the map) before larger work.

## Commands

Node 22 or newer (CI runs 22 and 24).

| What | Command |
|---|---|
| Install | `npm ci` |
| Build (tsup, writes `dist/cli.js`) | `npm run build` |
| Typecheck, src and tests (CI runs both) | `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.test.json` |
| Full test suite (vitest) | `npm test` |
| Smallest test: one file, one name | `npx vitest run tests/mcp/upstream-oauth.test.ts -t "forget"` |
| No blocked names or ticket numbers (gates CI) | `python3 scripts/check-names.py` |
| Dependency audit (gates CI) | `npm audit --omit=dev --audit-level=moderate` |
| Live vault test (skipped without `ENGRAM_URL`) | see `tests/live/secrets.live.test.ts` |
| End-to-end against a real server and CLI | see `tests/manual/README.md` (not part of `npm test`) |

## Non-negotiables

- **Secrets never leave the machine.** The bridge token, `ENGRAM_TOKEN` and other
  credentials are stripped from every spawned process (`stripCredentials` in
  `src/providers/env.ts`). Sealed vault values are decrypted only here, only
  through the space that sealed them (`src/local/`), and are redacted from
  everything sent out: tool text, `ui.result`, `mcp_result`, error messages and
  frames. Upstream OAuth tokens and the PKCE verifier never reach the server.
  A machine secret's value (`src/secrets/`) only travels in: no frame, log
  line, error or `aib secret` command prints one. Never log full request or
  response payloads by default. Decisions 0004, 0010, 0020.
- **The server cannot widen what the operator allowed.** `--allow-dir`,
  `--allow-native`, `--allow-web-search`, `--local-tools`, `--machine-secrets` and `--mcp-upstreams`
  are operator choices; no frame or field turns one on. A request outside them is refused, or falls
  back to `isolated` with a log line. Decisions 0004, 0006.
- **Refuse, do not silently correct or fall back.** A path, value or call the
  bridge will not honour fails visibly with a reason. A turn that quietly ran
  somewhere else looks exactly like one that worked.
- **Protocol stays on `0.1`; every change is additive in both directions.** A new
  bridge capability is advertised as a `hello` field (`true` or a revision
  number) and a server must not send its frames to a bridge without it; a new
  server option is an optional `welcome` or `ai_request` field that an older
  bridge ignores. Never require a field an installed bridge does not send.
  Decision 0005.
- **A protocol change updates PROTOCOL.md in the same change**: the section, the
  `hello`/`welcome` field, the "does not bump the version" line under
  Versioning, and the message type summary. It usually ships paired with a
  laravel-ai-bridge release; say so in the release notes.
- **Release = publishing a GitHub release tagged `vX.Y.Z` on main.** CI derives
  the version from the tag, stamps `package.json`, builds and publishes to npm
  with provenance. Never hand-bump `version` in `package.json`; it is cosmetic.
  Release notes live in the GitHub release body (there is no CHANGELOG.md).
  Decision 0001.
- **Keep the self-update path working.** A bridge on 0.24.0 or later must still
  be able to follow `welcome.desired_bridge_version` to the next release, and it
  must never restart in the middle of work. Decision 0007.
- **CI actions stay pinned to commit SHAs**; `permissions: read-all` at the top
  of `.github/workflows/ci.yml`, widened per job only where needed.

## Where things live

| Path | What |
|---|---|
| `src/cli.ts` | Entry point: options, env vars, `install` / `list` / `uninstall` / `claude-token` / `claude-login` (and `secret`, from `src/secrets/cli.ts`) |
| `src/bridge.ts` | The WebSocket client: handshake, routing every frame, turn lifecycle |
| `src/protocol/` | Frame types and `PROTOCOL_VERSION` |
| `src/providers/` | One adapter per CLI (`claude.ts`, `codex.ts`, `gemini.ts`), spawn env, timeouts, usage |
| `src/mcp/` | Bridge-side MCP server for server tools; upstream MCP servers and their OAuth |
| `src/tools/resolver.ts` | Round-trip of a server tool call over the socket |
| `src/workspace/` | `--allow-dir` allow-list, `working_dir` resolution, session directories |
| `src/attachments/` | Fetching, caching, uploads and files handed back |
| `src/local/` | Local tools: Engram device client, vault decryption, sandbox, scrubbing |
| `src/apps/` | Engram app backends: supervisor, network and code fence, egress relay |
| `src/spacefiles/` | Space files kept on this machine |
| `src/secrets/` | Machine secrets: the store in `~/.ai-bridge/secrets`, the `secret_*` frames, `aib secret` |
| `src/selfupdate/` | Following `desired_bridge_version` under systemd |
| `src/service/` | Installing bridges as systemd user services / launch agents |
| `tests/` | Vitest suites mirroring `src/`; `tests/manual/` and `tests/live/` are opt-in |
| `PROTOCOL.md` | The wire protocol, the contract with the server |
| `docs/` | Topic docs, architecture and decisions; map in `docs/README.md` |

## Load-bearing decisions

- 0001 The release tag is the single source of truth for the published version.
- 0002 The server owns CLI session ids; the bridge is stateless about them.
- 0003 Server tools reach the CLI only through a bridge-side MCP server.
- 0004 Local tool execution is opt-in per machine, and sealed values open only on the bridge.
- 0005 New capabilities are additive handshake fields; the protocol stays on 0.1.
- 0006 Permissive isolation postures need the bridge operator's opt-in.
- 0007 A bridge follows the server's `desired_bridge_version` through a pinned systemd unit.
- 0008 Upstream MCP tools are offered only in `workspace` isolation.
- 0009 A view may call only tools whose `_meta.ui.visibility` includes `app`.
- 0010 Upstream OAuth: the web app relays the code; tokens and the PKCE verifier stay on the bridge.
- 0011 An app backend runs only the files of the version the person approved.
- 0012 A request may narrow its own turn to `isolated`, never widen it.
- 0013 The connection token travels only in the Authorization header.
- 0014 Claude gets the system prompt by file, rendered fresh on every turn.
- 0015 Claude subagents get the bridge's session section too.
- 0016 With `--allow-web-search`, a request may add Claude's built-in WebSearch, and only it, to an `isolated` turn.
- 0017 The Claude token file may hold several named tokens and is read for every run.
- 0018 Claude sign-in profiles, saved back before every switch.
- 0019 The repository names no downstream project (CI: `scripts/check-names.py`); history is kept, `.mailmap` maps it.
- 0020 Machine secrets: a built-in store, managed by a server only with `--machine-secrets`.
- 0021 Secrets a server wrote are treated like the person's own: no marker, no extra refusal in `run`.
- 0022 A secrets store a turn could read is a startup warning only; prompt injection is outside the bridge's threat model.
- 0023 Machine secrets may end (expire or delete), enforced on the machine; a replace must state its end (`end_required`); `index.json` is version 2.

Full records and status: [docs/decisions/README.md](docs/decisions/README.md).
Before changing what one covers, read it; if your change contradicts an
accepted record, stop and ask.
