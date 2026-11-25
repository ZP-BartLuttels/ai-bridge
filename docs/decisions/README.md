---
type: reference
---
# Decision records

One file per decision, numbered permanently. Accepted is binding; superseded is
history. Format: Engram documentation standard v1, section 3.

| # | Title | Status | Date |
|---|---|---|---|
| [0001](0001-release-tag-is-the-version.md) | The release tag is the single source of truth for the published version | accepted | 2026-05-17 |
| [0002](0002-server-owns-cli-sessions.md) | The server owns CLI session ids; the bridge is stateless about them | accepted | 2026-05-18 |
| [0003](0003-server-tools-through-bridge-mcp-server.md) | Server tools reach the CLI only through a bridge-side MCP server | accepted | 2026-05-24 |
| [0004](0004-local-tools-opt-in-secrets-open-on-bridge.md) | Local tool execution is opt-in per machine, and sealed values open only on the bridge | accepted | 2026-08-29 |
| [0005](0005-additive-handshake-fields-no-version-bump.md) | New capabilities are additive handshake fields; the protocol stays on 0.1 | accepted | 2026-09-04 |
| [0006](0006-permissive-postures-need-operator-opt-in.md) | Permissive isolation postures need the bridge operator's opt-in | accepted | 2026-09-04 |
| [0007](0007-follow-desired-bridge-version.md) | A bridge follows the server's desired_bridge_version through a pinned systemd unit | accepted | 2026-10-03 |
| [0008](0008-upstream-tools-only-in-workspace.md) | Upstream MCP tools are offered only in workspace isolation | accepted | 2026-10-09 |
| [0009](0009-views-call-only-app-visible-tools.md) | A view may call only tools whose _meta.ui.visibility includes app | accepted | 2026-10-09 |
| [0010](0010-upstream-oauth-code-relayed-tokens-stay-local.md) | Upstream OAuth: the web app relays the code; tokens and the PKCE verifier stay on the bridge | accepted | 2026-10-16 |
| [0011](0011-app-backends-run-only-approved-code.md) | An app backend runs only the files of the version the person approved | accepted | 2026-10-19 |
| [0012](0012-a-request-may-narrow-its-turn-never-widen.md) | A request may narrow its own turn to isolated, never widen it | accepted | 2026-10-20 |
| [0013](0013-token-only-in-the-authorization-header.md) | The connection token travels only in the Authorization header | accepted | 2026-10-24 |
| [0014](0014-system-prompt-by-file-fresh-every-turn.md) | Claude gets the system prompt by file, rendered fresh on every turn | accepted | 2026-10-25 |
| [0015](0015-helpers-get-the-session-section.md) | Claude subagents get the bridge's session section too | accepted | 2026-10-25 |
| [0016](0016-with-the-operators-opt-in-a-request-may-add-web-search.md) | With --allow-web-search, a request may add Claude's built-in WebSearch, and only it, to an isolated turn | accepted | 2026-11-14 |
| [0017](0017-claude-token-file-read-per-run.md) | The Claude token file may hold several named tokens and is read for every run | accepted | 2026-11-15 |
| [0018](0018-claude-sign-in-profiles-saved-back-before-a-switch.md) | Claude sign-in profiles, saved back before every switch | accepted | 2026-11-15 |
| [0019](0019-the-repository-names-no-downstream-project.md) | The repository names no downstream project; history is kept and mapped | accepted | 2026-11-21 |
| [0020](0020-machine-secrets-built-in-store-operator-opt-in.md) | Machine secrets: a built-in store, managed by a server only with the operator's opt-in | accepted, in part superseded by 0023 | 2026-11-21 |
| [0021](0021-secrets-a-server-wrote-are-not-marked.md) | Secrets a server wrote are treated like the ones the person added | accepted, in part superseded by 0023 | 2026-11-22 |
| [0022](0022-readable-store-warns-prompt-injection-out-of-scope.md) | A store a turn could read is a startup warning; prompt injection is outside the threat model | accepted | 2026-11-22 |
| [0023](0023-secrets-may-end-a-replace-states-its-end.md) | Machine secrets may end, the machine enforces it, and a replace always states its end | accepted | 2026-11-25 |
