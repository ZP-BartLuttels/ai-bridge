/**
 * AI Bridge Protocol v0.1 — Type Definitions
 *
 * Defines all message types exchanged between the bridge (client)
 * and the server over WebSocket.
 *
 * Source of truth: PROTOCOL.md
 */

// ---------------------------------------------------------------------------
// Provider & Tool Definitions
// ---------------------------------------------------------------------------

/** Describes an available model for a provider. */
export interface ModelInfo {
  /** Model identifier (slug) used in CLI flags / API requests */
  id: string;
  /** Human-readable display name */
  name: string;
  /** Optional description of the model's strengths */
  description?: string;
  /** Whether this is the default model for the provider */
  is_default?: boolean;
}

/** Describes a locally detected AI CLI provider and its capabilities. */
export interface ProviderCapability {
  /** Provider name (e.g. "codex", "claude", "gemini") — used as the identifier */
  name: string;
  /** Detected version string, or null if unknown */
  version: string | null;
  /** Whether the CLI binary was found and is executable */
  available: boolean;
  /** Whether the provider supports streaming output */
  supports_streaming: boolean;
  /** Whether the provider supports tool/function calling */
  supports_tools: boolean;
  /** Whether the provider supports extended thinking */
  supports_thinking: boolean;
  /** Whether the provider supports resuming a prior session */
  supports_session_resume: boolean;
  /** Available models for this provider (populated after detection) */
  models?: ModelInfo[];
}

/** A tool definition following JSON Schema for parameters. */
export interface ToolDefinition {
  /** Unique tool name (e.g. "roll_dice", "web_search") */
  name: string;
  /** Human-readable description of what the tool does */
  description: string;
  /** JSON Schema describing the tool's input parameters */
  parameters: Record<string, unknown>;
  /**
   * Where this tool runs.
   *
   * Absent means `server`, so every existing server keeps the behaviour it has:
   * the call round-trips over the WebSocket and the server executes it. Same
   * convention as `isolation` elsewhere in this file, where absent is the safe
   * legacy default and never the new behaviour.
   *
   * `local` means the bridge runs it on this machine and never emits a
   * tool_call frame, which is the entire point once the arguments include a
   * decrypted secret: the plaintext must not reach the network.
   *
   * Honoured ONLY when the operator enabled local execution. A server cannot
   * turn it on by sending this field. See src/local/gate.ts.
   */
  execute?: 'server' | 'local';
  /**
   * local only. The space this tool belongs to, which is where its package is
   * installed. The items filling its roles may come from other spaces the
   * person reaches; each sealed value names its own space in `fill`.
   */
  space_id?: string;
  /**
   * local only. What the tool needs, by ROLE: a label naming the service and
   * the fields it reads.
   *
   * The tool reads ENGRAM_<ROLE>_<FIELD> for each field, plain or sealed, so
   * one `fetch_mail` serves three app registrations: a person chooses which
   * item fills `mailbox`, and the tool never learns an item's name.
   */
  needs?: { role: string; kind?: string; fields?: string[] }[];
  /**
   * local only. Which item fills each role, as the server resolved it: plain
   * fields as values, sealed fields as ids with the space each is sealed in.
   * The bridge never turns a name into an id on its own.
   */
  fill?: ItemFill[];
  /**
   * local only. An npm package this tool lives in, pinned exactly
   * (`@scope/name@1.2.3`).
   *
   * Installed with install scripts disabled, into a per-space directory under
   * the bridge's own data dir. A range or a dist-tag is refused: what runs
   * here has to be the same bytes every time.
   */
  package?: string;
  /**
   * local only. What the tool needs from the network.
   *
   * `false` means none, and on Linux the bridge enforces it with a network
   * namespace. A host list means the bridge does NOT filter (per-host
   * filtering is not implemented) and says so in the result's sandbox report.
   * Absent means unrestricted.
   */
  network?: boolean | string[];
  /** local only. The command to run, and any arguments before the tool's own. */
  run?: { command: string; args?: string[] };
  /**
   * MCP Apps: the definition's MCP `_meta`, passed through unchanged to the
   * CLI's tools/list. ext-apps puts `ui.resourceUri` and `ui.visibility` here.
   */
  _meta?: Record<string, unknown>;
}

/**
 * One role, filled by one vault item.
 *
 * Plain fields travel as values, because plain means not secret. Each sealed
 * field travels as the id of the sealed value and the space it is sealed in,
 * never as a value: the bridge opens it with that space's key, and refuses if
 * it holds no such value in that space as that field of that item. The item's
 * space may differ from the tool's; whether the person may use it with this
 * tool is decided by Engram, from their consent, before the call is sent.
 */
export interface ItemFill {
  role: string;
  item_id: string;
  /** The space the item lives in. */
  space_id: string;
  kind?: string;
  /** The plain fields the tool reads, with their values. */
  fields?: Record<string, string>;
  /** The sealed fields the tool reads: which value, sealed in which space. */
  sealed?: { field: string; secret_id: string; space_id: string }[];
}

/** What a `local_call` asks the bridge to run. */
export interface LocalCallTool {
  name: string;
  command: string;
  args?: string[];
  /** Pinned npm package to install and run from. See ToolDefinition.package. */
  package?: string;
  /** See ToolDefinition.network. */
  network?: boolean | string[];
}

/**
 * A directory this bridge is allowed to work in, as advertised at the
 * handshake so the server can show a picker instead of asking a developer to
 * type an absolute path into a chat box.
 *
 * The list is built ENTIRELY from what the operator passed to `--allow-dir`
 * (or AI_BRIDGE_ALLOWED_DIRS). A server cannot add to it, and naming a path
 * that is not under one of these roots is refused — see src/workspace/.
 */
export interface WorkspaceRef {
  /** Absolute, symlink-resolved path of the allowed root. */
  path: string;
  /** Human-readable name for a picker. Defaults to the directory's basename. */
  label: string;
}

/**
 * One file the server wants the assistant to be able to read this turn.
 *
 * The bytes are NOT on the wire: a screenshot already exceeds the server's
 * 1 MB WebSocket frame cap, and base64 adds a third on top. The bridge fetches
 * `url` over HTTPS with its own connection token, verifies `size` and
 * `sha256`, writes the file under the bridge's own cache directory, and tells
 * the model where it landed.
 */
export interface AttachmentRef {
  /** Server-side identifier, echoed in errors and used to disambiguate names. */
  id: string;
  /** Original filename. NEVER trusted as a path — see sanitiseAttachmentName(). */
  name: string;
  mime_type: string;
  /** Expected size in bytes. A mismatch after download fails the request. */
  size: number;
  /** Lowercase hex SHA-256 of the file. A mismatch fails the request. */
  sha256: string;
  /**
   * Where to fetch it. Must be on the same origin as the server this bridge
   * is connected to (or the explicit `--api` origin), or it is refused: a
   * hostile server must not be able to turn a connected bridge into a fetcher
   * for arbitrary hosts with a valid bearer token attached.
   */
  url: string;
}

// ---------------------------------------------------------------------------
// Bridge -> Server Messages
// ---------------------------------------------------------------------------

/**
 * Sent immediately after WebSocket connection is established.
 * Token is NOT included — it goes in the URL query param.
 */
export interface HelloMessage {
  type: 'hello';
  version: string;
  bridge_version: string;
  providers: ProviderCapability[];
  /**
   * This bridge understands `options.accepts_input` and `turn_input`. Whether a
   * given turn actually runs with its input open is still confirmed per turn,
   * by `input_open` on its `ai_request_ack` (Claude only). Absent from a bridge
   * that predates the feature; an older server ignores it.
   */
  turn_input?: true;
  /**
   * This bridge announces, with the `input_closed` stream event, the moment an
   * input-open turn stops taking messages. Absent from a bridge that predates
   * it, which closes the input just the same and says nothing; an older server
   * ignores the field and the event.
   */
  input_closed?: true;
  /**
   * Directories this bridge may be asked to work in. Absent or empty means
   * the operator allowed none, and every `ai_request.working_dir` is refused.
   * An older server ignores the field.
   */
  workspaces?: WorkspaceRef[];
  /**
   * The attachment caps this bridge enforces, so a server can refuse or warn
   * before the upload rather than mirror the numbers in its own configuration.
   * Omitted by a bridge that predates the field; an older server ignores it.
   */
  attachment_limits?: AttachmentLimitsRef;
  /**
   * This bridge accepts `upload_offer`: a file a person picked in a chat,
   * streamed through the server into `<working folder>/file-uploads/` and not
   * kept by the server. Absent from a bridge that predates it, and a server
   * must then refuse the upload rather than keep the file itself. Whether the
   * machine has a folder at all is `workspaces`, not this.
   */
  file_uploads?: true;
  /**
   * This bridge answers `file_read`: a file it recorded itself (received into
   * file-uploads/, or handed back by the assistant), fetched by the id it
   * minted and POSTed to a one-time server URL. It no longer serves
   * `attachment_read`, which named a path.
   */
  file_downloads?: true;
  /**
   * This bridge runs Engram app backends (`app_call` / `app_result`), behind
   * the same `--local-tools` gate as local tools. Sent whatever the gate says,
   * like the flags above: it says the frames are understood, and a bridge
   * that did not opt in answers each call with a refusal.
   */
  app_backends?: true;
  /** Takes `app_call.use`: a linked item other than the default, beside one request (0.22.0). */
  app_items?: true;
  /**
   * This bridge follows `welcome.desired_bridge_version` by itself: it runs as
   * a service that can restart it onto a pinned version, and is not opted out.
   * `false` from a bridge that understands the field but will not follow it
   * (a terminal, an unpinned unit, opted out), absent from one that predates
   * it. Either way such a machine needs updating by hand.
   */
  self_update?: boolean;
  /**
   * MCP Apps (ext-apps): `spec` is the specification revision implemented
   * ("2026-01-26"); `revision` the revision of this bridge's own MCP Apps
   * frames (welcome tool `_meta`, `tool_call.provider_tool_call_id`,
   * `tool_result.ui`, `mcp_request` / `mcp_result`). Absent from a bridge that
   * predates them: a server tells the person to update it.
   */
  mcp_apps?: { spec: string; revision: number };
  /**
   * This bridge implements upstream sign-in (OAuth) for its `--mcp-upstreams`
   * servers: `welcome.upstream_oauth`, `upstream_status`,
   * `upstream_auth_required` / `_start` / `_code` / `_result` / `_forget`.
   * A server must not send the server->bridge frames to a bridge without it.
   */
  mcp_upstream_auth?: { revision: number };
  /**
   * This bridge keeps an Engram space's files (`files_write`, `files_read`,
   * `files_move`, `files_purge`, answered with `files_result`) under
   * `<first allowed folder>/files/<space>/`. The number is the revision of
   * those frames (1). Absent from a bridge that predates them: a server tells
   * the person to update it.
   */
  space_files?: number;
  /**
   * This bridge holds an app backend to the hosts its manifest declares
   * (`app_call.backend.network`, plus Engram's own API) and to the image
   * fetcher when `public_images` is set: every TCP connection goes through a
   * relay in the bridge that checks the name it is for, and UDP, local sockets
   * and DNS for other names are refused. The number is the revision (1).
   * Absent from a bridge that predates it, where the hosts are not enforced.
   * A backend that may run a shell or programs is NOT covered past its own
   * process: a child process runs outside the fence.
   */
  app_network?: number;
  /**
   * The values `options.effort` takes: `["low","medium","high","xhigh","max"]`,
   * passed to Claude as `--effort <level>`. Claude only; Codex and Gemini ignore
   * the option. Absent from a bridge that predates it, which drops the option
   * and runs the turn at the CLI's default.
   */
  effort_levels?: string[];
}

/** Attachment caps as reported in `hello`. Bytes, not megabytes: no rounding on either side. */
export interface AttachmentLimitsRef {
  /** Largest single attachment, in bytes. */
  max_file_bytes: number;
  /** Largest total of one request's attachments, in bytes. */
  max_total_bytes: number;
  /** Most attachments one request may carry. */
  max_count: number;
}

/**
 * Acknowledges receipt of an ai_request and confirms processing has begun.
 *
 * cli_session_id is null when no existing session is found (a fresh CLI
 * session); servers treat null as "new session" and any non-null string as the
 * resumable CLI session identifier.
 */
export interface AiRequestAckMessage {
  type: 'ai_request_ack';
  request_id: string;
  cli_session_id: string | null;
  /**
   * What the bridge resolved for this turn's session defaults.
   *
   * Echoed so a server can ASSERT it got what it asked for, instead of
   * inferring it from the assistant's behaviour three turns later. Same
   * instinct as the `origin` stamping elsewhere in this protocol: make it
   * observable rather than deducible.
   *
   * Omitted entirely by a bridge that predates this field, so a server must
   * treat absence as "unknown", never as "defaults applied".
   */
  bridge_session?: {
    /** The prompt mode actually applied. */
    prompt_mode: 'default' | 'off' | 'append' | 'replace';
    /** Whether the server supplied addendum text of its own. */
    prompt_server_text: boolean;
    /** Allow-listed env keys this request overrode. */
    env_overridden: string[];
    /** Keys the request named that the bridge does not allow, and dropped. */
    env_rejected: string[];
  };
  /**
   * Present, and `true`, when this turn runs with its input open: the server
   * asked for it with `options.accepts_input`, and the bridge will take
   * `turn_input` for it while it runs.
   *
   * Absent otherwise, and absent from any bridge that predates the field. A
   * server must read absence as "input is not open" and hold a message typed
   * mid-turn as it always did. That is what makes the option safe to send to
   * every bridge.
   */
  input_open?: true;
}

/**
 * A streaming event pushed to the server as the CLI produces output.
 *
 * Uses the envelope format: { type: "stream", request_id, event, data }
 */
export interface StreamMessage {
  type: 'stream';
  request_id: string;
  event: StreamEventType;
  data: StreamEventData;
}

/** Sent periodically to keep the connection alive. */
export interface PingMessage {
  type: 'ping';
  timestamp: number;
}

/** A tool call that the bridge needs the server to resolve. */
export interface ToolCallMessage {
  type: 'tool_call';
  request_id: string;
  tool_call_id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
  /**
   * The CLI's own id for the call, the one its stream later names in
   * `tool_result` (Claude Code: `_meta["claudecode/toolUseId"]` on tools/call).
   * Absent when the CLI did not send one. Lets a server join a call it is
   * running to the call it sees in the stream.
   */
  provider_tool_call_id?: string;
}

/**
 * MCP Apps: the answer to `mcp_request`, correlated by `id`. Exactly one per
 * request: `result` (the MCP result, unchanged apart from secret redaction and
 * the resources/list `_meta.ui` fallback) or `error` with its `code`.
 */
export interface McpResultMessage {
  type: 'mcp_result';
  id: string;
  result?: unknown;
  error?: string;
  /** With `error`: why, for the host to act on without parsing the words. */
  code?: 'unknown_server' | 'unavailable' | 'timeout' | 'refused' | 'unsupported' | 'upstream_error';
}

/** Non-streaming error response. */
export interface BridgeErrorMessage {
  type: 'error';
  request_id: string;
  code: string;
  message: string;
  fatal: boolean;
  /**
   * On `bridge_disconnected` for a turn that ran with its input open: the
   * `message_id` of every accepted `turn_input` the assistant never read,
   * oldest first. An accepted message not listed was read. Always present on
   * such a turn, empty when nothing was pending; absent otherwise.
   */
  pending_inputs?: string[];
}

/**
 * Sent mid-connection when the set of locally available provider CLIs has
 * changed since the `hello` handshake — e.g. the user installed or removed a
 * CLI while the bridge stayed connected. Carries the same provider shape as
 * `hello`, but only the providers that are currently available. The server
 * treats it as a refresh of the connection's advertised providers.
 */
export interface ProvidersUpdateMessage {
  type: 'providers_update';
  providers: ProviderCapability[];
}

/**
 * How a `local_call` turned out.
 *
 * Two shapes and no third: `ok: true` carries the one JSON document the tool
 * wrote to stdout, `ok: false` carries a sentence saying what went wrong. A
 * tool that printed something that is not JSON produces the second, never a
 * `result` holding raw text, because raw text reaching the model as a result is
 * indistinguishable from a tool that worked.
 */
export interface LocalResultMessage {
  type: 'local_result';
  /** Echoes the id of the local_call this answers. */
  id: string;
  ok: boolean;
  /** Present when ok. The tool's stdout, parsed. */
  result?: unknown;
  /** Present when not ok. Already scrubbed of every credential the tool held. */
  error?: string;
  /**
   * What the sandbox actually did on this machine, which is not always what
   * the tool asked for. Additive: a server that ignores it loses nothing, and
   * a server that reads it can tell a tool that ran with no containment from
   * one that ran with all of it. See src/local/sandbox.ts.
   */
  sandbox?: SandboxReportFrame;
}

/** The machine-readable half of the sandbox report. See src/local/sandbox.ts. */
export interface SandboxReportFrame {
  /** `node-permissions` when Node's permission model was applied, else `none`. */
  filesystem: 'node-permissions' | 'none';
  /** `namespace` when the tool ran with no network at all, else `open`. */
  network: 'namespace' | 'open';
  /** Plain sentences naming everything the sandbox did NOT cover here. */
  notes: string[];
}

/**
 * Why the posture in force is not the one the server asked for.
 *
 * Absent when they match. Each value maps to an operator action, because the
 * whole point of reporting this is that somebody can fix it: the server can
 * say what to do rather than showing a connection that looks healthy while the
 * assistant silently has no tools.
 */
export type PostureReason =
  /** The server sent no `cli_isolation`, so the safe default applies. */
  | 'not_requested'
  /** The server sent a value this bridge does not recognise. */
  | 'unrecognised'
  /** `workspace` needs the operator to have passed `--allow-dir`. */
  | 'requires_allow_dir'
  /** `native` needs the operator to have passed `--allow-native`. */
  | 'requires_allow_native';

/**
 * The isolation posture actually in force, reported once per handshake.
 *
 * The server asks for a posture in `welcome`, and the bridge may decline it:
 * `workspace` and `native` are gated on operator flags, and a bridge started
 * without them runs `isolated` instead. That refusal used to be visible only
 * in a log on the operator's own machine, which made the failure it causes
 * genuinely hard to diagnose — an operator who forgot `--allow-native` gets a
 * connection that looks healthy in every screen while the assistant has no
 * tools at all, and nothing anywhere explains why.
 *
 * Sent whether or not the posture matches, so a server always knows what is in
 * force. Absence of the frame means an older bridge, not agreement.
 *
 * Sent AFTER `welcome`, necessarily: at `hello` time the bridge has not been
 * told what to adopt yet.
 */
export interface PostureMessage {
  type: 'posture';
  /** The posture actually in force. */
  cli_isolation: CliIsolation;
  /** What the server asked for. Null when it asked for nothing. */
  requested: CliIsolation | string | null;
  /** Present only when the two differ. */
  reason?: PostureReason;
  /** A sentence naming the operator action that would change it. */
  message?: string;
}

/** Union of all messages the bridge sends to the server. */
/**
 * What is left of the subscription the CLI on this machine is signed in as.
 *
 * Answers a `usage_request` and echoes its id. The bridge ALWAYS answers, including when it
 * cannot help: a request that goes unanswered is indistinguishable from a bridge too old to
 * know the question, and the server would have to wait out a timeout to find out.
 *
 * The credential itself is never part of this. Only figures cross the wire.
 */
export interface UsageResultMessage {
  type: 'usage_result';
  /** Echoes the id of the usage_request this answers. */
  id: string;
  ok: boolean;
  /** Present when ok. Allowance windows, already labelled, in the order the CLI reports. */
  limits?: UsageLimitFrame[];
  /** Present when not ok: `unsupported`, `no_credential` or `failed`. */
  reason?: string;
}

/** One allowance window. `label` is composed bridge-side; a consumer renders it as given. */
export interface UsageLimitFrame {
  label: string;
  percent: number;
  resets_at?: string;
  kind?: string;
  group?: string;
}

/**
 * Upstream sign-in: every upstream's state, the complete list. Sent once after
 * `welcome` and again whenever an upstream's state, auth or tool count changes.
 */
export interface UpstreamStatusMessage {
  type: 'upstream_status';
  upstreams: {
    server: string;
    transport: 'http' | 'stdio';
    /** http: scheme + host + port only. stdio: null. */
    origin: string | null;
    auth: 'none' | 'secrets' | 'oauth';
    state: 'connecting' | 'connected' | 'needs_auth' | 'unavailable';
    tools: number;
    error: string | null;
  }[];
}

/** Upstream sign-in: a person has to sign in; open `authorization_url` in their browser. */
export interface UpstreamAuthRequiredMessage {
  type: 'upstream_auth_required';
  server: string;
  /** ≥32 random bytes, base64url. Good once, for 10 minutes, until a newer one replaces it. */
  state: string;
  authorization_url: string;
  /** ISO 8601, UTC. */
  expires_at: string;
  reason: 'no_token' | 'refresh_failed' | 'rejected' | 'requested';
}

export type UpstreamAuthResultCode =
  | 'unknown_server' | 'not_oauth' | 'unknown_state' | 'denied' | 'no_redirect_uri'
  | 'discovery_failed' | 'registration_failed' | 'exchange_failed' | 'issuer_mismatch';

/** Upstream sign-in: exactly one per `upstream_auth_code`; also the failure answer to `upstream_auth_start`. */
export type UpstreamAuthResultMessage =
  | { type: 'upstream_auth_result'; server: string; state: string | null; ok: true }
  | { type: 'upstream_auth_result'; server: string; state: string | null; ok: false; code: UpstreamAuthResultCode; error: string };

export type BridgeToServerMessage =
  | UpstreamStatusMessage
  | UpstreamAuthRequiredMessage
  | UpstreamAuthResultMessage
  | McpResultMessage
  | HelloMessage
  | AiRequestAckMessage
  | StreamMessage
  | PingMessage
  | ToolCallMessage
  | BridgeErrorMessage
  | ProvidersUpdateMessage
  | PostureMessage
  | LocalResultMessage
  | UsageResultMessage
  | StreamChunkMessage
  | StreamEndMessage
  | CancelledMessage
  | TurnInputAckMessage
  | UploadDoneMessage
  | FileReadResultMessage
  | AppResultMessage
  | FilesResultMessage;

// ---------------------------------------------------------------------------
// Server -> Bridge Messages
// ---------------------------------------------------------------------------

/**
 * How much the local CLI environment is allowed to influence behaviour.
 *
 * - `isolated` (default): the bridge isolates the spawned CLI from local
 *   influence. Concretely:
 *     • Built-in shell / edit / web tools are blocked (no `bypassPermissions`,
 *       no `danger-full-access`, no `--yolo`). The model can reach
 *       server-declared tools only, via the bridge's MCP server.
 *     • Other MCP servers configured on the operator's machine are ignored
 *       (`--strict-mcp-config` for Claude; per-CLI equivalents where
 *       available).
 *     • `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` auto-discovery is suppressed
 *       (`cwd` is already pinned to an empty temp dir by the bridge; Claude
 *       additionally runs with `--bare` so hooks, auto-memory, keychain
 *       reads, and the user-level `CLAUDE.md` are also off).
 *     • The system prompt is the server's; with none, the CLI keeps its own
 *       default (the bridge writes no system prompt of its own).
 *   This is the right posture when the bridge is reachable by end users.
 *
 * - `native`: the legacy posture, kept as an operator opt-in for the
 *   developer-runs-bridge-against-own-machine case. The MCP server is still
 *   registered, but the CLI runs with its bypass flags AND its local
 *   environment (user CLAUDE.md, skills, hooks, configured MCP servers,
 *   plugins, default system prompt) intact. Never the right choice when the
 *   bridge is reachable by untrusted end users.
 *
 * - `workspace`: the posture that makes a real coding task possible without
 *   handing over the operator's whole environment. The CLI works inside the
 *   server-named `working_dir` with its built-in file and shell tools
 *   ENABLED, while the operator's own MCP servers, hooks, plugins, skills and
 *   user-level instruction files stay out (`--strict-mcp-config` and friends
 *   are kept exactly as in `isolated`), and the system prompt is handled as
 *   in every mode: the server's, or the CLI's own default.
 *
 *   This is NOT a sandbox, and the README says so in as many words: once the
 *   CLI has a shell, `cd ..` and `~/.ssh` are one command away. What bounds it
 *   is that `--allow-dir` is opt-in and empty by default, so a bridge started
 *   without it cannot be pointed anywhere at all.
 *
 * Layer B (HOME / CODEX_HOME / GEMINI_HOME redirection with auth symlinks)
 * would further close `isolated`'s residual user-level leakage for Codex and
 * Gemini — see `tasks/open/cli-isolation-layer-b.md`.
 */
export type CliIsolation = 'native' | 'isolated' | 'workspace';

/** Server acknowledges the hello and provides configuration. */
export interface WelcomeMessage {
  type: 'welcome';
  session_id: string;
  tools: ToolDefinition[];
  config: ServerConfig;
  /** Optional protocol version from the server for compatibility checking. */
  protocol_version?: string;
  /**
   * A fresh connection token, present when the server topped up an aging
   * token at the handshake. The bridge adopts it for subsequent reconnects.
   */
  refreshed_token?: string;
  /**
   * CLI isolation posture. Defaults to `isolated` when absent — older servers
   * that don't send the field get the safe default, never the legacy native
   * behaviour.
   */
  cli_isolation?: CliIsolation;
  /**
   * The bridge version this server wants every machine on, exactly. A bridge
   * that can (`hello.self_update`) fetches it, waits until idle, pins it and
   * restarts onto it, whether it is higher or lower than its own. Strict
   * semver only; anything else is ignored. Absent: no opinion.
   */
  desired_bridge_version?: string;
  /**
   * Upstream sign-in (OAuth): the absolute URL the authorization server sends
   * the browser back to. Absent: this server cannot relay a sign-in, and OAuth
   * upstreams report `needs_auth` with `error: "no_redirect_uri"`.
   */
  upstream_oauth?: { redirect_uri: string };
}

/** Server-provided configuration values. */
export interface ServerConfig {
  /** Heartbeat interval in SECONDS (not milliseconds). */
  heartbeat_interval: number;
  /**
   * Wall-clock ceiling for a single AI request, in seconds.
   *
   * A backstop rather than the working bound — it cannot tell a stuck CLI from
   * a busy one. `0` means the server bounds the turn itself and wants none.
   */
  request_timeout: number;
  /**
   * How long a turn may produce NOTHING before the CLI is presumed wedged.
   *
   * The bound that actually kills, because silence is the only measure that
   * separates stuck from busy. Optional: a server that omits it gets the
   * bridge's default. `0` disables it.
   */
  silence_timeout?: number;
  /**
   * What should happen to a file the assistant hands back.
   *
   * `server` uploads it, which is what has always happened and remains the
   * default when a server does not say. `device` keeps it here and streams it
   * when the server asks, for the case where this machine is somewhere
   * somebody works rather than a processor: the file is one of a thousand on
   * this disk, and sending a copy away takes a copy of their work for no
   * reason.
   *
   * The server decides because only the server knows which of those it is.
   */
  attachments?: 'server' | 'device';
}

/**
 * A person's file is on its way to this machine. The bridge GETs `url` (same
 * origin rules as attachments), writes it to a hidden partial file in
 * `<working_dir>/file-uploads/`, and answers with `upload_done`.
 */
export interface UploadOfferMessage {
  type: 'upload_offer';
  id: string;
  url: string;
  working_dir: string;
  name: string;
  mime_type?: string;
  size: number;
}

/** The server has passed on every byte: what it counted and hashed. */
export interface UploadSentMessage {
  type: 'upload_sent';
  id: string;
  size: number;
  sha256: string;
}

/** Stop receiving `id` and remove whatever arrived. */
export interface UploadAbortMessage {
  type: 'upload_abort';
  id: string;
  reason?: string;
}

/** The answer to `upload_offer`, sent exactly once per offer. `file_id` is
 *  what the server asks for the file by later (`file_read`). */
export type UploadDoneMessage =
  | { type: 'upload_done'; id: string; ok: true; path: string; name: string; size: number; sha256: string; file_id: string }
  | { type: 'upload_done'; id: string; ok: false; code: string; error: string };

/** The server asking for a recorded file, to pipe to a browser. */
export interface FileReadMessage {
  type: 'file_read';
  /** Names the TRANSFER. */
  id: string;
  /** The id this bridge minted when it recorded the file. Never a path. */
  file_id: string;
  /** One-time URL on the connected origin to POST the bytes to. */
  url: string;
  /** The browser's `Range` header, passed through. */
  range?: string;
  /** Only say whether it is there and how big; send no bytes. */
  head?: boolean;
}

export interface FileReadCancelMessage {
  type: 'file_read_cancel';
  id: string;
}

export type FileReadResultMessage =
  | { type: 'file_read_result'; id: string; ok: true; size: number; status: 200 | 206 | 416; start: number; end: number }
  | { type: 'file_read_result'; id: string; ok: false; code: string; error: string };

/** Data payload for `attachment_read` — the server asking for a file this
 *  machine kept. `id` names the TRANSFER, not the file. */
export interface AttachmentReadMessage {
  type: 'attachment_read';
  id: string;
  path: string;
}

/** One piece of a file on its way back. `data` is base64: these are text
 *  frames, and a third more bytes on the wire is cheaper than a second
 *  protocol for binary and a second set of framing bugs to find. */
export interface StreamChunkMessage {
  type: 'stream_chunk';
  id: string;
  data: string;
}

/** The end of a transfer, sent on EVERY path including failure. A server
 *  bounds silence rather than duration, so a bridge that dies quietly costs
 *  the reader that whole window before their download fails. */
export interface StreamEndMessage {
  type: 'stream_end';
  id: string;
  error?: string;
}

/** The reader went away. Stop: otherwise this machine keeps reading a file for
 *  somebody who closed the tab. */
export interface StreamCancelMessage {
  type: 'stream_cancel';
  id: string;
}

/**
 * Stop a turn that is running, and leave a session that can be resumed.
 *
 * The other half of `ai_request`. The server has been sending this since long
 * before the bridge handled it: a person pressing stop, or an abort flag
 * observed mid-turn, put `{"type":"cancel"}` on the wire and the bridge logged
 * "unknown message type" and kept going. The turn ran to its end on somebody's
 * machine, and the server sat waiting for a `cancelled` that was never coming.
 *
 * What the bridge does with it is what it does when one of its own bounds
 * fires: end the CLI's turn cleanly, keep what the turn produced, and report
 * the end of it. A cancelled turn is not an error and is not a failure of the
 * machine; it is a turn that stopped when it was asked to.
 *
 * Unknown ids are ignored rather than answered. A cancel that arrives after the
 * turn ended is the normal race -- somebody pressed stop as the answer landed
 * -- and there is nothing to report about it.
 */
export interface CancelMessage {
  type: 'cancel';
  request_id: string;
}

/**
 * The turn the server asked to stop has stopped.
 *
 * Sent once the CLI has actually gone and the turn's own events have been
 * flushed, not on receipt of the cancel -- so whatever the model managed to
 * write before it was interrupted reaches the server ahead of the terminal.
 */
export interface CancelledMessage {
  type: 'cancelled';
  request_id: string;
  /**
   * On a turn that ran with its input open: the `message_id` of every
   * `turn_input` the bridge accepted and the assistant never read (no
   * `user_input` came for it), oldest first. They are dropped with the turn.
   * Always present on such a turn, empty when nothing was pending; absent on
   * every other turn.
   */
  pending_inputs?: string[];
}

/**
 * A message for a turn that is still running (server → bridge).
 *
 * Only for a turn whose `ai_request_ack` said `input_open: true`. The bridge
 * answers every one with a `turn_input_ack`, straight away.
 */
export interface TurnInputMessage {
  type: 'turn_input';
  request_id: string;
  /** The server's id for this message, echoed on the ack and on `user_input`. */
  message_id: string;
  /** What the person wrote. Text only. */
  content: string;
}

/** Why a `turn_input` was not taken. */
export type TurnInputRejection = 'turn_not_running' | 'turn_ending' | 'input_not_open';

/**
 * The bridge's answer to a `turn_input` (bridge → server).
 *
 * `accepted`: the message was written to the running CLI and is queued there.
 * The assistant reads it at its next step; `user_input` says when.
 *
 * `rejected`: nothing was written.
 *  - `turn_ending`: the turn is still running but will take nothing more —
 *    the bridge closed its input, or it is being stopped (a cancel, a bound, a
 *    dropped connection). Its CLI may still be alive and writing to the
 *    session, so the server holds the message until this request's terminal
 *    frame and only then starts a new turn with it. Starting one sooner would
 *    run a second `--resume` of the session while the first still writes it.
 *  - `turn_not_running`: no turn by that id is running — it never existed, or
 *    it has ended and its terminal frame went out ahead of this ack. The
 *    server starts a normal new turn with it.
 *  - `input_not_open`: the turn is running but cannot take it (it was not
 *    started with `accepts_input`, or the CLI has not reached its first
 *    `system/init` yet), so the server holds it until the turn is over.
 */
export interface TurnInputAckMessage {
  type: 'turn_input_ack';
  request_id: string;
  message_id: string;
  status: 'accepted' | 'rejected';
  /** Present only when rejected. */
  reason?: TurnInputRejection;
}

/** A single prior turn in a conversation's history. */
export interface ConversationEntry {
  role: string;
  content: string;
}

/** A request from the server to run an AI prompt through a local CLI. */
export interface AiRequestMessage {
  type: 'ai_request';
  request_id: string;
  conversation_id: string;
  provider: string;
  message: string;
  system_prompt: string | null;
  /**
   * Text appended to the system prompt of every subagent the assistant starts
   * this turn (nested ones included; not forks, which reuse the main prompt).
   * Provider-neutral on the wire; Claude passes it as
   * `--append-subagent-system-prompt-file` (Claude Code 2.1.261+, skipped with
   * a warning on an older CLI), other providers ignore it (debug log).
   *
   * Per-invocation, like `system_prompt`: not retained across `--resume`, so a
   * server sends it on every turn. Absent, null or empty means none.
   */
  subagent_prompt?: string | null;
  options: AiRequestOptions;
  /**
   * The CLI session to resume, or null to start a fresh session.
   *
   * The server owns this mapping (persisted per conversation) and is the
   * single source of truth — the bridge keeps no session map of its own.
   * Non-null: resume that CLI session. Null: start fresh.
   */
  cli_session_id: string | null;
  /**
   * Prior conversation history, included only when cli_session_id is null so
   * a fresh CLI session can be seeded with context. Omitted/empty when
   * resuming — the resumed CLI session already holds the history.
   */
  history?: ConversationEntry[];
  /**
   * Absolute path the CLI should be spawned in.
   *
   * Absent means today's behaviour exactly: a freshly made empty directory
   * under `~/.cache/ai-bridge/`, which is what keeps a chat-only turn from
   * absorbing whatever happens to be on disk.
   *
   * Present means the server is asking the assistant to work in a real
   * checkout. It is honoured ONLY when the operator passed `--allow-dir` and
   * the path resolves inside one of those roots; otherwise the turn is
   * refused with `working_dir_not_allowed`. There is deliberately no silent
   * fallback to the scratch directory — a turn that appears to succeed while
   * every answer is about an empty directory is the worst available outcome.
   *
   * Fixed for the life of a CLI session: a resume that names a different
   * directory is refused with `working_dir_changed` rather than papered over.
   */
  working_dir?: string;
  /**
   * Files the server wants the assistant to be able to read this turn.
   *
   * The bridge downloads each one to its own cache directory (never into the
   * working directory — the transport must not dirty a checkout), verifies it,
   * and prepends a short preamble to the message naming the absolute paths.
   * Deleted when the turn terminates.
   */
  attachments?: AttachmentRef[];
  /**
   * Environment keys to set or unset on the spawned CLI for this turn.
   *
   * Only keys the bridge allow-lists are honoured (see BRIDGE_ENV_KEYS in
   * src/providers/env.ts); anything else is dropped and named in the ack, so a
   * server on a newer protocol than the bridge degrades rather than fails. A
   * value of `null` or `""` unsets the key, which is how a project removes a
   * bridge default rather than only overwriting it.
   *
   * Absent means the bridge's own defaults, which is the common case and the
   * point of putting the behaviour here rather than in every consuming server.
   */
  bridge_env?: Record<string, string | null>;
  /**
   * How the server wants the bridge's own prompt addendum handled.
   *
   * The addendum carries the session LIFECYCLE — one process per turn, what
   * that means for background work — which the bridge is the only component in
   * a position to know. The server keeps ownership of the voice and the product
   * rules through `system_prompt`; this is beside it, not instead of it.
   *
   * Absent means `default`. See BridgePromptSpec in src/providers/env.ts for
   * the modes and the validation, which is strict: a contradictory spec is
   * refused with `bridge_prompt_invalid` rather than guessed at.
   */
  bridge_prompt?: {
    mode?: 'default' | 'off' | 'append' | 'replace';
    text?: string | null;
  };
}

/**
 * Options that control how the AI request is executed.
 *
 * All fields are optional: absent = "use provider default", null = explicitly
 * "no value".
 */
export interface AiRequestOptions {
  max_tokens?: number | null;
  temperature?: number | null;
  /** Model to use (provider-specific identifier, e.g. "sonnet", "gpt-5.4") */
  model?: string | null;
  /**
   * Keep the CLI's input open for the whole turn, so `turn_input` can reach
   * the assistant while the turn runs. Opt-in, per turn; Claude only. The ack
   * confirms it with `input_open: true`, and without that confirmation nothing
   * about the turn differs from one that did not ask.
   */
  accepts_input?: boolean | null;
  /**
   * Thinking level for the turn: one of `hello.effort_levels`, passed to Claude
   * as `--effort <level>`. Any other value is ignored (the turn still runs, at
   * the CLI's default). Claude only.
   */
  effort?: string | null;
}

/** Server responds with the result of a tool call. */
export interface ToolResolveMessage {
  type: 'tool_resolve';
  request_id: string;
  tool_call_id: string;
  result: unknown;
}

/** Server responds with an error for a tool call. */
export interface ToolErrorMessage {
  type: 'tool_error';
  request_id: string;
  tool_call_id: string;
  error: string;
}

/** Server pong response to a bridge ping. */
export interface PongMessage {
  type: 'pong';
  timestamp: number;
}

/** Server-originated error. */
export interface ErrorMessage {
  type: 'error';
  code: string;
  message: string;
  fatal: boolean;
}

/**
 * Server rejected the connection (bad/expired/revoked token, protocol
 * mismatch, …). Always fatal — the bridge must not reconnect.
 */
export interface ConnectionErrorMessage {
  type: 'connection_error';
  error: string;
  message: string;
}

/** Server hands the bridge a fresh connection token (see WelcomeMessage). */
export interface TokenRefreshMessage {
  type: 'token_refresh';
  token: string;
}

/**
 * The server asks the bridge to run one tool, here, now.
 *
 * Unlike a `welcome`-registered local tool, this is not something a model
 * decided to call: it is a panel or a job on the server invoking a tool a
 * person configured. It still goes through the same gate, so a bridge that was
 * never started with local execution refuses it outright.
 *
 * `space_id` is the tool's space, where its package is installed. `fill` names
 * sealed values by id, each with the space it is sealed in, never a value; a
 * value this device does not hold in that space, as that field of that item,
 * refuses the call.
 */
export interface LocalCallMessage {
  type: 'local_call';
  id: string;
  space_id: string;
  tool: LocalCallTool;
  fill?: ItemFill[];
  /** Passed to the tool as one JSON document on stdin. */
  input?: unknown;
}

/**
 * One request for an Engram app's backend, to run on this machine
 * (PROTOCOL.md, "App backends"). Engram has already checked that the person
 * approved this version and that the endpoint is declared.
 */
export interface AppCallMessage {
  type: 'app_call';
  id: string;
  /** `hash` is the version's content hash: the working copy and the process are keyed on it. */
  app: { space_id: string; name: string; version: number; hash: string };
  /** The version's files, path to sha256; each is fetched as `${base}${sha256}`. */
  files: { base: string; tree: Record<string, string> };
  backend: {
    main: string;
    folders?: { path: string; write: boolean }[];
    shell?: boolean;
    programs?: string[];
    /**
     * The hosts the backend may reach (0.29.0: enforced, see hello.app_network).
     * Engram's own API host and port are always reachable besides these.
     */
    network?: false | string[];
    /**
     * The manifest's `"public_images": true` (0.29.0): the backend may have the
     * bridge fetch images from any public http(s) address, through
     * ENGRAM_IMAGE_FETCH (GET only, images only, 3 MB). Absent means no.
     */
    public_images?: boolean;
  };
  /** Vault roles, filled as for local tools: ENGRAM_<ROLE>_<FIELD> in the process environment. */
  fill?: ItemFill[];
  /**
   * Linked items THIS request uses instead of a role's default (0.22.0,
   * `hello.app_items`). Opened here like `fill`, but handed to the backend on
   * this one request's line as `vault` ({ENGRAM_<ROLE>_<FIELD>: value}), never
   * put in the process's environment, so the process keeps running on the
   * defaults and another request never sees them.
   */
  use?: ItemFill[];
  request: { method: string; path: string; headers?: Record<string, string>; body?: string };
  /** Engram's API for this request, as the person, bounded by the manifest. Passed to the backend. */
  engram: { api: string; token: string };
}

/** The backend's answer, or why there is none. Scrubbed of every sealed value it held. */
export interface AppResultMessage {
  type: 'app_result';
  id: string;
  ok: boolean;
  response?: { status: number; headers: Record<string, string>; body: string };
  error?: string;
}

/** Union of all messages the server sends to the bridge. */
/**
 * Ask the bridge what is left of the subscription its CLI is signed in as.
 *
 * Carries nothing but an id: the bridge already knows which CLI it runs and holds the only
 * credential that could answer, so there is nothing for the server to say. Answered by
 * exactly one `usage_result` echoing the id.
 */
export interface UsageRequestMessage {
  type: 'usage_request';
  id: string;
  /**
   * Which CLI to report on, by the name it is detected under.
   *
   * Optional, but supply it whenever the server knows: a machine can have several CLIs
   * installed, and only the server knows which one is answering a given conversation. Without
   * it the bridge will answer only when the choice is unambiguous, rather than guess and label
   * one subscription's figures as another's.
   */
  provider?: string;
}

/**
 * MCP Apps: a view the server hosts asks its MCP server for
 * something, on behalf of the person looking at it. Only `resources/read` (a
 * ui:// resource) and `tools/call` (a tool its server lets an app call).
 */
export interface McpRequestMessage {
  type: 'mcp_request';
  id: string;
  /** The upstream server, as the `ui.server` of the call's tool_result named it. */
  server: string;
  method: 'resources/read' | 'tools/call';
  params: Record<string, unknown>;
}

/** Upstream sign-in: the person asked to (re)connect `server`. */
export interface UpstreamAuthStartMessage {
  type: 'upstream_auth_start';
  server: string;
}

/** Upstream sign-in: the redirect's query parameters, passed on as they are. */
export interface UpstreamAuthCodeMessage {
  type: 'upstream_auth_code';
  server: string;
  state: string;
  code?: string;
  /** RFC 9207, optional. */
  iss?: string;
  error?: string;
  error_description?: string;
}

/** Upstream sign-in: forget this upstream's tokens on this bridge. */
export interface UpstreamAuthForgetMessage {
  type: 'upstream_auth_forget';
  server: string;
}

export type ServerToBridgeMessage =
  | UpstreamAuthStartMessage
  | UpstreamAuthCodeMessage
  | UpstreamAuthForgetMessage
  | McpRequestMessage
  | WelcomeMessage
  | AiRequestMessage
  | ToolResolveMessage
  | ToolErrorMessage
  | PongMessage
  | ErrorMessage
  | ConnectionErrorMessage
  | TokenRefreshMessage
  | LocalCallMessage
  | UsageRequestMessage
  | AttachmentReadMessage
  | UploadOfferMessage
  | UploadSentMessage
  | UploadAbortMessage
  | FileReadMessage
  | FileReadCancelMessage
  | StreamCancelMessage
  | CancelMessage
  | TurnInputMessage
  | AppCallMessage
  | FilesWriteMessage
  | FilesReadMessage
  | FilesMoveMessage
  | FilesPurgeMessage;

// ---------------------------------------------------------------------------
// Space files (PROTOCOL.md, "Space files"; src/spacefiles/store.ts)
// ---------------------------------------------------------------------------

/** Write a new file into a space's folder; never replaces one. Exactly one source. */
export interface FilesWriteMessage {
  type: 'files_write';
  id: string;
  /** The space's folder: one plain name. */
  space: string;
  /** Relative to it, plain names only. */
  path: string;
  content_base64?: string;
  from_file_id?: string;
  from_path?: string;
  sha256?: string;
}

export interface FilesReadMessage {
  type: 'files_read';
  id: string;
  space: string;
  path: string;
  sha256?: string;
  inline_max?: number;
  serve?: boolean;
}

/** Move within the space without replacing: into `.bin/`, or back out. */
export interface FilesMoveMessage {
  type: 'files_move';
  id: string;
  space: string;
  from: string;
  to: string;
  sha256?: string;
}

/** Remove a file for good; only ever one under `.bin/`. */
export interface FilesPurgeMessage {
  type: 'files_purge';
  id: string;
  space: string;
  path: string;
  sha256?: string;
}

/** The one answer to each of the four. */
export type FilesResultMessage =
  | { type: 'files_result'; id: string; ok: true; path: string; size: number; sha256: string; content_base64?: string; file_id?: string }
  | { type: 'files_result'; id: string; ok: false; code: string; error: string };

// ---------------------------------------------------------------------------
// Stream Event Types and Data
// ---------------------------------------------------------------------------

/** The event type names used inside stream envelopes. */
export type StreamEventType =
  | 'block_start'
  | 'block_delta'
  | 'block_stop'
  | 'tool_result'
  | 'attachment'
  | 'rate_limit'
  | 'task'
  | 'user_input'
  | 'main_state'
  | 'input_closed'
  | 'done'
  | 'error';

/** Block types in the protocol. */
export type BlockType = 'text' | 'thinking' | 'tool_call';

/** Data payload for block_start events. */
export interface BlockStartData {
  block_index: number;
  block_type: BlockType;
  /** For tool_call blocks only. */
  tool_name?: string;
  /** For tool_call blocks only. */
  tool_call_id?: string;
  /**
   * The tool call that spawned the helper (sub-agent) this block belongs to.
   *
   * ABSENT means the main assistant — which is what every block meant before
   * this field existed, so a consumer that ignores it sees exactly what it saw
   * before. Present on text, thinking and tool_call blocks alike: a helper's
   * own prose is still a helper's, not the main assistant's. Matches the
   * `tool_call_id` of the spawning `Agent` block and the `tool_use_id` of the
   * helper's `task` events.
   */
  parent_tool_use_id?: string;
}

/** Data payload for block_delta events. */
export interface BlockDeltaData {
  block_index: number;
  content: string;
}

/** Data payload for block_stop events. */
export interface BlockStopData {
  block_index: number;
}

/** Data payload for tool_result events. */
/**
 * Provider rate-limit status, forwarded as the CLI reports it.
 *
 * Informational and non-terminal — the turn continues. Carried so a server can
 * show what the operator's own CLI already knows (how much of a window is
 * spent, when it resets) rather than discovering a limit by hitting it. The
 * shape is the provider's own, passed through unchanged.
 */
export interface RateLimitData {
  provider: string;
  info: Record<string, unknown>;
}

export interface ToolResultData {
  tool_call_id: string;
  result: string;
  /**
   * Whether the tool reported failure, when the provider says so.
   *
   * The authoritative signal. Reading it out of `result` cannot work: a tool
   * that legitimately prints "Error: no matches" is indistinguishable from one
   * that failed, and the Codex and Gemini adapters additionally prefix their
   * own `Error: ` onto a failed result for historical reasons. Absent when the
   * provider does not report a status.
   */
  is_error?: boolean;
  /**
   * The tool call that spawned the helper whose call this result answers.
   * Absent for the main assistant's own calls. Rides on every chunk of a
   * chunked result, like `is_error`. See BlockStartData.parent_tool_use_id.
   */
  parent_tool_use_id?: string;
  /**
   * MCP Apps: the call was to an MCP server the bridge connects
   * to itself (--mcp-upstreams) and its tool names a view. What the host needs
   * to draw it; the model only got `result`. On the first chunk only.
   */
  ui?: {
    server: string;
    tool_name: string;
    resource_uri: string;
    arguments: Record<string, unknown>;
    /** The whole CallToolResult: content, structuredContent, _meta. */
    result: unknown;
  };
}

/**
 * Which moment of a helper's life a `task` event reports.
 *
 * A string rather than a number on purpose: a wrong string fails loudly at the
 * consumer, a wrong integer is silently a different valid phase.
 */
export type TaskPhase = 'started' | 'progress' | 'updated' | 'finished' | 'heartbeat';

/** What a helper has spent so far, as the CLI counts it. */
export interface TaskUsage {
  total_tokens?: number;
  tool_uses?: number;
  duration_ms?: number;
}

/**
 * Data payload for `task` events — the life of a helper (sub-agent, or
 * background command) the CLI runs on the main assistant's behalf.
 *
 * Informational and non-terminal. Every field but `phase` is optional and
 * absent means "the CLI did not say", never zero. `tool_use_id` is the key a
 * consumer groups by: it is the `tool_call_id` of the spawning block and the
 * `parent_tool_use_id` on the helper's own blocks.
 *
 * A helper is finished ONLY when a `finished` event says so. Its spawning
 * call's `tool_result` is not that signal: a background helper's call returns
 * at once, while the helper works on — possibly after the main assistant has
 * written its whole reply.
 *
 * And the request's terminal frame — `done`, a stream `error`, or `cancelled` —
 * ends every task of that request whatever phase it last reported: a turn cut
 * short (stop, timeout, a crashed CLI) sends no `finished` for its helpers.
 *
 * Never carries the helper's instruction text (the CLI's `prompt`): it is the
 * largest frame in the family, and an oversized non-terminal frame is not
 * trimmed but replaced by a `frame_too_large` stream error, which ends the
 * turn. `description` is what a person reads.
 */
export interface TaskData {
  phase: TaskPhase;
  /**
   * The CLI's own id for the task. Stable across its events, and always
   * introduced by a `started`: the bridge forwards nothing about a task it did
   * not see start in this turn.
   */
  task_id: string;
  /**
   * The tool call that spawned the helper — the key to group by. Present on
   * every phase whenever the CLI named it at `started` (it always has, as of
   * 2.1.280); `updated` and `heartbeat` get it filled in by the bridge, since
   * the CLI omits it or words it differently there.
   */
  tool_use_id?: string;
  /**
   * What kind of task: `local_agent` for a helper, `local_bash` for a background
   * shell command. On every phase when the CLI named it at `started` — the CLI
   * names it only there, and the bridge repeats it.
   */
  task_type?: string;
  /** The helper's kind, e.g. `Explore`, `general-purpose`. */
  subagent_type?: string;
  /** What the helper was asked to do, or on `progress` what it is doing now. */
  description?: string;
  /** 1 for a helper of the main assistant, 2 for a helper's helper, and so on. Started only. */
  spawn_depth?: number;
  /**
   * True when the main assistant does NOT wait for this helper — it is free to
   * reply while the helper works. Started only.
   */
  is_backgrounded?: boolean;
  /** The tool the helper used most recently. Progress only. */
  last_tool_name?: string;
  /** Seconds the spawning call has been running, from the CLI's own clock. Heartbeat only. */
  elapsed_seconds?: number;
  /** How it went: `completed`, `failed`, `stopped`, `killed`… Updated and finished only. */
  status?: string;
  /**
   * The helper's closing report. Finished only. Bounded to 8 KB, cut on a
   * character boundary and marked as cut.
   */
  summary?: string;
  /** Running totals. Progress and finished only. */
  usage?: TaskUsage;
}

/**
 * Data payload for `user_input` events: the assistant has just taken in a
 * message the bridge accepted as `turn_input`.
 *
 * Emitted when the CLI echoes the message back (`--replay-user-messages`),
 * which it does at the moment it dequeues it, so everything after this event
 * in the stream is the assistant's response to it (or later). Messages are
 * read in the order they were accepted.
 */
export interface UserInputData {
  message_id: string;
}

/**
 * Data payload for `main_state` events, on turns that run with their input
 * open: whether the MAIN assistant (not a helper) is working or free.
 *
 * `working` right after the turn starts and whenever the main assistant writes
 * again after having been free; `idle` when its message ends. Never sent twice
 * in a row with the same state. A message sent while it is `idle` is read
 * straight away; one sent while it is `working` is read after its current
 * step.
 */
export interface MainStateData {
  state: 'working' | 'idle';
}

/**
 * Data payload for `input_closed` events, on turns that run with their input
 * open: the bridge has closed the CLI's input, and the turn takes no more
 * messages. Sent at most once per turn, and only while it is still running —
 * the CLI finishes what it has, then `done` follows. Every `turn_input` from
 * here on is answered `turn_ending`.
 *
 * `idle`: the terminal rule — the main assistant has taken in the opening
 * message and is idle, no task it or a helper started is running, and every
 * accepted message has been read. The only reason today; a server must still
 * accept one it does not know, since a later bridge may add others.
 */
export interface InputClosedData {
  /**
   * `idle`: the terminal rule closed it. `leftovers_silent`: the silence bound
   * ran out while the main assistant had answered and only commands left
   * behind by finished helpers were running; the CLI stops those and exits.
   */
  reason: 'idle' | 'leftovers_silent';
  /** With `leftovers_silent`: how many such commands were stopped. */
  stopped_tasks?: number;
}

/**
 * Data payload for `attachment` events — a file the assistant produced and
 * chose to hand back, already uploaded to the server.
 *
 * Emitted only in response to the model calling the bridge-owned
 * `bridge__attach_file` tool. The model nominates the file because nothing
 * else can: a transport cannot guess which of a hundred files it just touched
 * is the answer. A server that does not understand the event ignores it.
 */
export interface AttachmentEventData {
  /**
   * The id the server assigned when the bridge uploaded the file.
   *
   * NULL when the file was KEPT rather than uploaded: nothing uploaded it, so
   * nothing minted an id, and the server makes one when it records the offer.
   */
  id: string | null;
  name: string;
  mime_type: string;
  size: number;
  /**
   * Where the file is on this machine, when it stayed here.
   *
   * Present only in `device` mode, and it is what tells the server the bytes
   * have not been sent. For showing only: the server asks for the file back
   * by `file_id`, never by this path.
   */
  path?: string;
  /** The id this bridge recorded the file under, for `file_read`. `device` mode only. */
  file_id?: string;
  /** Whatever the model said the file is, when it said anything. */
  description?: string;
}

/** Data payload for done events. */
export interface DoneData {
  usage?: TokenUsage;
  /**
   * What the provider reported about the turn, beyond the token counts.
   *
   * All optional and all provider-reported: absent means the CLI did not say,
   * never that the value was zero. The bridge forwards what it is given rather
   * than deciding what a server is interested in.
   */
  /** The model that actually ran, resolved from whatever alias was requested. */
  model?: string | null;
  /** Version of the provider CLI that ran the turn. */
  provider_version?: string | null;
  /** Why the model stopped — e.g. `end_turn`, `max_tokens`. */
  stop_reason?: string | null;
  /** What the provider says the turn cost, in USD. */
  cost_usd?: number | null;
  /** Wall-clock duration of the turn, and of the API portion of it. */
  duration_ms?: number | null;
  duration_api_ms?: number | null;
  /** How many assistant turns the CLI took internally to answer. */
  num_turns?: number | null;
  /**
   * Tool calls the CLI's own permission system refused.
   *
   * Worth surfacing rather than leaving in a log on someone else's machine: in
   * `isolated` this is the record of what the posture actually stopped, and an
   * empty answer with three denials here reads very differently from an empty
   * answer with none.
   */
  permission_denials?: unknown[];
  /**
   * The CLI session id this turn ran under — the id created on a fresh
   * session, or the id resumed. The server persists it on the conversation
   * so the next turn can resume. Null/absent when no session id was produced.
   */
  cli_session_id?: string | null;
  /**
   * What the turn spent on helpers, as the CLI reports it: spawned, completed,
   * failed, max_depth, by_type{} and so on. Passed through unchanged; absent
   * when the CLI did not report it.
   */
  subagent_stats?: Record<string, unknown>;
  /**
   * On a turn that ran with its input open and ended with accepted
   * `turn_input` messages the assistant never read (a timeout, a crash): their
   * `message_id`s, oldest first. Absent when there were none, which is every
   * turn that ended normally.
   */
  pending_inputs?: string[];
}

/** Data payload for error events. */
export interface StreamErrorData {
  code: string;
  message: string;
  /**
   * The limit that was reached, in seconds, on a timeout error.
   *
   * Present for `silence_timeout_exceeded` and `request_timeout_exceeded` so a
   * consumer can say "stopped after 15 minutes" rather than paraphrasing the
   * message, and can tell the two bounds apart without parsing prose.
   */
  limit_seconds?: number;
}

/** Token usage information. */
export interface TokenUsage {
  input_tokens: number | null;
  output_tokens: number | null;
  /**
   * Cache tokens, when the provider reports them.
   *
   * Dominant on a resumed conversation — a turn can read tens of thousands of
   * cached tokens against six new input tokens — so a server showing only
   * input/output understates the turn by an order of magnitude and cannot
   * reconcile its own numbers with the provider's bill.
   */
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** Union of all stream event data payloads. */
export type StreamEventData =
  | BlockStartData
  | BlockDeltaData
  | BlockStopData
  | ToolResultData
  | RateLimitData
  | TaskData
  | UserInputData
  | MainStateData
  | InputClosedData
  | AttachmentEventData
  | DoneData
  | StreamErrorData;
