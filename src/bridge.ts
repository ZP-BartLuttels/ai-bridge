/**
 * Bridge — Core WebSocket management class
 *
 * Connects to the AI Bridge server, handles the protocol handshake,
 * routes AI requests to local provider adapters, and streams results
 * back over the WebSocket.
 *
 * Implements:
 *   - WebSocket connection with exponential backoff reconnection
 *   - Protocol handshake (hello -> welcome)
 *   - AI request routing to providers
 *   - Tool call resolution round-trip
 *   - Heartbeat (ping/pong) — interval in SECONDS from server
 *   - Tool script generation on welcome
 *   - Local HTTP callback server for tool scripts
 *   - Lifecycle event emission
 */

import { MCP_APPS_BRIDGE_REVISION, MCP_APPS_SPEC, UpstreamError, UpstreamHub, type SecretRef, type UpstreamConfig } from './mcp/upstream.js';
import { MCP_UPSTREAM_AUTH_REVISION } from './mcp/oauth.js';
import { createReadStream, statSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import WebSocket from 'ws';
import type {
  ProviderCapability,
  BridgeToServerMessage,
  StreamMessage,
  ServerToBridgeMessage,
  AiRequestMessage,
  CliIsolation,
  PostureReason,
  ConnectionErrorMessage,
  ConversationEntry,
  WelcomeMessage,
  ServerConfig,
  StreamEventType,
  StreamEventData,
  DoneData,
  LocalCallMessage,
  UsageRequestMessage,
  TurnInputMessage,
  FilesWriteMessage,
  FilesReadMessage,
  FilesMoveMessage,
  FilesPurgeMessage,
  SecretListMessage,
  SecretPutMessage,
  SecretSetEndMessage,
  SecretDescribeMessage,
  SecretRemoveMessage,
} from './protocol/types.js';
import { TurnInputPort } from './providers/turn-input.js';
import { PROTOCOL_VERSION, BRIDGE_VERSION } from './protocol/version.js';
import { ProviderAdapter, type ExecutionContext, type AdapterStreamEvent } from './providers/base.js';
import { detectProviders } from './providers/detector.js';
import { readClaudeUsage } from './providers/usage.js';
import { ToolResolver } from './tools/resolver.js';
import { toolResolveAnswer } from './tools/content.js';
import { LOCAL_EXECUTION_OFF, refusalReason, runsLocally, type LocalExecutionConfig } from './local/gate.js';
import { runLocalTool } from './local/executor.js';
import { fillRoles, loadSecrets, sealedRefs, SecretStore, type EngramConfig, type SealedRef } from './local/engram.js';
import { handleLocalCall, stagePackage } from './local/call.js';
import { AppSupervisor } from './apps/supervisor.js';
import { SpaceLimiter } from './local/limits.js';
import type { Identity } from './local/identity.js';
import type { Redaction } from './local/scrub.js';
import { BridgeMcpServer } from './mcp/server.js';
import { rootPaths, toWorkspaceRefs, type AllowedRoot } from './workspace/allowlist.js';
import { resolveWorkingDir, WORKING_DIR_CHANGED } from './workspace/resolve.js';
import {
  resolveBridgeEnv,
  resolveBridgeAddendum,
  validateBridgePrompt,
  BRIDGE_PROMPT_INVALID,
  MAX_BRIDGE_PROMPT_BYTES,
} from './providers/env.js';
import { SessionWorkingDirs, sessionStorePath } from './workspace/sessions.js';
import {
  buildAttachmentPreamble,
  fetchAttachments,
  DEFAULT_ATTACHMENT_LIMITS,
  DEFAULT_ATTACHMENT_TIMEOUTS,
  type AttachmentLimits,
  type AttachmentTimeouts,
  type SavedAttachment,
} from './attachments/fetch.js';
import { AttachmentCache, type AttachmentCacheSettings } from './attachments/cache.js';
import { attachmentDirFor, removeAttachmentDir } from './attachments/store.js';
import {
  ATTACH_FILE_TOOL,
  ATTACH_FILE_TOOL_DEFINITION,
  mimeTypeFor,
  resolveUploadPath,
  uploadAttachment,
  type UploadContext,
} from './attachments/upload.js';
import { assertAllowedAttachmentUrl, resolveApiOrigin } from './attachments/origin.js';
import { FileReadRefusal, openRecorded, resolveRange, ServedFiles } from './attachments/served.js';
import { FilesRefusal, SPACE_FILES_REVISION, SpaceFiles } from './spacefiles/store.js';
import { MACHINE_SECRETS_REVISION, MachineSecrets, SecretRefusal } from './secrets/frames.js';
import { MachineSecretStore, defaultSecretsDir } from './secrets/store.js';
import { APP_NETWORK_REVISION } from './apps/egress.js';
import { APP_CODE_REVISION } from './apps/guard.js';

/** Revision of per-turn isolation (`ai_request.cli_isolation`), advertised as `hello.turn_isolation`. */
export const TURN_ISOLATION_REVISION = 1;
import { CLAUDE_EFFORT_LEVELS } from './providers/claude-effort.js';
import { CLAUDE_THINKING_DISPLAYS } from './providers/claude-thinking-display.js';
import { Readable } from 'node:stream';
import { receiveUpload, type UploadOffer, type UploadSent } from './attachments/receive.js';
import { createLogger } from './utils/logger.js';
import { clampRequestTimeout, clampSilenceTimeout, clampHeartbeat, toSeconds } from './utils/clamp.js';
import { FatalBridgeError, RequestRefusal } from './errors.js';
import { replaceLoneSurrogates } from './providers/result-text.js';
import { StreamOutbox } from './protocol/outbox.js';

export { FatalBridgeError } from './errors.js';

const log = createLogger('Bridge');

// ---------------------------------------------------------------------------
// Configuration & Defaults
// ---------------------------------------------------------------------------

export interface BridgeOptions {
  /** MCP Apps: MCP servers to connect to and offer to the CLI, by name (src/mcp/upstream.ts). */
  mcpUpstreams?: Record<string, UpstreamConfig>;
  /**
   * Where OAuth upstreams' client registrations and tokens are kept
   * (src/mcp/oauth.ts). Default `<AI_BRIDGE_DATA_DIR or ~/.ai-bridge>/mcp-oauth`.
   */
  mcpOAuthDir?: string;
  /**
   * Following the server's desired version (src/selfupdate/). `enabled` is
   * what `hello.self_update` says; `onDesired` gets each welcome's
   * `desired_bridge_version`, undefined when it carried none.
   */
  selfUpdate?: { enabled: boolean; onDesired: (version: unknown) => void };
  /**
   * Called when the server hands over a fresh connection token (welcome or
   * token_refresh), after the bridge adopted it, so the CLI can save it where
   * the next start reads its token from. Errors are logged, never thrown.
   */
  onTokenRefreshed?: (token: string, previous: string) => void;
  /** WebSocket server URL (wss://...). The token never goes in it: see connect(). */
  serverUrl: string;
  /** Authentication token, sent as an Authorization: Bearer header (never in the URL or hello) */
  token: string;
  /** Detected provider capabilities */
  providers: ProviderCapability[];
  /** Provider adapter instances, keyed by provider name */
  adapters: Map<string, ProviderAdapter>;
  /** Whether to run in test mode (mock responses) */
  testMode?: boolean;
  /** Mock response handler for test mode */
  onTestRequest?: (request: AiRequestMessage, sendEvent: (event: StreamEventType, data: StreamEventData) => void) => Promise<void>;
  /**
   * Local execution posture. Absent means off, which is the DungeonMeister
   * shape: a server can mark a tool `local` and the bridge will not run it.
   */
  localExecution?: LocalExecutionConfig;
  /** Where to resolve secrets from. Only consulted when local execution is on. */
  engram?: EngramConfig;
  /** This device's keypair and its id at Engram. */
  identity?: Identity;
  /**
   * Directories a server may name in `ai_request.working_dir`.
   *
   * Absent or empty means none, and every request naming one is refused. Same
   * posture as localExecution above: the operator opts in with `--allow-dir`,
   * and no server can turn it on by sending a field.
   */
  allowedRoots?: AllowedRoot[];
  /**
   * Origin attachments are fetched from and uploaded to. Defaults to the HTTP
   * origin of `serverUrl`; `--api` overrides it for split deployments.
   */
  apiOrigin?: string;
  /** Per-file, per-request and per-request-count attachment caps. */
  attachmentLimits?: AttachmentLimits;
  /** When a stalled or endless attachment download is given up on. */
  attachmentTimeouts?: AttachmentTimeouts;
  /**
   * Where attachments are kept between turns, and for how long.
   *
   * Absent means no store at all, which is what the test suite wants: a
   * default pointing at the operator's real cache would have the suite fill
   * and sweep the store of a bridge that is running on the same machine.
   */
  attachmentCache?: AttachmentCacheSettings & { dir: string };
  /** Keep downloaded attachments after the turn, for debugging. */
  keepAttachments?: boolean;
  /**
   * Where the session→working-directory record is persisted.
   *
   * `null` disables persistence. Exists so the test suite does not write into
   * the operator's real `~/.cache/ai-bridge/sessions.json` — running the tests
   * on a machine with a live bridge used to overwrite that bridge's map with
   * temp paths from the suite.
   */
  sessionStorePath?: string | null;
  /**
   * Where the record of files this bridge will hand back is persisted (see
   * attachments/served.ts). Absent or `null` keeps it in memory only, which is
   * what tests want; the CLI always sets it, per installation and server.
   */
  servedFilesPath?: string | null;
  /**
   * Permit the server to select `native` isolation.
   *
   * Absent means no. `native` is the broadest posture there is, and like
   * `workspace` it must be the operator's choice rather than a field a server
   * can send.
   */
  allowNative?: boolean;
  /**
   * How long a turn re-attached after a reconnect may wait for the server to
   * confirm its first frame on the new connection before the bridge decides
   * the server no longer holds it (PROTOCOL.md, "Short drops"). Default
   * 30 s; exists so tests need not wait that long.
   */
  reattachAckTimeoutMs?: number;
  /**
   * How long the oldest unconfirmed frame of a turn may wait for a
   * `stream_ack` on a live connection before the bridge writes the turn's
   * unconfirmed frames again (PROTOCOL.md, "Short drops"). Default 10 s,
   * doubling after each re-send; exists so tests need not wait that long.
   */
  liveAckTimeoutMs?: number;
  /**
   * Permit a request to ask for Claude Code's built-in WebSearch tool on an
   * `isolated` turn (`options.web_search`, decision 0016).
   *
   * Absent means no, like `allowNative`: a search runs on the operator's Claude
   * account and sends words from the turn to a search backend, so it is the
   * operator's to allow (`--allow-web-search`); hello announces `web_search`
   * only then.
   */
  webSearch?: boolean;
  /**
   * Machine secrets (decision 0020): the operator passed `--machine-secrets`,
   * so the server may manage the store in `~/.ai-bridge/secrets`. Absent or
   * false means off: hello has no `machine_secrets`, and every `secret_*`
   * frame is refused with `machine_secrets_unsupported`.
   */
  machineSecrets?: boolean;
  /** The store's folder; default `~/.ai-bridge/secrets`. For tests. */
  secretsDir?: string;
  /** How often the store's ends are swept while the bridge runs; default 60 s. For tests. */
  secretsSweepMs?: number;
}

const DEFAULT_HEARTBEAT_SECONDS = 30;

/**
 * `welcome.config.reconnect_grace_seconds` when the value is not a number.
 * The two minutes the deliverable names as a short drop: a laptop lid closed
 * and opened, a Wi-Fi switch, a server deploy. Only used for a malformed
 * value; a server that sends a number gets that number.
 */
const DEFAULT_RECONNECT_GRACE_SECONDS = 120;
/**
 * No turn is kept waiting for a server longer than this, whatever it asks.
 * Not a tuning value but a backstop against a bad one: it matches the longest
 * the bridge ever waits for a server's answer to a tool call
 * (TOOL_RESOLVE_TIMEOUT_MAX_S), and the outbox bounds (DEFAULT_OUTBOX_LIMITS)
 * keep memory in check for that long.
 */
const MAX_RECONNECT_GRACE_SECONDS = 3600;
/**
 * See BridgeOptions.reattachAckTimeoutMs. The server acks each frame as it
 * stores it, so a server that holds the turn answers within one round trip;
 * 30 s is the bridge's own heartbeat interval, which is the time it already
 * gives a quiet server before thinking anything of it. A turn whose final
 * frame is still unconfirmed is never given up on this clock (see
 * armReattachCheck()).
 */
const DEFAULT_REATTACH_ACK_TIMEOUT_MS = 30_000;
/**
 * How often a finished turn's unconfirmed final frames are written again
 * before the bridge lets go of them (see armReattachCheck()). The wait doubles
 * each time, from the re-attach timeout: 30 s, 1, 2, 4 and 8 minutes, so a
 * server that never confirms is given about 15 minutes, not forever.
 */
const MAX_FINAL_RESENDS = 4;
/**
 * See BridgeOptions.liveAckTimeoutMs. A server that stores a frame confirms
 * it within about a second (its ack interval), so ten seconds without one on
 * a connection that is up means it did not store it: it failed there, or it
 * came after one that did, and the server stores nothing more of the turn
 * until it is written again.
 */
const DEFAULT_LIVE_ACK_TIMEOUT_MS = 10_000;
/**
 * How often a turn's unconfirmed frames are written again on a live
 * connection without the server confirming anything more, before the bridge
 * gives the turn up (`outbox_unconfirmed`): 10, 20 and 40 s, then 80 s more,
 * so about two and a half minutes. A server with the stall bound
 * (`stream_stall_seconds`, 60 s) ends such a turn itself well before.
 */
const MAX_LIVE_RESENDS = 3;
/*
 * What the assistant is told when work that needs the server cannot happen.
 * These strings are what it acts on, so each says whether the action
 * happened and what to do next, in words it can pass on to the person.
 */
/** Work that waited for the reconnect (a tool call, a file handed back): never sent. */
const NOT_DONE_DROP = 'Not done: the connection to the server was lost and did not come back in time, so nothing was sent '
  + '(no tool was called, no file was handed over). Tell the person it did not happen, and offer to try again once the connection is back.';
const NOT_DONE_SHUTDOWN = 'Not done: the bridge on this machine is shutting down, so nothing was sent '
  + '(no tool was called, no file was handed over). Tell the person it did not happen; it can be tried again once the bridge runs again.';
/** A tool call already sent: the server may have run it, and its answer is gone. */
const RESULT_UNKNOWN_DROP = 'Result unknown: the connection to the server was lost while this tool call was running, so its answer never arrived. '
  + 'The tool may or may not have run, and it was not called again. Check its effect before repeating it, and tell the person if you cannot.';
const RESULT_UNKNOWN_SHUTDOWN = 'Result unknown: the bridge on this machine is shutting down while this tool call was running, so its answer never arrived. '
  + 'The tool may or may not have run. Tell the person, and check its effect before repeating it.';
/** Turn-scoped messages kept through a drop (see heldMessages); the oldest go first past this. */
const MAX_HELD_MESSAGES = 1000;

/**
 * The wall-clock backstop for a turn.
 *
 * Was 300, and 300 seconds of WORK is not a sign of anything wrong: a turn
 * streaming tool results continuously for five minutes is in the healthiest
 * state a long turn has, and it was killed anyway, punctually, mid-work. The
 * bound that separates stuck from busy is silence, below. This one stays as a
 * ceiling and is now high enough to be one.
 */
const DEFAULT_REQUEST_TIMEOUT_SECONDS = 86400;

/** How long a turn may produce NOTHING before the CLI is presumed wedged. */
const DEFAULT_SILENCE_TIMEOUT_SECONDS = 900;

/**
 * Hard ceiling on how long to wait for the server to resolve a tool call.
 *
 * Deliberately NOT the request timeout, which it used to borrow. That value is
 * now a 24-hour backstop, and inheriting it would leave the CLI blocked for a
 * day on a server that simply never answers.
 */
const TOOL_RESOLVE_TIMEOUT_MAX_S = 3600;

// Large-but-finite cap (~24 min of retries with backoff); infinite retry could
// mask configuration errors.
/** A request a WebSocket disconnect aborted, waiting to be reported as over. */
interface DisconnectedTurn {
  requestId: string;
  /** Its input port, on a turn that kept its input open. */
  turnInput: TurnInputPort | null;
  /** The turn has finished running (its CLI is gone). */
  ended: boolean;
  /** The server is back and waiting to hear about it. */
  due: boolean;
  /**
   * Why it is reported: the connection dropped (default), or it outgrew the
   * outbox while the connection was down (`outbox_full`) or while it was up
   * and the server was slow to confirm (`outbox_unconfirmed`), or the other
   * turns together had already filled the outbox (`outbox_shared_full`).
   */
  reason?: 'outbox_full' | 'outbox_unconfirmed' | 'outbox_shared_full';
}

const MAX_RECONNECT_ATTEMPTS = 100;
const BASE_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 15_000; // Cap at 15s per PROTOCOL.md

// How long a fetched set of secrets is trusted. Short because it bounds how
// long a revoked device or a rotated value keeps working; not zero because
// every local tool call would otherwise depend on Engram being reachable.
const SECRETS_TTL_MS = 60_000;
/** How often a bridge with --machine-secrets sweeps the store for passed ends. */
const MACHINE_SECRETS_SWEEP_MS = 60_000;

// ---------------------------------------------------------------------------
// Bridge Events
// ---------------------------------------------------------------------------

export interface BridgeEvents {
  connected: [];
  disconnected: [code: number, reason: string];
  welcome: [sessionId: string];
  error: [error: Error];
  request_start: [requestId: string, provider: string, model?: string | null];
  request_end: [requestId: string];
}

// ---------------------------------------------------------------------------
// Helper: Escape XML characters in message content
// ---------------------------------------------------------------------------

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// Helper: Seed a fresh CLI session with prior conversation history
// ---------------------------------------------------------------------------

/**
 * Fold prior conversation history into the system prompt so a fresh CLI
 * session starts with context.
 *
 * Used when cli_session_id is null but the conversation already has history —
 * e.g. the first turn after the server reset a lost session. History is
 * wrapped in XML tags with escaped content so prior turns cannot be
 * interpreted as authoritative instructions (prompt-injection hardening).
 *
 * Returns null when there is no valid history to fold in.
 */
function buildHistoryBlock(history: ConversationEntry[]): string | null {
  const validRoles = new Set(['user', 'assistant', 'system']);

  const unexpectedRoles = history
    .map((h) => h.role)
    .filter((role) => !validRoles.has(role));
  if (unexpectedRoles.length > 0) {
    log.warn('Conversation history contains unexpected role values', {
      unexpectedRoles: [...new Set(unexpectedRoles)],
    });
  }

  // Exclude entries with unexpected roles to avoid widening the injection
  // surface (an unknown role could be treated as authoritative instructions).
  const priorHistory = history.filter((h) => validRoles.has(h.role));
  if (priorHistory.length === 0) {
    return null;
  }

  const historyXml = priorHistory
    .map((h) => `<message role="${escapeXml(h.role)}">${escapeXml(h.content)}</message>`)
    .join('\n');

  return `<conversation_history>\n${historyXml}\n</conversation_history>`;
}

/**
 * Fold history into the system prompt — for CLIs that take their prompt as a
 * command-line argument. Returns the system prompt unchanged when there is no
 * history. NOTE: a large history makes the resulting `--system-prompt` argument
 * exceed the OS arg-size limit (`spawn E2BIG`); use {@link foldHistoryIntoMessage}
 * for stdin-fed CLIs (Claude) instead.
 */
function foldHistoryIntoSystemPrompt(
  history: ConversationEntry[],
  systemPrompt: string | null,
): string | null {
  const historyBlock = buildHistoryBlock(history);
  if (historyBlock === null) {
    return systemPrompt;
  }

  return systemPrompt ? `${systemPrompt}\n\n${historyBlock}` : historyBlock;
}

/**
 * Fold history into the user message — for Claude, which reads its prompt from
 * STDIN (no argv size limit). The history precedes the current turn. Keeping
 * the (possibly huge) history out of the `--system-prompt` argument is what
 * avoids `spawn E2BIG` on large conversations.
 */
function foldHistoryIntoMessage(
  history: ConversationEntry[],
  message: string,
): string {
  const historyBlock = buildHistoryBlock(history);

  return historyBlock ? `${historyBlock}\n\n${message}` : message;
}

// ---------------------------------------------------------------------------
// Bridge Class
// ---------------------------------------------------------------------------

/** What `adoptIsolation` decided, and why, so the server can be told. */
interface AdoptedPosture {
  adopted: CliIsolation;
  requested: CliIsolation | string | null;
  reason?: PostureReason;
  message?: string;
}

/**
 * Largest frame the bridge will put on the wire.
 *
 * The server's cap is 1MB and it does not answer an oversized message with an
 * error — it answers with a CLOSE_TOO_BIG and the connection goes down, taking
 * every in-flight request with it. So this sits below that, and anything over
 * is reported rather than sent.
 */
const MAX_FRAME_BYTES = 900 * 1024;

export class Bridge extends EventEmitter<BridgeEvents> {
  private ws: WebSocket | null = null;
  private readonly serverUrl: string;
  // Not readonly: the server tops up long-lived tokens, and the bridge adopts
  // the fresh token (via welcome.refreshed_token or a token_refresh message)
  // for subsequent reconnects.
  private token: string;
  private readonly onTokenRefreshed: ((token: string, previous: string) => void) | undefined;
  // Not readonly: re-detected at each handshake and after a provider spawn
  // failure, so a CLI installed or removed mid-life is picked up without a
  // bridge restart. See refreshProviders().
  private providers: ProviderCapability[];
  private readonly adapters: Map<string, ProviderAdapter>;
  private readonly toolResolver = new ToolResolver();
  private readonly localExecution: LocalExecutionConfig;
  private readonly engram?: EngramConfig;
  private readonly identity?: Identity;
  /**
   * Secrets are fetched on the first local tool call that needs one, rather
   * than at startup: a bridge that never runs a local tool should never ask
   * Engram for a credential.
   *
   * Cached with a TTL, and re-fetched early whenever a declared secret is not
   * in the cache. Caching until restart broke the promise this comment used to
   * make: the first call before the device was approved cached an empty map,
   * and the secrets then never appeared, however long the bridge ran and
   * whoever approved it. See secretsFor().
   */
  private secrets?: SecretStore;
  /** When this.secrets was fetched, for the TTL in secretsFor(). */
  private secretsFetchedAt = 0;
  /**
   * How much a single space may run at once, and how fast.
   *
   * On the Bridge rather than per call, because the point is to bound what one
   * space can do over time: a limiter created per call counts to one and stops
   * nothing. See src/local/limits.ts.
   */
  private readonly localLimiter = new SpaceLimiter();
  /**
   * Bridge-side HTTP MCP server. Tools/list returns the welcome's registered
   * tools; tools/call routes through the WebSocket via toolResolver. The
   * server is started lazily on the first welcome that registers any tools.
   */
  private readonly mcpServer: BridgeMcpServer;
  /**
   * The server-supplied CLI isolation posture. Defaults to `isolated` for
   * older servers that don't send the field — the safe default.
   */
  private cliIsolation: CliIsolation = 'isolated';
  /** Registered tools from the most recent welcome — passed to each adapter. */
  private currentTools: import('./protocol/types.js').ToolDefinition[] = [];
  private readonly testMode: boolean;
  private readonly onTestRequest?: BridgeOptions['onTestRequest'];

  private sessionId: string | null = null;
  /** Files going out right now, so a cancel can stop one. */
  private readonly transfers = new Map<string, () => void>();
  /**
   * Person uploads arriving right now, by upload id: how to stop one, and the
   * server's `upload_sent` it is waiting for. The waiter is made when the offer
   * arrives rather than when the download finishes, because that frame can
   * overtake the last bytes of the HTTP body.
   */
  /** The files this bridge will hand back, by the id it minted. */
  private readonly servedFiles: ServedFiles;
  /** A space's kept files, under the first allowed folder (spacefiles/store.ts). */
  private readonly spaceFiles: SpaceFiles;
  /** Files going to the server right now, by transfer id, so a cancel can stop one. */
  private readonly fileReads = new Map<string, AbortController>();
  private readonly incomingUploads = new Map<string, {
    abort: AbortController;
    sent: (value: UploadSent) => void;
  }>();

  /**
   * When each running turn's wall clock runs out, by request id (ms epoch).
   *
   * A tool call's wait has to finish before the turn is killed, or the CLI
   * never gets the tool error the wait exists to produce. The wall clock runs
   * from when the TURN started and a tool wait from when the CALL started, so a
   * static margin only held for calls made early in a turn — a call at 60 s on
   * a 300 s turn still lost the race. Only the time actually left can decide.
   */
  private readonly turnDeadlines = new Map<string, { at: number }>();

  private serverConfig: ServerConfig = {
    heartbeat_interval: DEFAULT_HEARTBEAT_SECONDS,
    request_timeout: DEFAULT_REQUEST_TIMEOUT_SECONDS,
    silence_timeout: DEFAULT_SILENCE_TIMEOUT_SECONDS,
  };
  /** Timer to detect a missing welcome message after hello is sent. */
  private welcomeTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private awaitingPong = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isShuttingDown = false;
  private activeRequests = new Map<string, AbortController>();
  /**
   * Turns the server asked to stop, until each one has finished stopping. See
   * cancelRequest() for why the answer waits.
   */
  private readonly cancelledRequests = new Set<string>();
  /**
   * Turns stopped and no longer in activeRequests (given up, or aborted by a
   * drop) whose CLI has not finished stopping yet, by their controller. Until
   * it has, the bridge is not idle: a restart would lose what the turn still
   * reports (a `pending_inputs` replay, say).
   */
  private readonly stoppingTurns = new Set<AbortController>();
  /**
   * The input port of each running turn that keeps its input open, keyed by
   * request id. See TurnInputPort and handleTurnInput().
   */
  private readonly turnInputs = new Map<string, TurnInputPort>();
  /**
   * Requests aborted because the WebSocket dropped while they were in flight.
   * No terminal event could be sent over the closed socket, so on the next
   * welcome these are replayed as terminal errors to release the browser's
   * loading state. See replayDisconnectedTurn().
   */
  private disconnectedTurns: DisconnectedTurn[] = [];
  /** Monotonic counter for synthesizing tool_call_ids for MCP-originated calls. */
  private mcpToolCallSeq = 0;

  /** Directories a server may name. Empty means none — see BridgeOptions. */
  private readonly allowedRoots: AllowedRoot[];
  /** Cached `allowedRoots` paths, which is all the containment check needs. */
  private readonly allowedRootPaths: string[];
  /** Where attachments come from and go to. */
  private readonly apiOrigin: string;
  /** Engram app backends this bridge runs, one process per app version. */
  private readonly appSupervisor: AppSupervisor;
  private readonly attachmentLimits: AttachmentLimits;
  private readonly attachmentTimeouts: AttachmentTimeouts;
  private readonly attachmentCache: AttachmentCache;
  /** Expires cached attachments on a bridge that is up but not being asked anything. */
  private attachmentSweepTimer: ReturnType<typeof setInterval> | null = null;
  /** Sweeps the machine store's ends (`--machine-secrets`); null until connect(). */
  private secretSweepTimer: ReturnType<typeof setInterval> | null = null;
  private readonly secretsSweepMs: number;
  private readonly keepAttachments: boolean;
  /** Whether the operator permitted the server to select `native`. */
  private readonly allowNative: boolean;
  /** Whether the operator lets a request ask for web search (`--allow-web-search`). */
  private readonly webSearch: boolean;
  /** The machine's secret store (`--machine-secrets`), or null when machine secrets are off. */
  private readonly machineSecrets: MachineSecrets | null;
  /** MCP Apps: MCP servers this bridge connects to itself (src/mcp/upstream.ts). */
  private readonly upstream: UpstreamHub | null;
  private upstreamStarted = false;
  /**
   * In-flight MCP server startup from the current handshake, if any.
   *
   * Requests await it, so a turn sent immediately after `welcome` gets the
   * tool channel rather than racing it.
   */
  private mcpStarting: Promise<void> | null = null;
  /**
   * Which directory each CLI session was started in, so a resume that names a
   * different one can be refused instead of silently running against a
   * session whose whole history is about another checkout.
   */
  private readonly sessionWorkingDirs: SessionWorkingDirs;
  /**
   * Per-request state the bridge-owned MCP tools need.
   *
   * Keyed by request id, which is what the MCP server resolves from the
   * per-spawn bearer token — so a tool call always reads the state of the turn
   * that made it, even with several CLIs running at once.
   */
  private readonly uploadContexts = new Map<string, UploadContext>();

  private readonly selfUpdate: BridgeOptions['selfUpdate'];

  // Reliable delivery (PROTOCOL.md, "Short drops"; src/protocol/outbox.ts).
  /** Each turn's numbered frames until the server confirms them. */
  private readonly outbox = new StreamOutbox();
  /**
   * The grace period the last welcome carried, in seconds; null when that
   * server does not support reliable delivery, which is what turns it all off.
   */
  private reconnectGraceSeconds: number | null = null;
  /** Running while the connection is down and turns are being kept alive. */
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Work that needs the server and is waiting for the reconnect. */
  private serverWaiters: { resolve: () => void; reject: (err: Error) => void }[] = [];
  /**
   * Turns given up on (grace expired, or the server did not take them back):
   * whatever they still emit while unwinding goes out unnumbered, as before.
   */
  private readonly lostTurns = new Set<string>();
  /**
   * Turns the bridge stopped itself (given up on, or aborted for a drop): not
   * one more of their stream frames is written, connected or not, so a cut-off
   * answer never reaches the server looking complete. A turn only let go of for
   * its unconfirmed final frames is not in here: it still sends its `done`.
   */
  private readonly stoppedTurns = new Set<string>();
  /** Re-attached turns waiting for their first confirmation on the new connection. */
  private readonly reattachTimers = new Map<string, ReturnType<typeof setTimeout> | null>();
  /** How often a turn's unconfirmed final frames were written again on this connection. */
  private readonly finalResends = new Map<string, number>();
  private readonly reattachAckTimeoutMs: number;
  /**
   * Turns with frames written on a live connection and not confirmed yet: the
   * timer that checks for progress, and the confirmed seq when it was armed.
   */
  private readonly liveAckChecks = new Map<string, { timer: ReturnType<typeof setTimeout>; acked: number }>();
  /** How often a turn's unconfirmed frames were written again on a live connection without progress. */
  private readonly liveResends = new Map<string, number>();
  private readonly liveAckTimeoutMs: number;
  /**
   * Turns the server said are over on its side (`stream_ack` with `closed`):
   * nothing more of them is sent, until the server starts the id again.
   */
  private readonly closedTurns = new Set<string>();
  /**
   * Turn-scoped messages other than stream frames (`cancelled`,
   * `turn_input_ack`, a turn's `error`, ...) produced while the connection is
   * down in the grace period. Written, in order, after the next welcome.
   */
  private heldMessages: BridgeToServerMessage[] = [];

  constructor(options: BridgeOptions) {
    super();
    this.selfUpdate = options.selfUpdate;
    this.reattachAckTimeoutMs = options.reattachAckTimeoutMs ?? DEFAULT_REATTACH_ACK_TIMEOUT_MS;
    this.liveAckTimeoutMs = options.liveAckTimeoutMs ?? DEFAULT_LIVE_ACK_TIMEOUT_MS;
    // Refused rather than stripped (decision 0013): a token in --server would be
    // logged here and sent in the URL, which every access log on the way keeps.
    let carriesToken = false;
    try { carriesToken = new URL(options.serverUrl).searchParams.has('token'); } catch { /* cli.ts validates the URL itself */ }
    if (carriesToken) {
      throw new Error('--server must not carry a token= query parameter: pass the token with --token or AI_BRIDGE_TOKEN, which sends it in the Authorization header instead of the address that access logs keep');
    }
    this.serverUrl = options.serverUrl;
    this.token = options.token;
    this.onTokenRefreshed = options.onTokenRefreshed;
    this.providers = options.providers;
    this.adapters = options.adapters;
    // Absent means off. A server cannot turn this on by sending a field.
    this.localExecution = options.localExecution ?? LOCAL_EXECUTION_OFF;
    this.engram = options.engram;
    this.identity = options.identity;
    this.testMode = options.testMode ?? false;
    this.onTestRequest = options.onTestRequest;
    // Absent means no directory may be named. A server cannot widen this.
    this.allowedRoots = options.allowedRoots ?? [];
    this.allowedRootPaths = rootPaths(this.allowedRoots);
    this.apiOrigin = options.apiOrigin ?? resolveApiOrigin(options.serverUrl);
    this.appSupervisor = new AppSupervisor({
      config: this.localExecution,
      apiOrigin: this.apiOrigin,
      secrets: (refs) => this.secretsFor(refs),
      ...(this.localExecution.dataDir ? { dataDir: this.localExecution.dataDir } : {}),
    });
    this.attachmentLimits = options.attachmentLimits ?? DEFAULT_ATTACHMENT_LIMITS;
    this.attachmentTimeouts = options.attachmentTimeouts ?? DEFAULT_ATTACHMENT_TIMEOUTS;
    this.attachmentCache = options.attachmentCache
      ? new AttachmentCache(options.attachmentCache.dir, options.attachmentCache)
      : AttachmentCache.disabled();
    this.keepAttachments = options.keepAttachments ?? false;
    this.servedFiles = new ServedFiles(options.servedFilesPath ?? null);
    this.spaceFiles = new SpaceFiles(this.allowedRootPaths, this.servedFiles);
    this.allowNative = options.allowNative ?? false;
    this.webSearch = options.webSearch ?? false;
    this.secretsSweepMs = options.secretsSweepMs ?? MACHINE_SECRETS_SWEEP_MS;
    this.machineSecrets = options.machineSecrets
      ? new MachineSecrets({
        store: new MachineSecretStore(options.secretsDir ?? defaultSecretsDir(), {
          onEnd: (record) => log.info('Machine secret ended', { name: record.name, kind: record.kind }),
        }),
      })
      : null;
    this.upstream = options.mcpUpstreams && Object.keys(options.mcpUpstreams).length
      ? new UpstreamHub(options.mcpUpstreams, {
          resolveSecret: (ref) => this.resolveUpstreamSecret(ref),
          // A server connected, reconnected or changed its tools: the CLI's
          // next tools/list sees the new set.
          onToolsChanged: () => this.registerBridgeTools(),
          // Upstream sign-in (OAuth): tokens stay here; only links and results go out.
          oauthDir: options.mcpOAuthDir ?? join(process.env['AI_BRIDGE_DATA_DIR'] ?? join(homedir(), '.ai-bridge'), 'mcp-oauth'),
          onStatusChanged: () => this.sendUpstreamStatus(),
          sendAuthFrame: (frame) => this.send(frame),
        })
      : null;
    this.sessionWorkingDirs = new SessionWorkingDirs(
      undefined,
      options.sessionStorePath === undefined ? sessionStorePath() : options.sessionStorePath,
    );

    // The MCP server's tool-call handler proxies through the existing
    // toolResolver → WebSocket round-trip. The requestId comes from the
    // per-spawn token the CLI presented, looked up by BridgeMcpServer.
    this.mcpServer = new BridgeMcpServer(async (requestId, toolName, args, providerToolCallId) => {
      // Bridge-owned tools first, and by exact name. These never become a
      // `tool_call` frame: the server has no idea what a path on this machine
      // is, and asking it would be both useless and a disclosure.
      //
      // Gated on the tool actually being REGISTERED, not just on the name. Two
      // things go wrong otherwise: in `isolated` the tool is withheld from
      // tools/list but would still answer if invoked, and a server that
      // declares a tool of its own called `bridge__attach_file` would have it
      // silently hijacked into the bridge's uploader instead of round-tripping.
      // MCP Apps: a tool of an MCP server this bridge connects to
      // itself. Run here; its view, if it names one, goes out with the
      // call's tool_result (see send()).
      // An upstream waiting for a sign-in offers no tools; a call by name
      // (a list the CLI read earlier) says why instead of reaching the server.
      const signIn = this.cliIsolation === 'isolated' ? null : this.upstream?.signInNeeded(toolName);
      if (signIn) throw new Error(signIn);
      if (this.upstream?.owns(toolName) && this.mcpServer.hasBridgeTool(toolName)) {
        const out = await this.upstream.callFromModel(toolName, args, providerToolCallId);
        if (out.isError) throw new Error(out.text);
        return out.text;
      }
      if (toolName === ATTACH_FILE_TOOL && this.mcpServer.hasBridgeTool(ATTACH_FILE_TOOL)) {
        return this.handleAttachFile(requestId, args);
      }

      const tool = this.currentTools.find((t) => t.name === toolName);

      // The one place local execution is decided. A tool the server marked
      // `local` on a bridge that never opted in falls through to the server
      // path, where it fails as any unknown tool does.
      if (runsLocally(this.localExecution, tool)) {
        return this.runToolHere(tool!, args);
      }
      const refused = refusalReason(this.localExecution, tool);
      if (refused) log.warn('refusing a local tool', { name: toolName, reason: refused });

      // A call made while the connection is down (a reliable session in its
      // grace period) waits for the reconnect, then goes out once, on the new
      // connection. It was never sent, so the server cannot run it twice.
      await this.serverReachable();

      const toolCallId = `mcp-${requestId}-${++this.mcpToolCallSeq}`;
      return this.toolResolver.call(
        (reqId, tcId, tName, tArgs) => {
          this.send({
            type: 'tool_call',
            request_id: reqId,
            tool_call_id: tcId,
            tool_name: tName,
            arguments: tArgs,
            ...(providerToolCallId ? { provider_tool_call_id: providerToolCallId } : {}),
          });
        },
        requestId,
        toolCallId,
        toolName,
        args,
        this.toolWaitFor(requestId),
      );
    });

  }

  /**
   * Register the bridge's own tools for the posture just adopted.
   *
   * Not in the constructor, because whether they are offered depends on the
   * isolation posture, which arrives on the welcome. `isolated` is documented
   * as "server-declared tools only", and a bridge-owned tool that performs a
   * network upload is not a server-declared tool — offering it there would
   * make the sentence false and would start an MCP server for a deployment
   * that registered no tools at all, which used to configure none.
   */
  private registerBridgeTools(): void {
    const tools = this.cliIsolation === 'isolated'
      ? []
      : [ATTACH_FILE_TOOL_DEFINITION as unknown as import('./protocol/types.js').ToolDefinition,
         // MCP Apps: the operator's own upstream MCP servers.
         ...(this.upstream?.definitions() ?? [])];

    this.mcpServer.setBridgeTools(tools);
  }

  /**
   * Handle the model calling `bridge__attach_file`.
   *
   * Runs entirely on this machine: the file is read here, uploaded to the
   * server's HTTP API, and announced to the turn as an `attachment` stream
   * event. What the model gets back is a plain sentence, because that is what
   * it can act on — a JSON blob describing an upload tells it nothing useful
   * about whether the user can now see the file.
   */
  private async handleAttachFile(
    requestId: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const ctx = this.uploadContexts.get(requestId);
    if (!ctx) {
      // The turn is over (or was never ours). Refusing beats uploading a file
      // on behalf of a request nobody is listening to any more.
      throw new Error('this turn is no longer active, so the file cannot be sent');
    }

    const rawPath = args['path'];
    const description = typeof args['description'] === 'string' ? args['description'] : undefined;
    if (typeof rawPath !== 'string') {
      throw new Error('path is required and must be a string');
    }

    // Where the file should END UP is the server's call, because only the
    // server knows what this machine is. A machine somebody works on makes
    // files that belong on its own disk; a machine that is only AI compute has
    // no disk anybody can reach once the process ends.
    if (this.serverConfig.attachments === 'device') {
      const path = resolveUploadPath(rawPath, ctx);
      const stat = statSync(path);

      // No id: nothing was uploaded, so nothing minted one. The server makes it
      // and remembers the path, and asks for the bytes if anybody clicks.
      this.sendStreamEvent(requestId, 'attachment', {
        id: null,
        name: basename(path),
        mime_type: mimeTypeFor(path),
        size: stat.size,
        path,
        // What the server asks for it by. The path above is for showing.
        file_id: this.servedFiles.record(path, stat.size, 'handed_back'),
        ...(description ? { description } : {}),
      });

      log.info('Attachment kept on this machine', { requestId, path, size: stat.size });
      return `Offered "${basename(path)}" in the chat. It stays on this machine and is sent only if they open it.`;
    }

    // The upload goes to the server: during a drop it waits for the reconnect
    // rather than failing against a server that is about to come back.
    await this.serverReachable();
    const uploaded = await uploadAttachment(rawPath, description, ctx);

    this.sendStreamEvent(requestId, 'attachment', {
      id: uploaded.id,
      name: uploaded.name,
      mime_type: uploaded.mimeType,
      size: uploaded.size,
      ...(description ? { description } : {}),
    });

    log.info('Attachment sent to server', {
      requestId,
      id: uploaded.id,
      name: uploaded.name,
      size: uploaded.size,
    });

    return `Sent "${uploaded.name}" to the user in the chat.`;
  }

  /**
   * Send a file this machine kept, in pieces, because the server asked.
   *
   * The path came from here originally and it still gets re-resolved: it went
   * out over a socket and came back, so it is input on the way in however it
   * started. Anything outside the working directory is refused, by the same
   * function the upload path uses, so there is one rule rather than two.
   *
   * `stream_end` is sent on EVERY path including failure. The server bounds
   * silence rather than duration, so a bridge that dies quietly costs whoever
   * clicked that whole window before their download gives up.
   */
  private async handleAttachmentRead(message: { id: string; path: string }): Promise<void> {
    // Refused, always. This frame named a PATH, and a server that can name a
    // path can name ~/.ssh: the working-directory check narrowed that, it did
    // not close it. Files are handed back by `file_read` now, by an id this
    // bridge minted when it recorded the file (attachments/served.ts).
    this.send({
      type: 'stream_end',
      id: message.id,
      error: 'This bridge hands files back only by the id it recorded them under (file_read), never by path. '
        + 'The server needs updating.',
    });
  }

  /**
   * Hand a recorded file to the server, which pipes it to the person's browser.
   *
   * Answered first with `file_read_result` -- found and unchanged (with the
   * size and the range that will be sent) or refused with a sentence -- and
   * then, unless it was a HEAD or an empty range, the bytes are POSTed to the
   * one-time URL on the connected origin. Never over the socket.
   */
  private async handleFileRead(message: {
    id: string; file_id: string; url: string; range?: string; head?: boolean;
  }): Promise<void> {
    const { id } = message;
    if (typeof id !== 'string' || !id || this.fileReads.has(id)) return;
    const abort = new AbortController();
    this.fileReads.set(id, abort);
    let answered = false;
    try {
      let url: URL;
      try {
        url = assertAllowedAttachmentUrl(message.url, this.apiOrigin);
      } catch (err) {
        throw new FileReadRefusal('file_refused', err instanceof Error ? err.message : String(err));
      }
      const { handle, file } = await openRecorded(this.servedFiles, message.file_id);
      try {
        const r = resolveRange(message.range, file.size);
        this.send({ type: 'file_read_result', id, ok: true, size: file.size, status: r.status, start: r.start, end: r.end });
        answered = true;
        if (message.head || r.status === 416 || r.end < r.start) return;
        const body = Readable.toWeb(handle.createReadStream({ start: r.start, end: r.end, autoClose: false }));
        const res = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/octet-stream' },
          body: body as unknown as ReadableStream<Uint8Array>,
          duplex: 'half',
          redirect: 'error',
          signal: abort.signal,
        } as RequestInit);
        if (!res.ok) log.warn('The server did not take a file being handed back', { id, status: res.status });
        await res.body?.cancel().catch(() => undefined);
      } finally {
        await handle.close().catch(() => undefined);
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (!answered) {
        const code = error instanceof FileReadRefusal ? error.code : 'file_failed';
        this.send({ type: 'file_read_result', id, ok: false, code, error: text });
      } else if (!abort.signal.aborted) {
        log.warn('Handing a file back failed part way', { id, error: text });
      }
    } finally {
      this.fileReads.delete(id);
    }
  }

  /**
   * A person's file, on its way into this machine's working folder.
   *
   * Answered with exactly one `upload_done`, on every path: the server holds
   * the person's browser request open until it hears, so silence here is a
   * spinner on somebody's screen. See attachments/receive.ts for the rules.
   */
  private async handleUploadOffer(message: UploadOffer & { type: 'upload_offer' }): Promise<void> {
    const id = typeof message.id === 'string' ? message.id : '';
    if (!id || this.incomingUploads.has(id)) return;
    const abort = new AbortController();
    let sent!: (value: UploadSent) => void;
    const sentPromise = new Promise<UploadSent>((resolve) => { sent = resolve; });
    this.incomingUploads.set(id, { abort, sent });
    try {
      const got = await receiveUpload({
        offer: message,
        allowedRoots: this.allowedRootPaths,
        token: () => this.token,
        expectedOrigin: this.apiOrigin,
        maxFileBytes: this.attachmentLimits.maxFileBytes,
        timeouts: this.attachmentTimeouts,
        sent: sentPromise,
        signal: abort.signal,
      });
      // Recorded, so the person can fetch it back later by this id -- and only
      // by this id: see attachments/served.ts.
      const fileId = this.servedFiles.record(got.path, got.size, 'upload');
      log.info('Upload received', { id, path: got.path, size: got.size });
      this.send({ type: 'upload_done', id, ok: true, ...got, file_id: fileId });
    } catch (error) {
      const code = error instanceof RequestRefusal ? error.code : 'upload_failed';
      const text = error instanceof Error ? error.message : String(error);
      log.warn('Upload not received', { id, code, error: text });
      this.send({ type: 'upload_done', id, ok: false, code, error: text });
    } finally {
      this.incomingUploads.delete(id);
    }
  }

  /**
   * One operation on a space's kept files, answered with exactly one
   * `files_result` on every path (spacefiles/store.ts holds the rules).
   */
  private async handleSpaceFiles(
    message: FilesWriteMessage | FilesReadMessage | FilesMoveMessage | FilesPurgeMessage,
  ): Promise<void> {
    const id = typeof message.id === 'string' ? message.id : '';
    if (!id) return;
    try {
      const done = message.type === 'files_write' ? await this.spaceFiles.write(message)
        : message.type === 'files_read' ? await this.spaceFiles.read(message)
          : message.type === 'files_move' ? await this.spaceFiles.move(message)
            : await this.spaceFiles.purge(message);
      log.info('Space file', { op: message.type, path: done.path, size: done.size });
      this.send({ type: 'files_result', id, ok: true, ...done });
    } catch (error) {
      const code = error instanceof FilesRefusal ? error.code : 'files_failed';
      const text = error instanceof Error ? error.message : String(error);
      log.warn('Space file refused', { op: message.type, code, error: text });
      this.send({ type: 'files_result', id, ok: false, code, error: text });
    }
  }

  /**
   * One machine-secrets operation, answered with exactly one `secret_result`
   * on every path. The value is never logged and never in the answer.
   */
  private async handleSecret(
    message: SecretListMessage | SecretPutMessage | SecretSetEndMessage | SecretDescribeMessage | SecretRemoveMessage,
  ): Promise<void> {
    const id = typeof message.id === 'string' ? message.id : '';
    if (!id) return;
    const name = 'name' in message && typeof message.name === 'string' ? message.name : undefined;
    const secrets = this.machineSecrets;
    if (!secrets) {
      log.warn('Machine secret refused: off (no --machine-secrets)', { op: message.type });
      this.send({
        type: 'secret_result', id, ok: false, code: 'machine_secrets_unsupported',
        error: 'This bridge was not started with --machine-secrets, so it does not manage secrets on this machine.',
      });
      return;
    }
    try {
      if (message.type === 'secret_list') {
        const { secrets: rows, ended } = await secrets.list();
        log.info('Machine secrets listed', { count: rows.length });
        this.send({ type: 'secret_result', id, ok: true, secrets: rows, ended });
      } else if (message.type === 'secret_put') {
        const { replaced } = await secrets.put(message.name, message.value, {
          replace: message.replace, description: message.description, endsAt: message.ends_at, endKind: message.end_kind,
        });
        log.info('Machine secret put', { name, replaced, ...(message.ends_at ? { ends: message.end_kind } : {}) });
        this.send({ type: 'secret_result', id, ok: true, replaced });
      } else if (message.type === 'secret_set_end') {
        await secrets.setEnd(message.name, message.ends_at, message.end_kind);
        log.info('Machine secret end set', { name, ends: message.ends_at === null ? 'none' : message.end_kind });
        this.send({ type: 'secret_result', id, ok: true });
      } else if (message.type === 'secret_describe') {
        await secrets.describe(message.name, message.description);
        log.info('Machine secret described', { name });
        this.send({ type: 'secret_result', id, ok: true });
      } else {
        await secrets.remove(message.name);
        log.info('Machine secret removed', { name });
        this.send({ type: 'secret_result', id, ok: true });
      }
    } catch (error) {
      const code = error instanceof SecretRefusal ? error.code : 'failed';
      // Only a SecretRefusal's text is known to hold no value; anything else
      // is reported without its message.
      const text = error instanceof SecretRefusal ? error.message : 'The secret store could not do that.';
      log.warn('Machine secret refused', { op: message.type, name, code });
      this.send({ type: 'secret_result', id, ok: false, code, error: text });
    }
  }

  /** The reader went away. Stop reading: otherwise this machine works through a
   *  file for somebody who closed the tab. */
  private cancelTransfer(id: string): void {
    const stop = this.transfers.get(id);
    this.transfers.delete(id);
    stop?.();
  }

  /**
   * Run a tool on this machine, with the secrets it declared and no others.
   *
   * The secret values never enter a tool_call frame, which is the whole reason
   * this path exists. What goes back to the model is the tool's output with
   * those values redacted, which stops the accidental echo and does not pretend
   * to stop a deliberate one.
   */
  private async runToolHere(
    tool: import('./protocol/types.js').ToolDefinition,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    if (!tool.run?.command) {
      throw new Error(`local tool "${tool.name}" has no command to run`);
    }

    // Each role's item, as the server resolved it: plain fields as values, and
    // sealed ones opened here from the space each names. A tool that fills no
    // role resolves nothing and never asks Engram for anything.
    const fill = tool.fill ?? [];
    const store = await this.secretsFor(sealedRefs(fill));
    const filled = fillRoles(store, fill);
    const granted: Redaction[] = filled.sealed;

    const staged = await stagePackage(tool.package, {
      ...(this.localExecution.dataDir ? { dataDir: this.localExecution.dataDir } : {}),
      spaceId: tool.space_id,
      ...(this.localExecution.workdir ? { fallbackCwd: this.localExecution.workdir } : {}),
    });

    const result = await runLocalTool({
      name: tool.name,
      command: tool.run.command,
      args: tool.run.args ?? [],
      toolArgs: args,
      secrets: granted,
      plain: filled.env,
      ...(staged.cwd ? { cwd: staged.cwd } : {}),
      extraEnv: staged.extraEnv,
      sandbox: {
        ...(tool.network !== undefined ? { network: tool.network } : {}),
        ...(staged.readDir ? { readDir: staged.readDir } : {}),
      },
    });

    return {
      exit_code: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      ...(result.timedOut ? { timed_out: true } : {}),
      // What actually confined the tool, which on some machines is nothing.
      // Reported rather than assumed: see src/local/sandbox.ts.
      sandbox: result.sandbox,
    };
  }

  /**
   * Run one tool because the SERVER asked, rather than because a model did.
   *
   * Same gate, same space check, same limiter, same sandbox. The only thing
   * this adds is the frame: the answer goes back over the WebSocket as a
   * `local_result` carrying the id the call arrived with, so a server that
   * sent ten calls can tell which one answered.
   */
  /**
   * Answer a usage_request, once, whatever happens.
   *
   * Never throws and never stays silent: an unanswered request leaves the asker waiting out
   * a timeout and then unable to tell "this bridge is too old" from "the vendor was slow".
   */
  /**
   * Which CLI a usage_request is about, or null when that cannot be known.
   *
   * The server's answer wins when it gives one. Otherwise this only answers for a machine
   * where there is nothing to be ambiguous about — exactly one CLI installed.
   */
  private usageTargetFor(requested: string | undefined): string | null {
    const available = this.providers.filter((p) => p.available).map((p) => p.name);

    if (typeof requested === 'string' && requested !== '') {
      return available.includes(requested) ? requested : null;
    }

    return available.length === 1 ? (available[0] ?? null) : null;
  }

  private handleUsageRequestMessage(message: UsageRequestMessage): void {
    const target = this.usageTargetFor(message.provider);

    // Only Claude has a subscription allowance to report. Anything else, including "we cannot
    // tell which CLI is meant", is answered as unsupported rather than guessed at: reporting
    // one CLI's subscription while another is answering the conversation is worse than
    // reporting nothing, because the number looks right.
    if (target !== 'claude') {
      this.send({ type: 'usage_result', id: message.id, ok: false, reason: 'unsupported' });
      return;
    }

    readClaudeUsage().then(
      (answer) => {
        this.send(
          answer.ok
            ? { type: 'usage_result', id: message.id, ok: true, limits: answer.limits }
            : { type: 'usage_result', id: message.id, ok: false, reason: answer.reason },
        );
      },
      (err: unknown) => {
        log.error('could not answer a usage_request', {
          id: message.id,
          error: err instanceof Error ? err.message : String(err),
        });
        this.send({ type: 'usage_result', id: message.id, ok: false, reason: 'failed' });
      },
    );
  }

  private handleLocalCallMessage(message: LocalCallMessage): void {
    void handleLocalCall(
      {
        config: this.localExecution,
        limiter: this.localLimiter,
        secrets: (refs) => this.secretsFor(refs),
        ...(this.localExecution.dataDir ? { dataDir: this.localExecution.dataDir } : {}),
      },
      message,
    ).then(
      (result) => this.send(result),
      // handleLocalCall answers rather than throwing, so reaching this means
      // the socket itself failed. Logged rather than left as an unhandled
      // rejection that would take the bridge down mid-session.
      (err: unknown) => log.error('could not answer a local_call', {
        id: message.id,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  /**
   * The secrets available to a tool that declared `wanted`.
   *
   * Three rules, each fixing something a fetch-once cache got wrong:
   *
   * 1. A tool that declares nothing never triggers a fetch, so a bridge whose
   *    local tools need no credential still never asks Engram for one.
   * 2. A declared secret that is not in the cache re-fetches before giving up.
   *    This is the case the old comment claimed and the code did not do: the
   *    first local tool call made before anyone approved the device cached an
   *    empty map, and no approval afterwards could ever be seen without a
   *    restart. It also covers a secret granted to an already-approved device.
   * 3. Anything cached longer than the TTL is re-fetched. A revoked device or a
   *    rotated value is otherwise honoured for the life of the process.
   *
   * What this does NOT cover, deliberately: a revocation is still served from
   * cache for up to the TTL, because the alternative is a network round trip on
   * every tool call and Engram being briefly unreachable would then break tools
   * that have a perfectly good credential in hand. And nothing can recall a
   * value already handed to a running tool. A short window, not zero.
   *
   * A fetch that fails fails the tool call rather than falling back to the
   * cache. From here an unreachable Engram and a revoked device look the same,
   * and the one that must not run is the revoked one.
   */
  /**
   * A value an upstream MCP server's config names instead of holding
   * (src/mcp/upstream.ts): the bridge's own environment, or a sealed value
   * from the Engram vault this device was handed, through the same cache and
   * TTL as local tools.
   */
  private async resolveUpstreamSecret(ref: SecretRef): Promise<string> {
    if ('env' in ref) {
      const v = process.env[ref.env];
      if (v === undefined || v === '') throw new Error(`environment variable ${ref.env} is not set`);
      return (ref.prefix ?? '') + v;
    }
    if (!this.engram || !this.identity?.deviceId) {
      throw new Error('a vault reference needs this bridge enrolled with Engram (--engram) and approved');
    }
    const store = await this.secretsFor([{ space_id: ref.vault.space_id, secret_id: ref.vault.secret_id }]);
    const found = store.byId(ref.vault.space_id, ref.vault.secret_id);
    if (!found) {
      throw new Error(`this device holds no sealed value ${ref.vault.secret_id} in space ${ref.vault.space_id} ` +
        `(hand it that space's key in the Vault page)`);
    }
    return (ref.prefix ?? '') + found.value;
  }

  private async secretsFor(refs: SealedRef[]): Promise<SecretStore> {
    if (refs.length === 0) return new SecretStore();
    if (!this.engram || !this.identity?.deviceId) return this.secrets ?? new SecretStore();

    const fresh = this.secrets !== undefined && Date.now() - this.secretsFetchedAt < SECRETS_TTL_MS;
    // "Complete" is asked value by value, each in the space the call names for
    // it: a value of that id held under some OTHER space does not make this
    // call resolvable.
    const complete = refs.every((r) => this.secrets?.hasId(r.space_id, r.secret_id));
    if (fresh && complete) return this.secrets!;

    this.secrets = await loadSecrets(this.engram, this.identity, this.identity.deviceId);
    this.secretsFetchedAt = Date.now();
    return this.secrets;
  }

  // -------------------------------------------------------------------------
  // Connection Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Initiate the WebSocket connection to the server.
   *
   * The token is sent as an Authorization: Bearer header and nowhere else.
   * Until 0.35.0 it also went in the URL as ?token=, and a URL is written to
   * every access log on the way (a reverse proxy's in particular), so tokens
   * ended up in plain text in logs. Every server half reads the header
   * (Engram's /bridge only ever did; laravel-ai-bridge prefers it).
   *
   * NOTE: When passing --token on the command line the value is still visible
   * in process listings (ps aux).  Prefer the AI_BRIDGE_TOKEN environment
   * variable to avoid this.
   */
  connect(): void {
    if (this.ws) {
      log.warn('connect() called while already connected — ignoring');
      return;
    }

    this.startAttachmentSweeps();
    this.startSecretSweeps();
    // Once per process, like the sweeps: reconnects to the server come through
    // here too, and the upstream connections outlive them. Started in the
    // background; their tools join the bridge's own as each one comes up.
    if (this.upstream && !this.upstreamStarted) {
      this.upstreamStarted = true;
      void this.upstream.start();
    }

    log.info('Connecting to server', { url: this.serverUrl });

    this.ws = new WebSocket(this.serverUrl, {
      headers: {
        'User-Agent': `ai-bridge/${BRIDGE_VERSION}`,
        // The only place the token travels: never the URL, which access logs keep.
        'Authorization': `Bearer ${this.token}`,
      },
      // Limit incoming message size to 10MB to prevent memory exhaustion
      maxPayload: 10 * 1024 * 1024,
    });

    this.ws.on('open', this.onOpen.bind(this));
    this.ws.on('message', this.onMessage.bind(this));
    this.ws.on('close', this.onClose.bind(this));
    this.ws.on('error', this.onError.bind(this));
  }

  /**
   * Sweep the attachment store now, and hourly after that.
   *
   * On start because files may have expired while the bridge was not running,
   * and on a timer because a bridge nobody sends a turn to would otherwise keep
   * them past their TTL for as long as it stays up. After each turn as well —
   * see the request `finally`. Once per process: reconnects come through here
   * too, and the first sweep already happened.
   */
  private startAttachmentSweeps(): void {
    if (this.attachmentSweepTimer !== null || this.attachmentCache.dir === null) return;
    this.attachmentCache.sweep();
    this.attachmentSweepTimer = setInterval(() => this.attachmentCache.sweep(), 60 * 60 * 1000);
    // Housekeeping must never be the thing keeping the process alive.
    this.attachmentSweepTimer.unref();
  }

  /**
   * Handle the machine store's passed ends now, and every minute after that
   * (`--machine-secrets` only). On start because an end may have passed while
   * the bridge was not running; on a timer so a secret ends on time even when
   * nobody reads the store. Every read sweeps as well. Once per process.
   */
  private startSecretSweeps(): void {
    if (this.secretSweepTimer !== null || !this.machineSecrets) return;
    const sweep = (): void => {
      this.machineSecrets?.sweep().catch((err: unknown) => {
        log.warn('Machine secrets sweep failed', { code: err instanceof SecretRefusal ? err.code : 'failed' });
      });
    };
    sweep();
    this.secretSweepTimer = setInterval(sweep, this.secretsSweepMs);
    this.secretSweepTimer.unref();
  }

  /**
   * Gracefully disconnect from the server.
   */
  async disconnect(): Promise<void> {
    this.isShuttingDown = true;
    if (this.attachmentSweepTimer !== null) {
      clearInterval(this.attachmentSweepTimer);
      this.attachmentSweepTimer = null;
    }
    if (this.secretSweepTimer !== null) {
      clearInterval(this.secretSweepTimer);
      this.secretSweepTimer = null;
    }
    this.stopHeartbeat();
    this.clearReconnectTimer();
    this.clearGraceTimer();
    this.rejectServerWaiters(new Error(NOT_DONE_SHUTDOWN));
    this.clearReattachTimers();
    this.toolResolver.cancelAll(RESULT_UNKNOWN_SHUTDOWN);
    for (const upload of this.incomingUploads.values()) upload.abort.abort(new Error('the bridge is shutting down'));
    // A file being handed back streams over its own HTTP request, which would
    // otherwise keep going after the socket that asked for it is gone.
    for (const read of this.fileReads.values()) read.abort();
    // App backends are the bridge's own children: they go with it.
    await this.appSupervisor.stopAll();
    // Upstream MCP servers started over stdio are the bridge's children too.
    await this.upstream?.close();
    await this.mcpServer.stop();

    // Cancel active requests
    for (const [id, controller] of this.activeRequests) {
      controller.abort();
      log.debug('Cancelled active request', { requestId: id });
    }
    this.activeRequests.clear();

    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close(1000, 'Bridge shutting down');
      }
      this.ws = null;
    }

    log.info('Bridge disconnected');
  }

  /**
   * Nothing is in progress: no turn (a sub-agent runs inside one), no turn
   * still stopping, no upload arriving, no file going out either way, no app
   * call. What self-update waits for before it restarts the bridge.
   */
  isIdle(): boolean {
    return this.activeRequests.size === 0
      && this.cancelledRequests.size === 0
      && this.stoppingTurns.size === 0
      && this.incomingUploads.size === 0
      && this.fileReads.size === 0
      && this.transfers.size === 0
      && this.appSupervisor.inFlight() === 0
      // Frames the server has not confirmed yet would be lost with a restart.
      && !this.outbox.hasUnconfirmed();
  }

  /**
   * Returns true if the WebSocket is currently open.
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // -------------------------------------------------------------------------
  // WebSocket Event Handlers
  // -------------------------------------------------------------------------

  private onOpen(): void {
    log.info('WebSocket connected');
    this.reconnectAttempts = 0;
    this.emit('connected');
    this.sendHello();
    // Re-probing happens once handleWelcome() completes the handshake — so
    // any providers_update that fires is strictly post-welcome and never
    // arrives at the server with the connection still pending. See
    // handleWelcome().
  }

  private onMessage(data: WebSocket.RawData): void {
    let message: ServerToBridgeMessage;
    try {
      message = JSON.parse(data.toString()) as ServerToBridgeMessage;
    } catch (err) {
      // Not the parser's message: V8 quotes the start of the text, and a
      // frame may carry a secret's value (secret_put).
      log.error('Failed to parse server message', {
        error: err instanceof Error ? err.name : 'Error',
        bytes: Buffer.isBuffer(data) ? data.length : data.toString().length,
      });
      return;
    }

    log.debug('Received message', { type: message.type });

    switch (message.type) {
      case 'welcome':
        this.handleWelcome(message);
        break;
      case 'stream_ack':
        this.handleStreamAck(message);
        break;
      case 'ai_request':
        this.handleAiRequest(message);
        break;
      case 'tool_resolve': {
        // Content parts (text and images) from a server that read
        // hello.tool_result_content; `result` alone from any other, or with a
        // line saying why the parts were not passed on (src/tools/content.ts).
        this.toolResolver.resolve(
          message.tool_call_id,
          toolResolveAnswer(message.result, message.content, message.tool_call_id),
        );
        break;
      }
      case 'tool_error':
        this.toolResolver.reject(message.tool_call_id, message.error);
        break;
      case 'pong':
        log.debug('Pong received', { timestamp: message.timestamp });
        // Mark pong received and clear the timeout
        this.awaitingPong = false;
        if (this.pongTimeoutTimer) {
          clearTimeout(this.pongTimeoutTimer);
          this.pongTimeoutTimer = null;
        }
        break;
      case 'error':
        this.handleServerError(message);
        break;
      case 'connection_error':
        this.handleConnectionError(message);
        break;
      case 'token_refresh':
        this.adoptRefreshedToken(message.token, 'token_refresh message');
        break;
      case 'usage_request':
        this.handleUsageRequestMessage(message);
        break;

      case 'mcp_request':
        this.handleMcpRequest(message);
        break;
      case 'upstream_auth_start':
      case 'upstream_auth_code':
      case 'upstream_auth_forget':
        this.handleUpstreamAuth(message);
        break;
      case 'app_call':
        void this.appSupervisor.handle(message).then(
          (result) => this.send(result),
          (err: unknown) => log.error('could not answer an app_call', {
            id: message.id, error: err instanceof Error ? err.message : String(err),
          }),
        );
        break;
      case 'local_call':
        this.handleLocalCallMessage(message);
        break;
      case 'attachment_read':
        void this.handleAttachmentRead(message as unknown as { id: string; path: string });
        break;
      case 'stream_cancel':
        this.cancelTransfer((message as unknown as { id: string }).id);
        break;
      case 'file_read':
        void this.handleFileRead(message);
        break;
      case 'file_read_cancel':
        this.fileReads.get(message.id)?.abort();
        break;
      case 'upload_offer':
        void this.handleUploadOffer(message);
        break;
      case 'upload_sent':
        this.incomingUploads.get(message.id)?.sent({ size: message.size, sha256: String(message.sha256 ?? '') });
        break;
      case 'upload_abort':
        this.incomingUploads.get(message.id)?.abort.abort(new Error(message.reason ?? 'the server stopped the upload'));
        break;
      case 'cancel':
        this.cancelRequest((message as unknown as { request_id: string }).request_id);
        break;
      case 'turn_input':
        this.handleTurnInput(message);
        break;
      case 'files_write':
      case 'files_read':
      case 'files_move':
      case 'files_purge':
        void this.handleSpaceFiles(message);
        break;
      case 'secret_list':
      case 'secret_put':
      case 'secret_set_end':
      case 'secret_describe':
      case 'secret_remove':
        void this.handleSecret(message);
        break;
      default:
        log.warn('Unknown message type received', { type: (message as { type: string }).type });
    }
  }

  /**
   * A message for a turn that is still running.
   *
   * Answered at once, always: `accepted` when it was written to the running
   * CLI, `rejected` with the reason otherwise, so the server never has to
   * guess whether a message reached the assistant. The server acts on the
   * reason: `turn_not_running` starts a new turn with it; `turn_ending` and
   * `input_not_open` hold it until this request's terminal frame. The line
   * between the first two is whether this request's CLI can still be alive:
   * a server told `turn_not_running` resumes the session straight away.
   *
   * A frame without a usable request_id, message_id or text is dropped with a
   * warning rather than answered: there is no message to account for, and a
   * server that waits for the ack treats silence as a refusal.
   */
  private handleTurnInput(message: TurnInputMessage): void {
    const { request_id: requestId, message_id: messageId, content } = message as Partial<TurnInputMessage>;
    if (typeof requestId !== 'string' || typeof messageId !== 'string'
      || typeof content !== 'string' || content === '') {
      log.warn('Dropping a malformed turn_input', {
        requestId: typeof requestId === 'string' ? requestId : undefined,
        messageId: typeof messageId === 'string' ? messageId : undefined,
      });

      return;
    }

    const port = this.turnInputs.get(requestId);
    // A turn a dropped connection aborted is no longer "active", but its CLI
    // may still be stopping (see replayDisconnectedTurn): ending, not over.
    const stillStopping = this.disconnectedTurns.some((t) => t.requestId === requestId && !t.ended);
    const outcome = !this.activeRequests.has(requestId)
      ? { status: 'rejected' as const, reason: stillStopping ? 'turn_ending' as const : 'turn_not_running' as const }
      : port === undefined
        ? { status: 'rejected' as const, reason: 'input_not_open' as const }
        : port.offer(messageId, content);

    log.info('Message for a running turn', {
      requestId,
      messageId,
      status: outcome.status,
      ...(outcome.status === 'rejected' ? { reason: outcome.reason } : {}),
    });
    this.send({ type: 'turn_input_ack', request_id: requestId, message_id: messageId, ...outcome });
  }

  /**
   * Will this request run with its input open? The server asks with
   * `options.accepts_input`; only the Claude adapter can do it, and not in
   * test mode, where no CLI runs.
   */
  private acceptsInput(message: AiRequestMessage): boolean {
    return message.options?.accepts_input === true
      && message.provider === 'claude'
      && this.adapters.has('claude')
      && !this.testMode;
  }

  /**
   * Stop a turn because the server asked.
   *
   * The same mechanism a bound uses -- abort the request, which ends the CLI's
   * turn and lets the adapter finalize whatever it had -- so a cancelled turn
   * and a timed-out one leave the session in the same resumable state.
   *
   * An id that is not running is not an error. A cancel racing the answer it
   * was meant to stop is the ordinary case, and answering it would tell the
   * server about a turn that has already been reported.
   *
   * The `cancelled` reply waits for the turn to finish unwinding rather than
   * going out on receipt: the CLI is asked to stop, not shot, so it usually
   * writes a little more before it goes, and the server treats `cancelled` as
   * terminal. Answering immediately would throw away the tail of the very
   * partial answer that stopping cleanly exists to keep.
   */
  private cancelRequest(requestId: string): void {
    const controller = this.activeRequests.get(requestId);
    if (!controller) {
      log.debug('Cancel for a request that is not running', { requestId });

      return;
    }

    log.info('Server asked to stop this turn', { requestId });
    this.cancelledRequests.add(requestId);
    controller.abort();
  }

  private onClose(code: number, reason: Buffer): void {
    const reasonStr = reason.toString();
    log.info('WebSocket closed', { code, reason: reasonStr });
    this.stopHeartbeat();
    // Clear welcome timeout if connection closes before welcome arrives
    if (this.welcomeTimeoutTimer) {
      clearTimeout(this.welcomeTimeoutTimer);
      this.welcomeTimeoutTimer = null;
    }
    this.ws = null;
    // Clear the stale session ID so the welcome-timeout guard on the next
    // reconnect correctly detects a missing welcome.
    this.sessionId = null;

    this.clearReattachTimers();
    // An ack of an old run still on its way is gone with the connection.
    this.outbox.dropStaleAcks();

    // A server with reliable delivery keeps this machine's turns for the grace
    // period, so they keep running here too: their frames wait in the outbox
    // and go out again after the reconnect. Not on a rejected token (4001),
    // which never reconnects.
    const keepTurns = this.reconnectGraceSeconds !== null && !this.isShuttingDown && code !== 4001;

    // Cancel all pending tool resolvers immediately on WebSocket close to fail
    // in-flight tool calls instead of letting them stall. On a kept turn too:
    // the server answers a call over the connection it came in on, so the
    // answer to one in flight is gone with it. Asking again could run the tool
    // twice, so the call fails, and says why.
    this.toolResolver.cancelAll(RESULT_UNKNOWN_DROP);

    // An upload cannot be confirmed over a socket that is gone, so its partial
    // file is removed now rather than when a stall timer notices.
    for (const upload of this.incomingUploads.values()) upload.abort.abort(new Error('the connection to the server dropped'));
    for (const read of this.fileReads.values()) read.abort();

    if (keepTurns) {
      if (this.graceTimer === null) {
        const seconds = this.reconnectGraceSeconds!;
        log.info('Connection dropped; keeping running turns for the grace period', {
          graceSeconds: seconds,
          turns: [...this.activeRequests.keys()],
        });
        this.graceTimer = setTimeout(() => {
          this.graceTimer = null;
          this.endGrace('the grace period ended before the connection came back');
        }, seconds * 1000);
        this.graceTimer.unref?.();
      }
    } else if (!this.isShuttingDown) {
      // Abort all active AI requests on unexpected disconnect so their CLI
      // subprocesses are terminated; otherwise the server never receives a done
      // event and the conversation slot stays blocked until its timeout fires.
      this.abortTurnsForDisconnect();
    }

    this.upstream?.serverDisconnected();
    this.emit('disconnected', code, reasonStr);

    if (!this.isShuttingDown) {
      // Check for authentication rejection — don't retry, exit immediately
      if (code === 4001) {
        // Stop the bridge MCP server before emitting the fatal error.
        this.mcpServer.stop().catch(() => {
          // Best-effort cleanup; ignore errors during shutdown
        });

        this.isShuttingDown = true;
        this.emit(
          'error',
          new FatalBridgeError(
            'Connection rejected: invalid or expired token. Generate a new token from your application\'s dashboard and restart the bridge.',
          ),
        );
        return;
      }

      this.scheduleReconnect();
    }
  }

  /**
   * Stop every running turn because the connection is gone for good (as far
   * as they are concerned), and remember each to be reported as
   * `bridge_disconnected` once a server is back. What reliable delivery was
   * still holding for them is dropped.
   */
  private abortTurnsForDisconnect(): void {
    for (const [id, controller] of this.activeRequests) {
      controller.abort();
      this.stoppingTurns.add(controller);
      // Record the aborted request so it can be replayed as a
      // terminal error after reconnect — with its input port, if it had
      // one, so the replay can say which accepted messages were never read.
      this.disconnectedTurns.push({ requestId: id, turnInput: this.turnInputs.get(id) ?? null, ended: false, due: false });
      this.lostTurns.add(id);
      this.stoppedTurns.add(id);
      log.debug('Aborted active request on disconnect', { requestId: id });
    }
    this.activeRequests.clear();
    // A turn that had already ended here but whose last frames were never
    // confirmed is reported the same way: the server never heard it end.
    for (const id of this.outbox.requestIds()) {
      if (!this.outbox.serverEnded(id) && !this.disconnectedTurns.some((t) => t.requestId === id)) {
        this.disconnectedTurns.push({ requestId: id, turnInput: null, ended: true, due: false });
      }
    }
    this.outbox.clear();
  }

  /**
   * The grace period is over without the server taking the turns back (it
   * ran out, or the server that answered does not do reliable delivery):
   * stop them and report them as today.
   */
  private endGrace(why: string): void {
    this.clearGraceTimer();
    log.warn('Stopping the turns kept through the drop', { reason: why, turns: this.outbox.requestIds() });
    this.rejectServerWaiters(new Error(NOT_DONE_DROP));
    this.abortTurnsForDisconnect();
  }

  private clearGraceTimer(): void {
    if (this.graceTimer !== null) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
  }

  private clearReattachTimers(): void {
    for (const timer of this.reattachTimers.values()) if (timer !== null) clearTimeout(timer);
    this.reattachTimers.clear();
    this.finalResends.clear();
    for (const check of this.liveAckChecks.values()) clearTimeout(check.timer);
    this.liveAckChecks.clear();
    this.liveResends.clear();
  }

  /**
   * Resolves when the server can be reached: at once while connected (or when
   * there is no grace period to wait in, which keeps the old behaviour), else
   * at the next welcome. Rejects if the grace period ends first.
   */
  private serverReachable(): Promise<void> {
    if (this.graceTimer === null || this.isShuttingDown) return Promise.resolve();

    return new Promise((resolve, reject) => this.serverWaiters.push({ resolve, reject }));
  }

  private releaseServerWaiters(): void {
    const waiters = this.serverWaiters;
    this.serverWaiters = [];
    for (const w of waiters) w.resolve();
  }

  private rejectServerWaiters(err: Error): void {
    const waiters = this.serverWaiters;
    this.serverWaiters = [];
    for (const w of waiters) w.reject(err);
  }

  /** Whether a turn's stream frames are numbered and kept (reliable delivery). */
  private numbersFramesOf(requestId: string): boolean {
    return this.reconnectGraceSeconds !== null && !this.lostTurns.has(requestId);
  }

  /** Connected and welcomed: what a numbered frame needs to be written at once. */
  private canWriteStream(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN && this.sessionId !== null;
  }

  /**
   * `stream_ack`: the server stored a turn's frames up to `seq`. Trims the
   * outbox, and lets go of a turn the server has ended once it has ended here.
   */
  private handleStreamAck(message: { request_id?: unknown; seq?: unknown; closed?: unknown }): void {
    const requestId = message.request_id;
    const seq = message.seq;
    if (typeof requestId !== 'string' || typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) {
      log.warn('Dropping a malformed stream_ack');

      return;
    }

    if (message.closed === true) {
      this.closeTurnForServer(requestId);

      return;
    }

    const ackedBefore = this.outbox.lastAcked(requestId);
    const { ended, known } = this.outbox.ack(requestId, seq);
    if (!known) return;
    // The server holds this turn on the new connection.
    const timer = this.reattachTimers.get(requestId);
    if (timer !== undefined) {
      if (timer !== null) clearTimeout(timer);
      this.reattachTimers.delete(requestId);
    }
    this.finalResends.delete(requestId);
    if (ended && !this.activeRequests.has(requestId)) {
      this.outbox.forget(requestId);
      this.clearLiveAckCheck(requestId);

      return;
    }
    // Progress: the live re-send check starts over from its first, short wait
    // (the doubling is for a server that confirms nothing). A duplicate ack
    // leaves it as it is.
    if (this.outbox.lastAcked(requestId) > ackedBefore) this.clearLiveAckCheck(requestId);
    // What is still unconfirmed (re-sent after a reconnect, say) is watched
    // on this connection from now on, even if the turn writes nothing more.
    if (this.outbox.pending(requestId).length > 0 && this.canWriteStream()) this.armLiveAckCheck(requestId);
  }

  /**
   * `stream_ack` with `closed: true`: the turn is over on the server's side
   * (it ended it, or no longer holds it). Nothing of it is kept or sent any
   * more; a turn still running here is stopped the way a cancel stops it,
   * sends no further stream frames, and ends with one unnumbered `cancelled`
   * naming its unread messages (see the request's finally). A turn that had
   * already finished sends nothing.
   */
  private closeTurnForServer(requestId: string): void {
    log.info('The server says this turn is over; letting go of it', { requestId });
    this.outbox.forget(requestId);
    this.clearReattachTimer(requestId);
    this.disconnectedTurns = this.disconnectedTurns.filter((t) => t.requestId !== requestId);
    this.heldMessages = this.heldMessages.filter((m) => (m as { request_id?: unknown }).request_id !== requestId);
    this.cancelledRequests.delete(requestId);
    const controller = this.activeRequests.get(requestId);
    if (controller === undefined) return;
    this.closedTurns.add(requestId);
    controller.abort();
  }

  private clearReattachTimer(requestId: string): void {
    const timer = this.reattachTimers.get(requestId);
    if (timer !== undefined && timer !== null) clearTimeout(timer);
    this.reattachTimers.delete(requestId);
    this.finalResends.delete(requestId);
    this.clearLiveAckCheck(requestId);
  }

  private clearLiveAckCheck(requestId: string): void {
    const check = this.liveAckChecks.get(requestId);
    if (check !== undefined) clearTimeout(check.timer);
    this.liveAckChecks.delete(requestId);
    this.liveResends.delete(requestId);
  }

  /**
   * A numbered frame was just written on a live connection: unless a check is
   * already armed (or the turn is a re-attached one, see armReattachCheck()),
   * check after a while that the server confirmed something more of the turn.
   *
   * A server stores a frame only when it is the next one, so a frame it
   * failed to store (an error there, or the stream store refusing it) holds
   * back every later frame of the turn, `done` included, until it is written
   * again: on a connection that stays up nothing else would write it. When the
   * check finds no progress, every unconfirmed frame of the turn is written
   * again, in order (the server drops the ones it has), and the wait doubles.
   * After MAX_LIVE_RESENDS without progress the turn is given up and reported
   * (`outbox_unconfirmed`), or, when its final frame is among the unconfirmed
   * ones, let go of as in armReattachCheck(): the server may well have it.
   */
  private armLiveAckCheck(requestId: string): void {
    if (this.liveAckChecks.has(requestId) || this.reattachTimers.has(requestId)) return;
    const resends = this.liveResends.get(requestId) ?? 0;
    const acked = this.outbox.lastAcked(requestId);
    const timer = setTimeout(() => {
      this.liveAckChecks.delete(requestId);
      if (this.outbox.pending(requestId).length === 0 || !this.canWriteStream() || this.reattachTimers.has(requestId)) {
        this.liveResends.delete(requestId);

        return;
      }
      if (this.outbox.lastAcked(requestId) > acked) {
        // Confirmed further meanwhile: keep watching what is still unconfirmed.
        this.liveResends.delete(requestId);
        this.armLiveAckCheck(requestId);

        return;
      }
      if (resends >= MAX_LIVE_RESENDS) {
        if (this.outbox.holdsFinal(requestId)) {
          log.warn('The server never confirmed this turn\'s final frames; letting go of them', { requestId, resends });
          this.clearLiveAckCheck(requestId);
          this.outbox.forget(requestId);
          // Only while it still runs: a finished turn sends nothing more, and
          // its marker would never be released (its finally has run).
          if (this.activeRequests.has(requestId)) this.lostTurns.add(requestId);

          return;
        }
        log.error('The server stopped confirming this turn\'s output on a live connection; stopping it', { requestId, resends });
        this.giveUpTurn(requestId, 'outbox_unconfirmed');

        return;
      }
      const frames = this.outbox.pending(requestId);
      log.warn('The server has not confirmed this turn\'s output in time; sending it again', {
        requestId, from: frames[0]!.seq, frames: frames.length, resend: resends + 1,
      });
      this.liveResends.set(requestId, resends + 1);
      for (const frame of frames) this.ws!.send(frame.payload);
      this.armLiveAckCheck(requestId);
    }, this.liveAckTimeoutMs * 2 ** resends);
    timer.unref?.();
    this.liveAckChecks.set(requestId, { timer, acked });
  }

  /**
   * A re-attached turn just had a frame written on the new connection: if the
   * server does not confirm it in time, it no longer holds the turn (its own
   * grace period ran out first, say), and the turn is stopped and reported.
   *
   * Except a turn whose final frame (`done` / `error`) is among the
   * unconfirmed ones: that is a finished answer, and giving up on it would
   * replace the answer with an abort. Its frames are written again on every
   * run-out instead, the wait doubling each time, until the server confirms
   * them or says the turn is closed (`stream_ack` `closed`), or the connection
   * drops again. After MAX_FINAL_RESENDS without a confirmation the bridge
   * lets go of them (logged), so it can become idle again: nothing is
   * reported, because the server may well have the answer.
   */
  private armReattachCheck(requestId: string): void {
    if (this.reattachTimers.get(requestId) !== null) return;
    const resends = this.finalResends.get(requestId) ?? 0;
    this.reattachTimers.set(requestId, setTimeout(() => {
      this.reattachTimers.delete(requestId);
      if (this.outbox.holdsFinal(requestId)) {
        if (!this.canWriteStream()) return;
        if (resends >= MAX_FINAL_RESENDS) {
          log.warn('The server never confirmed this turn\'s final frames; letting go of them', { requestId, resends });
          this.finalResends.delete(requestId);
          this.outbox.forget(requestId);
          // Anything the turn still sends goes out unnumbered, as for a lost
          // turn; only while it still runs (see armLiveAckCheck()).
          if (this.activeRequests.has(requestId)) this.lostTurns.add(requestId);

          return;
        }
        log.warn('The server has not confirmed this turn\'s final frames yet; sending them again', { requestId, resend: resends + 1 });
        this.finalResends.set(requestId, resends + 1);
        this.reattachTimers.set(requestId, null);
        for (const frame of this.outbox.pending(requestId)) this.ws!.send(frame.payload);
        this.armReattachCheck(requestId);

        return;
      }
      log.warn('The server did not take this turn back after the reconnect; stopping it', { requestId });
      this.giveUpTurn(requestId);
    }, this.reattachAckTimeoutMs * 2 ** resends));
  }

  /**
   * Stop a turn reliable delivery can no longer carry, drop what was kept for
   * it, and report it as `bridge_disconnected` (`reason` says why): at once
   * when connected, else after the next welcome; for a turn with its input
   * open, once its CLI has stopped (see replayDisconnectedTurn()).
   */
  private giveUpTurn(requestId: string, reason?: DisconnectedTurn['reason']): void {
    this.outbox.forget(requestId);
    this.clearReattachTimer(requestId);
    const controller = this.activeRequests.get(requestId);
    if (controller !== undefined) {
      // Released by the request's finally, which has not run yet.
      this.lostTurns.add(requestId);
      this.stoppedTurns.add(requestId);
      controller.abort();
      this.activeRequests.delete(requestId);
      this.stoppingTurns.add(controller);
    }
    const turn: DisconnectedTurn = {
      requestId,
      turnInput: controller !== undefined ? this.turnInputs.get(requestId) ?? null : null,
      ended: controller === undefined,
      due: this.sessionId !== null,
      ...(reason !== undefined ? { reason } : {}),
    };
    this.disconnectedTurns.push(turn);
    if (turn.due && (turn.turnInput === null || turn.ended)) this.replayDisconnectedTurn(turn);
  }

  private onError(err: Error): void {
    log.error('WebSocket error', { error: err.message });
    this.emit('error', err);
  }

  // -------------------------------------------------------------------------
  // Protocol Handlers
  // -------------------------------------------------------------------------

  /**
   * Send hello message per PROTOCOL.md:
   * { type: "hello", version, bridge_version, providers[] }
   * NO token field — the token is in the Authorization header.
   * NO id field on providers — just name.
   */
  private sendHello(): void {
    // Advertise only providers whose CLI was actually detected — the server
    // should never offer the user a provider this machine cannot run.
    const availableProviders = this.providers.filter((p) => p.available);
    const runningTurns = this.graceTimer !== null ? this.outbox.runningTurns() : [];
    const hello: BridgeToServerMessage = {
      type: 'hello',
      version: PROTOCOL_VERSION,
      bridge_version: BRIDGE_VERSION,
      providers: availableProviders,
      // Messages for a running turn are understood. Per turn, the ack's
      // `input_open` is still what says a turn takes them.
      turn_input: true,
      // ...and the moment such a turn stops taking them is announced, as the
      // `input_closed` stream event.
      input_closed: true,
      // Person uploads stream straight into the working folder. Advertised
      // whatever the allow-list says: `workspaces` is what tells the server
      // whether there is a folder, and this is only whether the frames are
      // understood.
      file_uploads: true,
      // Recorded files are handed back by id (`file_read`), never by path.
      file_downloads: true,
      // Engram app backends, behind the --local-tools gate (src/apps/supervisor.ts).
      app_backends: true,
      // ...and hands a backend another linked item beside one request (app_call.use).
      app_items: true,
      // tool_resolve.content: a server tool's answer as text and image parts,
      // handed to the CLI as MCP content blocks (src/tools/content.ts).
      tool_result_content: true,
      // MCP Apps: which spec revision and which revision of the bridge's own
      // frames (mcp_request/mcp_result, tool_result.ui, welcome tool _meta,
      // provider_tool_call_id). A server reads its absence as "too old".
      mcp_apps: { spec: MCP_APPS_SPEC, revision: MCP_APPS_BRIDGE_REVISION },
      // Upstream sign-in (OAuth) for --mcp-upstreams servers (src/mcp/oauth.ts):
      // welcome.upstream_oauth, upstream_status, upstream_auth_* frames.
      mcp_upstream_auth: { revision: MCP_UPSTREAM_AUTH_REVISION },
      // A space's kept files (spacefiles/store.ts): the revision of those frames.
      space_files: SPACE_FILES_REVISION,
      // App backends reach only their declared hosts (apps/guard.ts, apps/egress.ts).
      app_network: APP_NETWORK_REVISION,
      // App backends run only the files of the approved version (apps/guard.ts, "code").
      app_code: APP_CODE_REVISION,
      // One turn held to the server's tools (ai_request.cli_isolation, turnPosture).
      turn_isolation: TURN_ISOLATION_REVISION,
      // The levels `options.effort` takes (Claude only; others ignore the option).
      effort_levels: [...CLAUDE_EFFORT_LEVELS],
      // The values `options.thinking_display` takes (Claude only; others ignore it).
      thinking_displays: [...CLAUDE_THINKING_DISPLAYS],
      // `options.web_search` is honoured (Claude, isolated turns; decision 0016).
      // Only when the operator passed --allow-web-search, so the server knows.
      ...(this.webSearch ? { web_search: true } : {}),
      // Machine secrets (decision 0020): only when the operator passed
      // --machine-secrets; a server sends no secret_* frame without it.
      ...(this.machineSecrets ? { machine_secrets: { revision: MACHINE_SECRETS_REVISION } } : {}),
      // The longest bridge_prompt.text this bridge accepts; older bridges took 8 KB.
      bridge_prompt_max_bytes: MAX_BRIDGE_PROMPT_BYTES,
      // Follows welcome.desired_bridge_version by itself (src/selfupdate/).
      self_update: this.selfUpdate?.enabled ?? false,
      // Advertise the operator's allow-list so the server can offer a picker
      // rather than asking a developer to type an absolute path into a chat
      // box. Omitted entirely when empty: "no workspaces" and "this bridge
      // predates workspaces" should look the same to the server, because in
      // both cases naming a directory is refused.
      ...(this.allowedRoots.length > 0
        ? { workspaces: toWorkspaceRefs(this.allowedRoots) }
        : {}),
      // The limits this bridge will enforce, so a server can warn in the
      // composer, with the real number, before anybody waits for an upload —
      // instead of keeping its own copy of them in step by hand.
      attachment_limits: {
        max_file_bytes: this.attachmentLimits.maxFileBytes,
        max_total_bytes: this.attachmentLimits.maxTotalBytes,
        max_count: this.attachmentLimits.maxCount,
      },
      // Numbered, confirmed stream frames, and turns kept through a short drop
      // (PROTOCOL.md, "Short drops"). Used only if the welcome says the server
      // does it too (`config.reconnect_grace_seconds`).
      reliable_delivery: true,
      // A session_lost re-issue carrying first_seq is numbered on from there
      // (PROTOCOL.md, "Short drops", re-issued turns).
      continued_seq: true,
      // After a drop: what this machine still runs or still holds frames of.
      ...(runningTurns.length > 0 ? { running_turns: runningTurns } : {}),
    };
    this.send(hello);
    log.info('Hello sent', {
      protocol: PROTOCOL_VERSION,
      providers: availableProviders.map((p) => p.name),
      workspaces: this.allowedRoots.map((r) => r.label),
      ...(runningTurns.length > 0 ? { runningTurns } : {}),
    });

    // If no welcome arrives within 15s the server silently dropped our hello;
    // close and reconnect so we don't stall forever.
    this.welcomeTimeoutTimer = setTimeout(() => {
      this.welcomeTimeoutTimer = null;
      if (!this.sessionId && !this.isShuttingDown) {
        log.error('Welcome message not received within 15 seconds after hello — reconnecting');
        this.ws?.close(4000, 'Welcome timeout');
      }
    }, 15_000);
  }

  /**
   * Re-probe the local provider CLIs and, if the available set changed since
   * what was last advertised, push a `providers_update` to the server.
   *
   * Called after each handshake (catches a CLI installed or removed while the
   * bridge was offline or before a reconnect) and after a provider spawn
   * failure (catches a CLI removed mid-session — the next request's ENOENT
   * triggers a re-probe so the UI's provider list self-heals).
   *
   * Best-effort: a detection failure is logged and swallowed — it must never
   * disrupt an active connection.
   */
  private async refreshProviders(): Promise<void> {
    let detected: ProviderCapability[];
    try {
      detected = await detectProviders();
    } catch (err) {
      log.warn('Provider re-detection failed — keeping current provider list', {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // detectProviders() probes CLI presence and version only — it does NOT
    // populate `models`. Without re-listing them here, every re-detection
    // advertises model-less providers to the server and empties the chat
    // UI's model dropdowns. Mirror the startup model-population in cli.ts.
    await this.populateModels(detected);

    const signature = (list: ProviderCapability[]): string =>
      list
        .filter((p) => p.available)
        .map((p) => p.name)
        .sort()
        .join(',');

    const before = signature(this.providers);
    const after = signature(detected);
    this.providers = detected;

    if (before === after) {
      return;
    }

    log.info('Available providers changed', { before: before || '(none)', after: after || '(none)' });

    if (this.isConnected()) {
      this.send({
        type: 'providers_update',
        providers: detected.filter((p) => p.available),
      });
      log.info('Sent providers_update to server');
    }
  }

  /**
   * Populate each available provider's `models` list via its adapter.
   *
   * detectProviders() only probes CLI presence/version; model enumeration is
   * a separate per-adapter call. Used by the post-detection refresh path so a
   * re-detection never strips models from the advertised capabilities.
   * Best-effort per provider: a listModels() failure leaves that provider
   * without models rather than aborting the whole refresh.
   */
  private async populateModels(capabilities: ProviderCapability[]): Promise<void> {
    await Promise.all(
      capabilities
        .filter((capability) => capability.available)
        .map(async (capability) => {
          const adapter = this.adapters.get(capability.name);
          if (!adapter) {
            return;
          }
          try {
            capability.models = await adapter.listModels();
          } catch (err) {
            log.warn(`Failed to list models for ${capability.name}`, {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }),
    );
  }

  /**
   * How long one tool call may wait, given how much of its turn is left.
   *
   * The configured wait is already below the turn's bounds; this also keeps it
   * below the time REMAINING on the wall clock, with the same 10% margin, so an
   * unanswered call surfaces as a tool error rather than losing the race to the
   * kill. Undefined means "use the configured wait".
   */
  private toolWaitFor(requestId: string): number | undefined {
    const deadline = this.turnDeadlines.get(requestId);
    if (deadline === undefined) return undefined;

    const remaining = deadline.at - Date.now();
    // Past the deadline but not yet killed: fail the call at once rather than
    // wait on a turn that is about to end regardless.
    const remainingWait = Math.max(1, Math.floor(remaining * 0.9));

    return Math.min(this.toolResolver.timeoutMsValue(), remainingWait);
  }

  private async handleWelcome(message: WelcomeMessage): Promise<void> {
    // Cancel the welcome-timeout now that we've received the welcome.
    if (this.welcomeTimeoutTimer) {
      clearTimeout(this.welcomeTimeoutTimer);
      this.welcomeTimeoutTimer = null;
    }
    this.sessionId = message.session_id;
    // Everything else the server sends is taken as-is, but the two timeouts are
    // reset to the bridge's defaults and only replaced by VALIDATED values below.
    // Assigning `message.config` wholesale put whatever arrived straight into
    // the live config — so a string stayed a string, and a welcome that simply
    // omitted request_timeout ran with no wall clock at all rather than the
    // default. Keeping "the default" for a bad value then kept the bad value.
    this.serverConfig = {
      ...message.config,
      request_timeout: DEFAULT_REQUEST_TIMEOUT_SECONDS,
      silence_timeout: DEFAULT_SILENCE_TIMEOUT_SECONDS,
    };

    // The version the server wants this machine on. Handed over on every
    // welcome, so a deploy that changes it reaches every bridge as it
    // reconnects; absent means the server no longer asks for one.
    this.selfUpdate?.onDesired(message.desired_bridge_version);

    // The server tops up long-lived tokens — adopt a fresh one if offered.
    if (message.refreshed_token) {
      this.adoptRefreshedToken(message.refreshed_token, 'welcome message');
    }

    // Check protocol version compatibility if the server provides one
    if (message.protocol_version) {
      const serverMajor = message.protocol_version.split('.')[0];
      const bridgeMajor = PROTOCOL_VERSION.split('.')[0];
      if (serverMajor !== bridgeMajor) {
        log.warn('Protocol version mismatch — major versions differ', {
          server: message.protocol_version,
          bridge: PROTOCOL_VERSION,
        });
      }
    }

    // Both timeouts go through one reader. A value that is not a number at all
    // — the payload is asserted into shape, not validated — KEEPS THE DEFAULT
    // rather than being clamped: clamping garbage to the 10-second floor made
    // every turn die at ten seconds, the most aggressive bound available, for
    // a server whose only mistake was sending `"900"` instead of `900`. A
    // numeric string is accepted, as it always was. ZERO is meaningful: the
    // server bounds the turn itself.
    const adopt = (
      field: 'request_timeout' | 'silence_timeout',
      clamp: (raw: number) => number,
    ): void => {
      const received: unknown = message.config[field];
      if (received === undefined || received === null) return;

      const seconds = toSeconds(received);
      if (seconds === null) {
        log.warn(`Server ${field} is not a number — keeping the default`, {
          received,
          kept: this.serverConfig[field],
        });

        return;
      }

      const clamped = clamp(seconds);
      if (clamped !== seconds) {
        log.warn(`Server ${field} is outside safe range — clamping`, { received: seconds, clamped });
      }
      this.serverConfig[field] = clamped;
    };
    adopt('request_timeout', clampRequestTimeout);
    // The bound that kills, because it is the only one that can tell a wedged
    // CLI from a working one.
    adopt('silence_timeout', clampSilenceTimeout);

    // Reliable delivery: on only when this server says it does it, by sending
    // its grace period. Against any other server everything stays as before.
    this.adoptReliableDelivery(message.config.reconnect_grace_seconds);

    // How long to wait for the server to answer a tool call: strictly below
    // whichever bound will actually end the turn FIRST.
    //
    // It used to follow silence alone, so a server with a short wall clock —
    // anyone still sending the old `request_timeout: 300` — got an 810-second
    // tool wait on a turn that dies at 300. The unanswered tool call then ended
    // the turn as `request_timeout_exceeded` instead of handing the CLI the tool
    // error this margin exists to produce. Zero means a bound is off, so it is
    // not a candidate.
    const active = [
      this.serverConfig.silence_timeout ?? DEFAULT_SILENCE_TIMEOUT_SECONDS,
      this.serverConfig.request_timeout ?? 0,
    ].filter((v) => v > 0);
    const turnLife = active.length > 0 ? Math.min(...active) : 0;
    const resolveSeconds = turnLife > 0
      // Strictly BELOW the bound: a floor of 10 once returned 10 at a bound of
      // 10 and the two timers raced.
      ? Math.max(1, Math.min(Math.floor(turnLife * 0.9), turnLife - 1))
      : TOOL_RESOLVE_TIMEOUT_MAX_S;
    this.toolResolver.setTimeoutMs(Math.min(resolveSeconds, TOOL_RESOLVE_TIMEOUT_MAX_S) * 1000);

    // Adopt the server's CLI isolation posture. Older servers that don't
    // send the field get the safe default (`isolated`) — never the legacy
    // native behaviour.
    const posture = this.adoptIsolation(message.cli_isolation);
    this.cliIsolation = posture.adopted;
    this.currentTools = message.tools;
    this.mcpServer.setTools(message.tools);
    // After the posture is known — it decides whether they are offered at all.
    this.registerBridgeTools();

    // Tell the server what is actually in force. Sent whether or not it
    // matches what was asked for: a server needs to know the posture, not just
    // be told when it was declined, and absence of this frame means an older
    // bridge rather than agreement.
    this.send({
      type: 'posture',
      cli_isolation: posture.adopted,
      requested: posture.requested,
      ...(posture.reason ? { reason: posture.reason } : {}),
      ...(posture.message ? { message: posture.message } : {}),
    });
    log.info('Welcome registered tools', {
      count: message.tools.length,
      cliIsolation: this.cliIsolation,
    });

    // Start the bridge-side MCP server once tools are present. Spawned CLIs
    // talk to it via per-spawn bearer tokens (see executeAiRequestInternal).
    // The server stays up across reconnects so an in-flight CLI never loses
    // its tool channel mid-turn.
    // hasTools() rather than `message.tools.length > 0`: the bridge owns tools
    // of its own now (bridge__attach_file), and a server that registers none
    // must still get an MCP channel for those.
    if (this.mcpServer.hasTools() && !this.mcpServer.isRunning()) {
      try {
        this.mcpStarting = this.mcpServer.start();
        await this.mcpStarting;
        log.info('MCP tool channel ready', {
          url: this.mcpServer.getBaseUrl(),
          tools: message.tools.map((t) => t.name),
          cliIsolation: this.cliIsolation,
        });
      } catch (err) {
        log.error('Failed to start bridge MCP server', {
          error: err instanceof Error ? err.message : String(err),
        });
        // Notify the server so it can warn the user — all tool calls will fail
        // for this session because the MCP server could not start.
        this.send({
          type: 'error',
          request_id: 'setup',
          code: 'tool_setup_failed',
          message: `Bridge MCP server failed to start — tool calls will not work for this session: ${err instanceof Error ? err.message : String(err)}`,
          fatal: false,
        });
      }
    }

    // Start heartbeat — config.heartbeat_interval is in SECONDS.  Clamp to a
    // safe range to prevent a ping flood or an excessively long dead-connection
    // window.
    const rawHeartbeat = message.config.heartbeat_interval;
    const clampedHeartbeat = clampHeartbeat(rawHeartbeat);
    // Compared as a NUMBER: `"60"` is a valid 60 and needed no clamping, so a
    // strict comparison against the raw string logged a false warning.
    if (clampedHeartbeat !== toSeconds(rawHeartbeat)) {
      log.warn('Server heartbeat_interval is outside safe range — clamping', {
        received: rawHeartbeat,
        clamped: clampedHeartbeat,
      });
    }
    const intervalMs = clampedHeartbeat * 1000;
    this.startHeartbeat(intervalMs);

    log.info('Welcome received', {
      sessionId: this.sessionId,
      toolCount: message.tools.length,
      heartbeatSeconds: message.config.heartbeat_interval,
    });

    this.emit('welcome', this.sessionId);

    // Upstream sign-in: upstream_status once now, and a sign-in link for each
    // OAuth upstream that needs one, through this server's redirect address.
    this.upstream?.serverConnected(upstreamRedirectUri(message));

    // Re-probe the local CLIs now that the handshake is fully complete. The
    // hello above already advertised the last-known set; if detection now
    // finds a different set (a CLI installed or removed since),
    // refreshProviders() pushes a providers_update. Runs in the background
    // and is intentionally post-welcome so any update is unambiguously
    // ordered after the handshake.
    void this.refreshProviders();

    // Replay any requests aborted by a previous disconnect as terminal errors
    // now that the connection is back, so the browser exits its loading state
    // instead of waiting for the server's own timeout.
    for (const turn of [...this.disconnectedTurns]) {
      turn.due = true;
      // An input turn is replayed once it has ENDED, not before: its CLI may
      // still read a queued message on its way out, and the replay's
      // `pending_inputs` has to be the final word on which ones it did not.
      if (turn.turnInput === null || turn.ended) this.replayDisconnectedTurn(turn);
    }
  }

  /**
   * Adopt `welcome.config.reconnect_grace_seconds`, and when this welcome ends
   * a drop the turns were kept through, take up where the old connection left
   * off: every frame the server has not confirmed is written again, in order
   * per turn (the server drops the ones it already has), then the work that
   * waited for the server goes ahead.
   *
   * Absent means the server does not do reliable delivery: nothing is
   * numbered, and if turns were being kept they are stopped and reported as
   * `bridge_disconnected`, exactly as a drop always did.
   */
  private adoptReliableDelivery(raw: unknown): void {
    let grace: number | null = null;
    if (raw !== undefined && raw !== null) {
      const seconds = toSeconds(raw);
      if (seconds === null) {
        log.warn('Server reconnect_grace_seconds is not a number — using the default', {
          received: raw,
          kept: DEFAULT_RECONNECT_GRACE_SECONDS,
        });
      }
      grace = seconds === null
        ? DEFAULT_RECONNECT_GRACE_SECONDS
        : Math.min(Math.max(0, Math.floor(seconds)), MAX_RECONNECT_GRACE_SECONDS);
    }
    this.reconnectGraceSeconds = grace;

    if (this.graceTimer === null) {
      this.flushHeldMessages();

      return;
    }

    if (grace === null) {
      this.endGrace('the server that answered does not keep turns through a drop');
      this.flushHeldMessages();

      return;
    }

    this.clearGraceTimer();
    const turns = this.outbox.requestIds().filter((id) => !this.outbox.serverEnded(id));
    log.info('Reconnected within the grace period; sending what the server has not confirmed', {
      turns: turns.map((id) => ({ requestId: id, lastAcked: this.outbox.lastAcked(id), unconfirmed: this.outbox.pending(id).length })),
    });
    for (const id of turns) {
      // Armed by the first frame written for it on this connection.
      this.reattachTimers.set(id, null);
      const frames = this.outbox.pending(id);
      for (const frame of frames) this.ws!.send(frame.payload);
      if (frames.length > 0) this.armReattachCheck(id);
    }
    // After the frames: a `cancelled` follows the turn's last frame.
    this.flushHeldMessages();
    this.releaseServerWaiters();
  }

  /** Write the turn-scoped messages kept through a drop, in order. */
  private flushHeldMessages(): void {
    const held = this.heldMessages;
    this.heldMessages = [];
    for (const message of held) this.send(message);
  }

  /**
   * Tell the server a request aborted by a disconnect is over.
   *
   * On a turn with its input open, `pending_inputs` names every accepted
   * `turn_input` the assistant never read. A message accepted and read while
   * the socket was down has no `user_input` the server ever saw; without this
   * list it could neither resend (the assistant would read it twice) nor not
   * resend (it might be lost). With it the accounting is exact: accepted and
   * not listed means read.
   */
  private replayDisconnectedTurn(turn: DisconnectedTurn): void {
    this.disconnectedTurns = this.disconnectedTurns.filter((t) => t !== turn);
    log.info('Replaying aborted request as a terminal error', { requestId: turn.requestId });
    this.send({
      type: 'error',
      request_id: turn.requestId,
      code: 'bridge_disconnected',
      message: turn.reason === 'outbox_full'
        ? 'Request stopped: the connection to the server dropped and the answer grew larger than this machine '
          + 'keeps while waiting for it to come back, so the rest of it was lost. Send the message again to retry.'
        : turn.reason === 'outbox_unconfirmed'
          ? 'Request stopped: the server was too slow to confirm the answer, and it grew larger than this machine '
            + 'keeps unconfirmed, so the rest of it was lost. Send the message again, or ask for a shorter answer.'
          : turn.reason === 'outbox_shared_full'
            ? 'Request stopped: this machine was already keeping as much unconfirmed output for other answers as it '
              + 'can, so the rest of this one was lost. Send the message again to retry.'
            : 'Request aborted: the bridge connection dropped while the response was streaming.',
      fatal: false,
      ...(turn.turnInput !== null ? { pending_inputs: turn.turnInput.pending() } : {}),
    });
  }

  /**
   * Decide the isolation posture to actually run under.
   *
   * Two things happen here that must not be skipped.
   *
   * First, the value is VALIDATED against the three literals. Every adapter
   * tests it with `!== 'isolated'` or `!== 'native'`, so an unrecognised
   * string — a typo, a newer server, `"Isolated"` — would land in the
   * permissive branch on one provider and the restrictive branch on another.
   * Anything unknown becomes `isolated`.
   *
   * Second, `workspace` is GATED ON THE OPERATOR'S ALLOW-LIST. Without this
   * the posture is a capability a server can switch on by sending a field:
   * `workspace` is what adds `bypassPermissions` / `workspace-write` /
   * `--yolo`, and none of those care whether a working directory was named.
   * A bridge started with no `--allow-dir` would then still hand a hostile
   * server a shell — in the empty scratch directory, from which `cd ~/.ssh`
   * is one command — while the README promised that such a bridge "cannot be
   * pointed anywhere". The allow-list has to gate the capability, not just
   * the cwd, or the sentence is not true.
   *
   * This mirrors the `--local-tools` gate exactly: the operator opts in, and
   * no server can turn it on by sending a field.
   */
  private adoptIsolation(requested: CliIsolation | undefined): AdoptedPosture {
    if (requested === undefined) {
      // An older server that does not send the field gets the safe default,
      // never the legacy native behaviour.
      return { adopted: 'isolated', requested: null, reason: 'not_requested' };
    }

    if (requested !== 'isolated' && requested !== 'native' && requested !== 'workspace') {
      const message = `Server sent an unrecognised cli_isolation (${String(requested)}) — running \`isolated\`.`;
      log.warn(message);

      return { adopted: 'isolated', requested: String(requested), reason: 'unrecognised', message };
    }

    if (requested === 'workspace' && this.allowedRoots.length === 0) {
      const message =
        'Server asked for `workspace` isolation, but this bridge was started without --allow-dir. '
        + 'Running `isolated` instead: workspace mode gives the CLI a shell on this machine, and '
        + 'that is the operator\'s decision to make, not the server\'s. Pass --allow-dir <path> to enable it.';
      log.warn(message);

      return { adopted: 'isolated', requested, reason: 'requires_allow_dir', message };
    }

    // `native` is gated too, and for the same reason — more so, in fact, since
    // it is strictly MORE permissive than `workspace`: it adds the bypass flags
    // AND drops `--strict-mcp-config`, handing over the operator's own MCP
    // servers, hooks and plugins as well as a shell.
    //
    // Gating only `workspace` would have been security theatre: a server denied
    // the shell one way could simply ask for it the other way, and get more.
    if (requested === 'native' && !this.allowNative) {
      const message =
        'Server asked for `native` isolation, which hands this machine\'s full CLI environment '
        + '— shell, your MCP servers, hooks and plugins — to whatever the server sends. '
        + 'Running `isolated` instead. Pass --allow-native if the server is one you would give a shell to.';
      log.warn(message);

      return { adopted: 'isolated', requested, reason: 'requires_allow_native', message };
    }

    return { adopted: requested, requested };
  }

  /**
   * Handle an incoming ai_request: send ack, then execute.
   *
   * The server owns the conversation→CLI-session mapping. `message.cli_session_id`
   * is the session to resume (non-null) or null to start fresh. On a fresh
   * start, `message.history` (when present) is folded into the system prompt
   * so the new CLI session is seeded with context — e.g. the first turn after
   * the server reset a lost session.
   */
  private handleAiRequest(message: AiRequestMessage): void {
    const { request_id } = message;
    const cliSessionId = message.cli_session_id ?? null;

    // The same request id again is the server's `session_lost` re-issue. Its
    // frames are numbered on from `first_seq` when the server says so (it
    // does for a bridge that announced `continued_seq`), so a re-send of the
    // old run's frames is a duplicate there; else from 1 again, as an older
    // server expects (PROTOCOL.md, "Short drops", re-issued turns).
    this.lostTurns.delete(request_id);
    this.stoppedTurns.delete(request_id);
    this.closedTurns.delete(request_id);
    const firstSeq = message.first_seq;
    const continued = typeof firstSeq === 'number' && Number.isInteger(firstSeq) && firstSeq >= 1;
    // The re-issue itself shows the server holds the turn: a re-attach check
    // left from the old run (its ack may be late) must not give up the new one.
    if (continued || this.outbox.has(request_id)) this.clearReattachTimer(request_id);
    if (continued && this.numbersFramesOf(request_id)) this.outbox.continueAt(request_id, firstSeq);
    else if (this.outbox.has(request_id)) this.outbox.restart(request_id);
    else if (this.numbersFramesOf(request_id)) this.outbox.open(request_id);

    // A contradictory bridge_prompt is refused before anything acts on it: a
    // turn whose instructions are not what either side believes is worse than
    // a turn that did not run. Checked ahead of the ack so the echo below
    // never describes a turn that was never going to happen.
    const promptError = validateBridgePrompt(message.bridge_prompt);
    if (promptError) {
      log.warn('Refusing request', {
        requestId: request_id,
        code: BRIDGE_PROMPT_INVALID,
        reason: promptError,
      });
      this.send({ type: 'ai_request_ack', request_id, cli_session_id: cliSessionId });
      this.sendStreamEvent(request_id, 'error', {
        code: BRIDGE_PROMPT_INVALID,
        message: promptError,
      });
      this.sendStreamEvent(request_id, 'done', {});
      return;
    }

    // Acknowledge receipt, echoing the session the server asked us to use and
    // what the bridge resolved for this turn's session defaults. The echo is
    // what lets a server assert it got what it asked for, instead of inferring
    // it from the assistant's behaviour several turns later.
    //
    // Resolved twice — here and again in executeRequest — because both are
    // pure functions of the request. Passing the object along instead would
    // couple the ack path to the execution path for no benefit, and the
    // execution path must resolve it anyway on the `session_lost` re-issue,
    // which does not come back through here.
    const acceptsInput = this.acceptsInput(message);
    const envResolution = resolveBridgeEnv(message.bridge_env, { acceptsInput });
    this.send({
      type: 'ai_request_ack',
      request_id,
      cli_session_id: cliSessionId,
      bridge_session: {
        prompt_mode: message.bridge_prompt?.mode ?? 'default',
        prompt_server_text: Boolean(message.bridge_prompt?.text),
        env_overridden: envResolution.overridden,
        env_rejected: envResolution.rejected,
      },
      // Only when it is true. Absent is how every older bridge answers, and a
      // server reads it as "hold messages as before".
      ...(acceptsInput ? { input_open: true as const } : {}),
    });

    // Fresh session: seed the new CLI session with any prior history the
    // server sent. A resumed session already holds its own context. WHERE the
    // history goes depends on how the provider delivers its prompt: Claude
    // reads the user prompt from STDIN (no size limit), so fold history into
    // the message — folding a large history into the `--system-prompt` argument
    // would blow the OS arg-size limit (`spawn E2BIG`). Argument-fed CLIs
    // (Codex/Gemini) keep history in the system prompt as before.
    let effectiveMessage = message;
    if (cliSessionId === null && message.history && message.history.length > 0) {
      log.debug('Seeding fresh CLI session with prior history', {
        conversationId: message.conversation_id,
        historyLength: message.history.length,
        provider: message.provider,
      });
      effectiveMessage = message.provider === 'claude'
        ? {
            ...message,
            message: foldHistoryIntoMessage(message.history, message.message),
          }
        : {
            ...message,
            system_prompt: foldHistoryIntoSystemPrompt(message.history, message.system_prompt),
          };
    }

    this.executeAiRequestInternal(effectiveMessage, cliSessionId);
  }

  /**
   * Internal request execution: resolve the adapter and run the request.
   * Does NOT send ai_request_ack — handleAiRequest does that.
   */
  private executeAiRequestInternal(
    message: AiRequestMessage,
    cliSessionId: string | null,
  ): void {
    const { request_id, provider } = message;

    // Test mode: use mock handler
    if (this.testMode && this.onTestRequest) {
      this.emit('request_start', request_id, provider, message.options?.model);
      const sendEvent = (event: StreamEventType, data: StreamEventData) => {
        this.sendStreamEvent(request_id, event, data);
      };
      this.onTestRequest(message, sendEvent)
        .catch((err) => {
          log.error('Test mode handler failed', {
            error: err instanceof Error ? err.message : String(err),
          });
          this.sendStreamEvent(request_id, 'error', {
            code: 'test_error',
            message: err instanceof Error ? err.message : String(err),
          });
          this.sendStreamEvent(request_id, 'done', {});
        })
        .finally(() => {
          this.emit('request_end', request_id);
        });
      return;
    }

    // Find the adapter for the requested provider
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      log.error('No adapter for requested provider', { provider });
      const installHints: Record<string, string> = {
        codex: ' Install the Codex CLI (https://github.com/openai/codex) on the machine running the bridge and restart it.',
        claude: ' Install the Claude CLI (https://claude.ai/download) on the machine running the bridge and restart it.',
        gemini: ' Install the Gemini CLI (https://github.com/google-gemini/gemini-cli) on the machine running the bridge and restart it.',
      };
      const hint = installHints[provider] ?? '';
      // Nothing will run, so nothing is kept for it: a later drop must not
      // list it as running or report it as disconnected.
      this.outbox.forget(request_id);
      this.send({
        type: 'error',
        request_id,
        code: 'provider_unavailable',
        message: `Provider "${provider}" is not available on this bridge.${hint}`,
        fatal: true,
      });
      return;
    }

    this.emit('request_start', request_id, provider, message.options?.model);

    // Execute asynchronously
    const controller = new AbortController();
    this.activeRequests.set(request_id, controller);
    // Created before the turn runs, so a `turn_input` that arrives before the
    // CLI is up is answered `input_not_open` rather than `turn_not_running`.
    const turnInput = this.acceptsInput(message) ? new TurnInputPort() : null;
    if (turnInput !== null) this.turnInputs.set(request_id, turnInput);

    this.executeRequest(adapter, message, cliSessionId, controller.signal, turnInput)
      .catch((err) => {
        const errMessage = err instanceof Error ? err.message : String(err);
        const wasResumeAttempt = cliSessionId !== null;

        // Anything that fails BECAUSE the turn was cancelled is the cancel,
        // and has to be reported as one. This has to come first, ahead of both
        // branches below.
        //
        // The work before the CLI even starts takes the same signal: aborting
        // during an attachment download rejects the fetch, which surfaces as a
        // RequestRefusal saying the attachment "could not be fetched" — a
        // server may reasonably treat that as transient and try again. Worse on
        // a resumed turn, where the branch below turns ANY failure into
        // `session_lost`: the server would wipe the session and silently
        // re-issue the very turn somebody had just stopped.
        //
        // The cost: a POLICY refusal that happens to race a cancel — a refused
        // working directory, an attachment on another host — loses its code and
        // is reported as a turn that simply ended. Nothing ran either way, the
        // reason is in the log line below, and the refusal recurs on the next
        // attempt, so what is lost is a diagnostic rather than an enforcement.
        if (controller.signal.aborted) {
          log.info('Request failed after it was cancelled — reporting the cancel', {
            requestId: request_id,
            reason: errMessage,
          });
          this.sendStreamEvent(request_id, 'done', {});

          return;
        }

        // A refusal is terminal and carries its own code. It has to be handled
        // BEFORE the resume branch below: that branch turns any failure on a
        // resumed turn into `session_lost`, which tells the server to wipe the
        // session and quietly re-issue the turn — so a refusal would be
        // retried forever, and the reason would never reach anyone.
        if (err instanceof RequestRefusal) {
          log.warn('Refusing request', {
            requestId: request_id,
            code: err.code,
            reason: errMessage,
          });
          this.sendStreamEvent(request_id, 'error', {
            code: err.code,
            message: errMessage,
          });
          this.sendStreamEvent(request_id, 'done', {});
          return;
        }

        log.error('Request execution failed', {
          requestId: request_id,
          resumeAttempt: wasResumeAttempt,
          error: errMessage,
        });

        if (wasResumeAttempt) {
          // The server asked to resume a CLI session this bridge could not
          // resume (expired, cleared, or created on another machine). Report
          // it as `session_lost` — a recoverable signal: the server wipes the
          // stored id and silently re-issues the turn as a fresh session. No
          // `done` is sent here; the re-issued turn produces its own terminal
          // events. (A genuinely unrelated failure simply resurfaces on the
          // fresh retry, so this broad treatment is safe.)
          // The session is gone, so what we remember about where it ran is
          // stale. Dropping it means the server's re-issued turn is judged on
          // its own merits rather than against a directory that no longer has
          // a session behind it.
          if (cliSessionId !== null) {
            this.sessionWorkingDirs.forget(cliSessionId);
          }
          this.sendStreamEvent(request_id, 'error', {
            code: 'session_lost',
            message: `Could not resume CLI session: ${errMessage}`,
          });
          return;
        }

        // A genuine failure on a fresh request — surface it and end the turn.
        this.sendStreamEvent(request_id, 'error', {
          code: 'provider_error',
          message: errMessage,
        });
        this.sendStreamEvent(request_id, 'done', {});
      })
      .finally(() => {
        // Only our own entry: a re-issue under the same id may own it by now.
        if (this.activeRequests.get(request_id) === controller) this.activeRequests.delete(request_id);
        this.stoppingTurns.delete(controller);
        if (this.activeRequests.get(request_id) === undefined) {
          this.lostTurns.delete(request_id);
          this.stoppedTurns.delete(request_id);
          // Confirmed by the server already: nothing left to keep for it.
          if (this.outbox.serverEnded(request_id)) this.outbox.forget(request_id);
        }
        turnInput?.end();
        // An input turn a disconnect aborted is replayed only once it has
        // ended (see handleWelcome). If the server is back already, that is now.
        const disconnected = turnInput !== null
          ? this.disconnectedTurns.find((t) => t.turnInput === turnInput)
          : undefined;
        if (disconnected !== undefined) {
          disconnected.ended = true;
          if (disconnected.due && this.sessionId !== null) this.replayDisconnectedTurn(disconnected);
        }
        // Only our own entry: a re-issue under the same id may own it by now.
        if (turnInput !== null && this.turnInputs.get(request_id) === turnInput) {
          this.turnInputs.delete(request_id);
        }
        // Last, and only if the server asked for it: everything the turn
        // produced has been sent by now, and this is the frame the server
        // treats as the end of a cancelled turn. Messages accepted into it and
        // never read are dropped with it, and named, so the server can offer
        // them again.
        if (this.cancelledRequests.delete(request_id)) {
          this.send({
            type: 'cancelled',
            request_id,
            ...(turnInput !== null ? { pending_inputs: turnInput.pending() } : {}),
          });
        }
        // A turn the server closed: no stream frames, only one `cancelled` so
        // the messages it never read are named. Fire-and-forget: unnumbered,
        // not kept, and dropped if the connection is down.
        if (this.activeRequests.get(request_id) === undefined && this.closedTurns.delete(request_id)) {
          this.outbox.forget(request_id);
          this.sendOnce({
            type: 'cancelled',
            request_id,
            ...(turnInput !== null ? { pending_inputs: turnInput.pending() } : {}),
          });
        }
        this.emit('request_end', request_id);
      });
  }

  private async executeRequest(
    adapter: ProviderAdapter,
    request: AiRequestMessage,
    cliSessionId: string | null,
    signal: AbortSignal,
    turnInput: TurnInputPort | null = null,
  ): Promise<void> {
    const { request_id } = request;
    const acceptsInput = turnInput !== null;

    // Issue a per-spawn MCP bearer token if the MCP server is running. The
    // token is mapped to this request_id so the MCP server can route
    // tools/call from the spawned CLI to the right WebSocket request frame.
    // Skipped when no tools are registered or the MCP server failed to start.
    // Wait for the handshake's MCP startup to finish before deciding whether
    // there is a channel. Without this, a server that sends `ai_request`
    // immediately after `welcome` — which is the normal thing for a server
    // with a queued turn to do — races the listener and the turn runs with no
    // tools at all, silently, because `mcp` is simply null.
    if (this.mcpStarting) {
      try {
        await this.mcpStarting;
      } catch {
        // start() already reported its own failure to the server; a turn
        // without tools is still better than no turn.
      }
    }

    // The posture THIS turn runs under: the connection's, or narrower when the
    // request asks (`ai_request.cli_isolation`). Decided before the MCP token,
    // which carries it; a refusal is thrown inside the try below so the token
    // is revoked like on every other refusal.
    const posture = turnPosture(this.cliIsolation, request, adapter);
    const turnIsolation = posture.refusal ? this.cliIsolation : posture.isolation;
    // Web search on this turn (options.web_search, decision 0016): decided on
    // the posture the turn runs under; a refusal is thrown with the others below.
    const search = resolveWebSearch(request, this.webSearch, turnIsolation, adapter);
    const serverToolsOnly = request.cli_isolation !== undefined && !posture.refusal;

    const mcpEnabled = this.mcpServer.hasTools() && this.mcpServer.isRunning();
    const mcpToken = mcpEnabled ? this.mcpServer.issueToken(request_id, { serverToolsOnly }) : null;
    const mcp = mcpEnabled && mcpToken
      ? { url: this.mcpServer.getBaseUrl(), bearerToken: mcpToken }
      : null;
    if (mcp) {
      log.info('MCP token issued for request', {
        requestId: request_id,
        provider: request.provider,
        tokenTail: mcp.bearerToken.slice(-6),
      });
    } else if (this.mcpServer.hasTools()) {
      log.warn('MCP unavailable for request (no token issued)', {
        requestId: request_id,
        provider: request.provider,
        mcpRunning: this.mcpServer.isRunning(),
      });
    }

    // Everything from here is inside the try whose `finally` revokes the
    // per-spawn MCP token and clears the attachment directory. The refusals
    // below throw, and a throw that escaped before the try was entered would
    // leave a live credential in the MCP server's token map for the life of
    // the process — one per refused turn, never collected — and any
    // part-downloaded attachments on disk.
    let turnDeadline: { at: number } | null = null;
    try {
      if (posture.refusal) throw posture.refusal;
      if (search.refusal) throw search.refusal;
      if (serverToolsOnly) {
        log.info('Turn held to the server\'s tools only', { requestId: request_id, connection: this.cliIsolation });
      }
      // Where this turn runs. A refusal here throws and the turn never spawns:
      // there is deliberately no fallback to the scratch directory, because a
      // turn that runs in the wrong place looks exactly like one that worked.
      //
      // The session's own directory is passed in so a resume can be checked
      // against it — and so a resume that names NOTHING keeps the directory it
      // has rather than being told it moved to the scratch dir.
      const workingDir = resolveWorkingDir(
        request.working_dir,
        this.allowedRootPaths,
        cliSessionId !== null ? this.sessionWorkingDirs.get(cliSessionId) : undefined,
      );

      // Attachments land on disk before the CLI starts, so the preamble below
      // can name paths that already exist. The cleanup for a failure part-way
      // through is the same `finally` that handles every other outcome, so a
      // refused turn leaves nothing behind either.
      let saved: SavedAttachment[] = [];
      const attachments = request.attachments ?? [];
      if (attachments.length > 0) {
        saved = await fetchAttachments({
          attachments,
          requestId: request_id,
          token: () => this.token,
          expectedOrigin: this.apiOrigin,
          limits: this.attachmentLimits,
          timeouts: this.attachmentTimeouts,
          cache: this.attachmentCache,
          signal,
          keep: this.keepAttachments,
        });
      }

      // Tell the model what was saved and where. Without this the files are
      // present and invisible, and the turn answers as if nothing had been
      // attached.
      const effectiveRequest: AiRequestMessage = saved.length > 0
        ? {
          ...request,
          message: buildAttachmentPreamble(saved, { cached: this.attachmentCache.enabled })
            + request.message,
        }
        : request;

      // State the bridge-owned MCP tools read, keyed by request id so
      // concurrent turns cannot read each other's.
      this.uploadContexts.set(request_id, {
        workingDir,
        attachmentDir: saved.length > 0 ? attachmentDirFor(request_id) : null,
        apiOrigin: this.apiOrigin,
        // A getter, not the current value — see UploadContext.token.
        token: () => this.token,
        maxFileBytes: this.attachmentLimits.maxFileBytes,
        signal,
      });

      // Recorded before the adapter arms its own clock, so it errs EARLY — the
      // safe direction for a deadline a tool wait must beat.
      // An object, so the turn that set it can recognise its own entry. A
      // `session_lost` re-issue reuses the SAME request id while the old turn
      // is still unwinding, and a plain delete in the old turn's `finally`
      // removed the new turn's deadline.
      if (this.serverConfig.request_timeout > 0) {
        turnDeadline = { at: Date.now() + this.serverConfig.request_timeout * 1000 };
        this.turnDeadlines.set(request_id, turnDeadline);
      }

      // Build execution context
      // Session defaults: what this turn's CLI is spawned with, and what the
      // bridge tells the model about its own lifecycle. Resolved here rather
      // than in each adapter so all three spawn with the same answer, and so
      // the addendum is generated from the environment the turn ACTUALLY gets
      // — an addendum that describes a different configuration than the one
      // running is worse than none at all.
      const bridgeEnvResolution = resolveBridgeEnv(request.bridge_env, { acceptsInput });
      const bridgePrompt = resolveBridgeAddendum(
        request.bridge_prompt,
        bridgeEnvResolution.values,
        { acceptsInput },
      );
      if (bridgeEnvResolution.rejected.length > 0) {
        log.warn('Dropping env keys the bridge does not allow', {
          requestId: request_id,
          keys: bridgeEnvResolution.rejected,
        });
      }
      if (bridgePrompt.mode === 'off' || bridgePrompt.mode === 'replace') {
        log.warn('Server dropped the bridge lifecycle addendum — it owns explaining the lifecycle', {
          requestId: request_id,
          mode: bridgePrompt.mode,
        });
      }

      // Build execution context
      const context: ExecutionContext = {
        request: effectiveRequest,
        requestId: request_id,
        tools: this.currentTools,
        mcp,
        cliIsolation: turnIsolation,
        workingDir,
        signal,
        requestTimeoutSeconds: this.serverConfig.request_timeout,
        silenceTimeoutSeconds: this.serverConfig.silence_timeout ?? DEFAULT_SILENCE_TIMEOUT_SECONDS,
        cliSessionId,
        attachmentDir: saved.length > 0 ? attachmentDirFor(request_id) : null,
        bridgeEnv: bridgeEnvResolution.values,
        bridgeAddendum: bridgePrompt.text,
        bridgeHelperAddendum: bridgePrompt.helperText,
        turnInput,
        webSearch: search.webSearch,
      };

      // The adapter emits its own `done`, but the CLI session id is only known
      // once execute() resolves. Capture the adapter's `done` data, withhold the
      // event, and re-emit `done` after — with cli_session_id attached — so the
      // server can persist the session for the next turn's resume.
      let doneData: DoneData = {};
      let sessionLost = false;
      const newCliSessionId = await adapter.execute(context, (event: AdapterStreamEvent) => {
        // After session_lost the server re-issues the turn under this id:
        // anything more of this run would be numbered as the new run's.
        if (sessionLost) return;
        if (event.event === 'done') {
          doneData = event.data as DoneData;
          return;
        }
        if (event.event === 'error') {
          const errorCode = (event.data as { code?: string }).code;
          if (errorCode === 'session_lost') {
            sessionLost = true;
          }
          // A spawn failure (most often ENOENT — the CLI is no longer on PATH)
          // means the local provider set may have changed. Re-probe so the
          // server's advertised provider list self-heals without a restart.
          if (errorCode === 'provider_spawn_error') {
            void this.refreshProviders();
          }
        }
        this.sendStreamEvent(request_id, event.event, event.data);
      });

      // On session_lost the error was already forwarded and the server recovers
      // by re-issuing the turn — withhold `done` so its in-flight request stays
      // open for the re-issue.
      if (sessionLost) {
        return;
      }

      // Remember where this session runs, so a later turn that names somewhere
      // else is refused rather than resumed into the wrong checkout.
      if (newCliSessionId) {
        this.sessionWorkingDirs.remember(newCliSessionId, workingDir);
      }

      // A turn that ended with accepted messages the assistant never read (a
      // timeout, a crash) names them, so the server does not wait for a
      // `user_input` that is not coming. A turn that ends normally has none.
      const unread = turnInput?.pending() ?? [];
      this.sendStreamEvent(request_id, 'done', {
        ...doneData,
        cli_session_id: newCliSessionId,
        ...(unread.length > 0 ? { pending_inputs: unread } : {}),
      });
    } finally {
      if (turnDeadline !== null && this.turnDeadlines.get(request_id) === turnDeadline) {
        this.turnDeadlines.delete(request_id);
      }
      // Revoke the per-spawn MCP token so a leftover CLI process cannot
      // continue invoking tools on this request_id's behalf.
      if (mcpToken) {
        this.mcpServer.revokeToken(mcpToken);
      }
      // Drop the bridge-owned tools' view of this turn, so a CLI that outlives
      // it cannot keep uploading files against a request nobody is reading.
      this.uploadContexts.delete(request_id);
      // Attachments go on every terminal outcome — done, error and cancelled
      // alike. Cleaning up only on success would grow the cache without bound
      // precisely on the machines where things go wrong most.
      if ((request.attachments?.length ?? 0) > 0 && !this.keepAttachments) {
        try {
          removeAttachmentDir(request_id);
        } catch (err) {
          log.warn('Could not remove attachment directory', {
            requestId: request_id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // After the turn, so what it just added counts against the cap at once
      // rather than at the next restart. Only turns that brought files can
      // have grown the store; the hourly timer handles expiry for the rest.
      if ((request.attachments?.length ?? 0) > 0) {
        this.attachmentCache.sweep();
      }
    }
  }

  private handleServerError(message: { type: 'error'; code: string; message: string; fatal: boolean }): void {
    log.error('Server error', { code: message.code, message: message.message, fatal: message.fatal });
    if (message.fatal) {
      log.error('Fatal server error — disconnecting');
      this.isShuttingDown = true;
      // Stop the bridge MCP server (best-effort) before closing.
      this.mcpServer.stop().catch(() => {
        // Best-effort cleanup; ignore errors during shutdown
      });
      this.ws?.close(1000, 'Fatal server error');
    }
  }

  /**
   * Handle a connection_error message — the server rejected this connection
   * (bad / expired / revoked token, protocol mismatch, …). Always fatal: the
   * bridge stops instead of reconnecting. Setting isShuttingDown also
   * suppresses the duplicate fatal error the accompanying 4001 close frame
   * would otherwise raise in onClose().
   */
  private handleConnectionError(message: ConnectionErrorMessage): void {
    log.error('Connection rejected by server', {
      error: message.error,
      message: message.message,
    });
    this.isShuttingDown = true;
    // Best-effort cleanup before surfacing the fatal error.
    this.mcpServer.stop().catch(() => {
      // Best-effort cleanup; ignore errors during shutdown
    });
    this.emit('error', new FatalBridgeError(`Connection rejected: ${message.message}`));
  }

  /**
   * Adopt a server-issued replacement token. Bridge tokens are long-lived but
   * still expire; the server hands over a fresh one before the current token
   * ages out, so subsequent reconnects keep working without operator action.
   */
  private adoptRefreshedToken(token: string, source: string): void {
    if (!token || token === this.token) {
      return;
    }
    const previous = this.token;
    this.token = token;
    log.info('Adopted refreshed connection token', { source });
    try {
      this.onTokenRefreshed?.(token, previous);
    } catch (err) {
      log.warn('Could not hand on the refreshed connection token', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // -------------------------------------------------------------------------
  // Heartbeat
  // -------------------------------------------------------------------------

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.isConnected()) {
        this.send({ type: 'ping', timestamp: Date.now() });
        log.debug('Ping sent');

        // Set a 10-second timeout for the pong response; if none arrives,
        // treat the connection as dead.
        this.awaitingPong = true;
        if (this.pongTimeoutTimer) {
          clearTimeout(this.pongTimeoutTimer);
        }
        this.pongTimeoutTimer = setTimeout(() => {
          if (this.awaitingPong && this.isConnected()) {
            log.warn('Pong not received within 10s — connection presumed dead');
            this.ws?.close(4000, 'Pong timeout');
          }
        }, 10_000);
      }
    }, intervalMs);
    log.debug('Heartbeat started', { intervalMs });
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.pongTimeoutTimer) {
      clearTimeout(this.pongTimeoutTimer);
      this.pongTimeoutTimer = null;
    }
    this.awaitingPong = false;
  }

  // -------------------------------------------------------------------------
  // Reconnection with Exponential Backoff
  // -------------------------------------------------------------------------

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      log.error('Maximum reconnection attempts reached — giving up', {
        attempts: this.reconnectAttempts,
        max: MAX_RECONNECT_ATTEMPTS,
      });
      this.emit(
        'error',
        new FatalBridgeError(
          'Maximum reconnection attempts reached. Check that the server URL is correct and the server is reachable, then restart the bridge.',
        ),
      );
      return;
    }

    // Per PROTOCOL.md: 1s, 2s, 4s, 8s, 15s cap
    const delay = Math.min(
      BASE_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts),
      MAX_RECONNECT_DELAY_MS,
    );

    this.reconnectAttempts++;
    log.info(`Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Message Sending
  // -------------------------------------------------------------------------

  /**
   * Put one frame on the wire, or something smaller that says why not.
   *
   * The single serialisation point, and so the single place a frame's size can
   * be checked once for every field it carries — including fields added later.
   */
  /**
   * MCP Apps: a view's request, relayed by the host. Always answered, once,
   * with `mcp_result` carrying the same id: a result, or an error with a code.
   */
  private handleMcpRequest(message: import('./protocol/types.js').McpRequestMessage): void {
    const id = typeof message.id === 'string' ? message.id : '';
    if (!id) {
      log.warn('mcp_request without an id; ignored');
      return;
    }
    const hub = this.upstream;
    const work = hub
      ? hub.request(String(message.server ?? ''), String(message.method ?? ''), (message.params ?? {}) as Record<string, unknown>)
      : Promise.reject(new UpstreamError('unknown_server', `no upstream MCP servers on this bridge (server ${String(message.server)})`));
    void work.then(
      (result) => this.send({ type: 'mcp_result', id, result }),
      (err: unknown) => {
        const code = err instanceof UpstreamError ? err.code : 'upstream_error';
        const text = err instanceof Error ? err.message : String(err);
        log.info('mcp_request failed', { id, server: message.server, method: message.method, code, error: text });
        this.send({ type: 'mcp_result', id, error: text, code });
      },
    );
  }

  private sendUpstreamStatus(): void {
    if (this.upstream) this.send({ type: 'upstream_status', upstreams: this.upstream.upstreamStatus() });
  }

  /** upstream_auth_start / _code / _forget. A bridge without upstreams answers as for an unknown server. */
  private handleUpstreamAuth(
    message: import('./protocol/types.js').UpstreamAuthStartMessage
      | import('./protocol/types.js').UpstreamAuthCodeMessage
      | import('./protocol/types.js').UpstreamAuthForgetMessage,
  ): void {
    const server = typeof message.server === 'string' ? message.server : '';
    const hub = this.upstream;
    const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
    if (message.type === 'upstream_auth_forget') {
      if (hub) void hub.authForget(server);
      else log.info('upstream_auth_forget on a bridge with no upstreams; ignored', { server });
      return;
    }
    if (!hub) {
      this.send({
        type: 'upstream_auth_result', server,
        state: message.type === 'upstream_auth_code' ? str(message.state) ?? null : null,
        ok: false, code: 'unknown_server', error: `no upstream MCP servers on this bridge (server ${server})`,
      });
      return;
    }
    if (message.type === 'upstream_auth_start') {
      void hub.authStart(server);
      return;
    }
    const params = {
      ...(str(message.code) !== undefined ? { code: str(message.code)! } : {}),
      ...(str(message.error) !== undefined ? { error: str(message.error)! } : {}),
      ...(str(message.error_description) !== undefined ? { error_description: str(message.error_description)! } : {}),
      ...(str(message.iss) !== undefined ? { iss: str(message.iss)! } : {}),
    };
    void hub.authCode(server, message.state, params);
  }

  private send(message: BridgeToServerMessage): void {
    // MCP Apps: the first tool_result of a call whose upstream
    // tool names a view carries what the host needs to draw it.
    if (this.upstream && message.type === 'stream' && (message as { event?: string }).event === 'tool_result') {
      const data = (message as unknown as { data: Record<string, unknown> }).data;
      const ui = typeof data?.['tool_call_id'] === 'string' ? this.upstream.takeUi(data['tool_call_id'] as string) : undefined;
      if (ui) message = { ...message, data: { ...data, ui } } as BridgeToServerMessage;
    }

    const turnId = (message as { request_id?: unknown }).request_id;
    // The server said this turn is over (`stream_ack` `closed`): nothing more of it.
    if (typeof turnId === 'string' && this.closedTurns.has(turnId)) {
      log.debug('Not sending for a turn the server closed', { type: message.type, requestId: turnId });

      return;
    }

    // A turn the bridge stopped is reported as `bridge_disconnected`. What it
    // still emits as it unwinds (an unnumbered `done`, say) is dropped, also on
    // a live connection: written ahead of or beside the report, it would make a
    // cut-off answer look complete. Any other lost turn's frames still wait for
    // the welcome.
    if (message.type === 'stream' && (this.stoppedTurns.has(message.request_id)
      || (this.lostTurns.has(message.request_id) && !this.canWriteStream()))) {
      log.debug('Dropping a frame of a turn the bridge stopped or lost', { requestId: message.request_id });

      return;
    }

    // A turn's frames against a server with reliable delivery: numbered, kept
    // until confirmed, and never dropped for want of a connection.
    if (message.type === 'stream' && this.numbersFramesOf(message.request_id)) {
      this.sendNumbered(message);

      return;
    }

    // Its other messages (`cancelled`, `turn_input_ack`, an `error`...) are
    // not numbered, but in the grace period they wait for the reconnect too,
    // rather than go to a dead connection. The server ignores a duplicate.
    if (message.type !== 'stream' && typeof turnId === 'string' && this.graceTimer !== null && !this.canWriteStream()) {
      this.heldMessages.push(message);
      if (this.heldMessages.length > MAX_HELD_MESSAGES) {
        const dropped = this.heldMessages.shift()!;
        log.warn('Too many messages kept through the drop; dropping the oldest', { type: dropped.type });
      }
      log.debug('Connection down — message kept for the reconnect', { type: message.type, requestId: turnId });

      return;
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      log.warn('Cannot send message — WebSocket not open', { type: message.type });
      return;
    }

    const encoded = this.encode(message);
    if (encoded === null) return;

    this.ws.send(encoded.payload);
    log.debug('Message sent', { type: message.type, bytes: Buffer.byteLength(encoded.payload, 'utf8') });
  }

  /** Write a message now if connected and welcomed, else drop it: never numbered or kept. */
  private sendOnce(message: BridgeToServerMessage): void {
    if (!this.canWriteStream()) {
      log.warn('Not connected — message dropped', { type: message.type });

      return;
    }
    const encoded = this.encode(message);
    if (encoded !== null) this.ws!.send(encoded.payload);
  }

  /**
   * One stream frame of a turn under reliable delivery (PROTOCOL.md, "Short
   * drops"). It gets the turn's next `seq` and stays in the outbox until a
   * `stream_ack` covers it; while the connection is down (or not yet
   * welcomed) it only waits there, and the next welcome writes it.
   *
   * The number is taken only once the frame has been encoded: a frame that
   * cannot be sent at all must not leave a gap, because the server stores
   * nothing after one.
   */
  private sendNumbered(message: StreamMessage): void {
    const requestId = message.request_id;
    const seq = this.outbox.peek(requestId);
    const encoded = this.encode({ ...message, seq });
    if (encoded === null) return;

    this.outbox.allocate(requestId);
    const result = this.outbox.keep(requestId, {
      seq,
      payload: encoded.payload,
      terminal: encoded.event === 'done' || encoded.event === 'error',
    });
    if (result === 'full' || result === 'shared_full') {
      // Bounded, so a long grace period with a chatty turn cannot exhaust
      // memory: the turn is stopped and reported as lost, saying whether the
      // connection was down or the server just did not confirm in time, or
      // that other turns had filled the outbox (this answer is not the cause).
      const connected = this.canWriteStream();
      const shared = result === 'shared_full';
      log.error(shared
        ? 'Too much unconfirmed output kept for all turns together; stopping this one'
        : 'Too much unconfirmed output kept for this turn; stopping it', { requestId, seq, connected });
      this.giveUpTurn(requestId, shared ? 'outbox_shared_full' : connected ? 'outbox_unconfirmed' : 'outbox_full');

      return;
    }
    const kept = result === 'kept';

    if (!this.canWriteStream()) {
      if (kept) {
        log.debug('Connection down — frame kept for the reconnect', { requestId, seq, event: encoded.event });
      } else {
        log.warn('Cannot send message — WebSocket not open', { type: message.type });
      }

      return;
    }

    this.ws!.send(encoded.payload);
    if (kept) {
      this.armReattachCheck(requestId);
      this.armLiveAckCheck(requestId);
    }
    log.debug('Message sent', { type: message.type, seq });
  }

  /**
   * A frame as it goes on the wire, or something smaller that says why not;
   * null when nothing that carries its request id fits.
   *
   * The single serialisation point, and so the single place a frame's size can
   * be checked once for every field it carries — including fields added later.
   */
  private encode(message: BridgeToServerMessage): { payload: string; event: string | undefined } | null {
    // `JSON.stringify` throws on a circular structure or a BigInt. Nothing
    // reaching here should hold either — every field is parsed from CLI output
    // or built locally — but this runs inside a readline listener, where an
    // exception is not caught by anything and takes the process with it. A
    // frame that cannot be encoded is treated exactly like one that is too
    // large: reduced to something that can be.
    let payload: string | null = null;
    try {
      payload = JSON.stringify(message);
    } catch (err) {
      log.error('Could not encode a frame', {
        type: message.type,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const bytes = payload === null ? -1 : Buffer.byteLength(payload, 'utf8');

    // Four review rounds of this change found four separate "field X was not
    // bounded" bugs — each a different producer, each missed the same way. The
    // per-field bounds stay, because a marked truncation is a better answer
    // than this; but a new field or a new provider cannot now silently exceed
    // the cap, and the failure is a message the server can read rather than a
    // CLOSE_TOO_BIG that tears the connection down with every in-flight request
    // on it.
    if (payload !== null && bytes <= MAX_FRAME_BYTES) {
      return { payload, event: (message as { event?: string }).event };
    }

    if (payload !== null) log.error('Refusing to send an oversized frame', { type: message.type, bytes });

    // A TERMINAL frame is never dropped. `done` is how the server learns the
    // turn ended; withholding it hangs the request until a timeout, which is
    // a worse outcome than the oversized frame this guard exists to prevent
    // — and reachable, because `permission_denials` carries each refused
    // call's whole input, so one denied large write is enough.
    //
    // Every fallback below goes through `fit`, which measures. A guard
    // that replaces one oversized frame with another it never measured is
    // not a guard: `stripToEssentials` keeps `usage` and `cli_session_id`,
    // both provider-supplied and neither bounded anywhere, so the stripped
    // frame CAN still be over the cap — and then closes the connection
    // exactly as if the guard were not here.
    for (const fallback of this.fallbacksFor(message, bytes)) {
      const fitted = this.fit(fallback);
      if (fitted !== null) {
        log.warn('Sent a reduced frame in place of an oversized one', { type: message.type, bytes });

        return { payload: fitted, event: fallback['event'] as string | undefined };
      }
    }

    // Nothing that carries the request id fits, which means the id itself is
    // the size problem. There is no frame left to send — every one would be
    // uncorrelatable or oversized — so the connection survives and the
    // request times out, which is the least bad of three bad outcomes.
    log.error('Could not reduce a frame to a sendable size', { type: message.type, bytes });

    return null;
  }

  /**
   * A frame encoded, only if it fits; null otherwise.
   *
   * The single measuring point for everything the oversize path produces, so a
   * new fallback cannot be added without being measured.
   */
  private fit(frame: Record<string, unknown>): string | null {
    let payload: string;
    try {
      payload = JSON.stringify(frame);
    } catch {
      return null;
    }

    return Buffer.byteLength(payload, 'utf8') > MAX_FRAME_BYTES ? null : payload;
  }

  /**
   * Ever-smaller stand-ins for a frame that will not fit, most informative
   * first. The last one carries nothing but the request id and a reason, so it
   * fits unless the id alone does not.
   */
  private *fallbacksFor(message: BridgeToServerMessage, bytes: number): Generator<Record<string, unknown>> {
    // A numbered frame's stand-in keeps its number: it takes the frame's place.
    const seq = (message as { seq?: number }).seq;
    for (const frame of this.plainFallbacksFor(message, bytes)) {
      yield seq !== undefined && frame['type'] === 'stream' ? { ...frame, seq } : frame;
    }
  }

  private *plainFallbacksFor(message: BridgeToServerMessage, bytes: number): Generator<Record<string, unknown>> {
    const stripped = this.stripToEssentials(message);
    if (stripped !== null) {
      yield stripped;

      // `usage` and `cli_session_id` are what the server acts on, so they are
      // worth one attempt — but they come from the provider, and a terminal
      // frame that cannot be sent at all costs more than either.
      //
      // `done` only: an `error` frame has neither field, and writing them in
      // would put two meaningless nulls into a frame whose shape the server
      // reads.
      if (stripped['event'] === 'done') {
        const data = (stripped['data'] ?? {}) as Record<string, unknown>;
        yield {
          ...stripped,
          data: { ...data, usage: null, cli_session_id: null },
        };
      }
    }

    const requestId = (message as { request_id?: string }).request_id;
    if (requestId === undefined) return;

    const event = (message as { event?: string }).event ?? message.type;
    yield {
      type: 'stream',
      request_id: requestId,
      event: 'error',
      data: {
        code: 'frame_too_large',
        message: bytes < 0
          ? `The bridge dropped a ${event} frame it could not encode.`
          : `The bridge dropped a ${event} frame of ${bytes} bytes, over the ${MAX_FRAME_BYTES}-byte limit.`,
      },
    };
  }

  /**
   * Reduce a terminal frame to the part the server cannot do without.
   *
   * Returns null for anything that is not terminal — those are safe to drop and
   * report, because a missing block event costs content while a missing `done`
   * costs the whole request.
   */
  private stripToEssentials(message: BridgeToServerMessage): Record<string, unknown> | null {
    const framed = message as unknown as Record<string, unknown>;
    if (framed['type'] !== 'stream') return null;

    const data = (framed['data'] ?? {}) as Record<string, unknown>;

    if (framed['event'] === 'done') {
      return {
        type: 'stream',
        request_id: framed['request_id'],
        event: 'done',
        // Usage and the session id are small and the server acts on both.
        // Everything else the provider reported is informational.
        data: {
          usage: data['usage'] ?? null,
          cli_session_id: data['cli_session_id'] ?? null,
          truncated_by_bridge: true,
        },
      };
    }

    if (framed['event'] === 'error') {
      return {
        type: 'stream',
        request_id: framed['request_id'],
        event: 'error',
        data: {
          // Both scrubbed and bounded. `slice` cuts at a UTF-16 code unit and
          // can leave half a surrogate pair, which `JSON.stringify` escapes to
          // a literal `\ud83d` — valid UTF-8, valid-looking, and rejected
          // OUTRIGHT by PHP's `json_decode`. That would destroy the terminal
          // frame this whole path exists to guarantee, and the request would
          // hang to timeout anyway. `fit` measures size; nothing measured
          // well-formedness.
          // Slice FIRST, then scrub. Scrubbing first and slicing after cuts a
          // pair the scrub had just approved, putting a lone surrogate back —
          // which was the order used for `code` and not for `message`, so one
          // of the two was wrong.
          code: replaceLoneSurrogates(String(data['code'] ?? 'provider_error').slice(0, 200)),
          message: replaceLoneSurrogates(String(data['message'] ?? '').slice(0, 2000)),
        },
      };
    }

    return null;
  }

  /**
   * Send a stream event using the correct envelope format per PROTOCOL.md:
   * { type: "stream", request_id, event: "<event_type>", data: {...} }
   */
  private sendStreamEvent(requestId: string, event: StreamEventType, data: StreamEventData): void {
    this.send({
      type: 'stream',
      request_id: requestId,
      event,
      data,
    });
  }
}

/** welcome.upstream_oauth.redirect_uri when it is an absolute http(s) URL; null otherwise. */
function upstreamRedirectUri(message: WelcomeMessage): string | null {
  const raw = (message.upstream_oauth as { redirect_uri?: unknown } | undefined)?.redirect_uri;
  if (typeof raw !== 'string') return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    // As sent: it is registered and compared character for character.
    return raw;
  } catch {
    return null;
  }
}

/**
 * Whether this turn gets Claude Code's built-in WebSearch tool (decision 0016).
 *
 * Only `options.web_search === true` asks: a stray truthy value ("1", "yes")
 * must not be what widens a turn, and `false`, `null` or absent mean today's
 * behaviour exactly. It matters only on an `isolated` turn: `workspace` and
 * `native` already allow every built-in tool, so there it changes nothing.
 * An isolated turn that asks is refused rather than run without search when
 * the operator did not pass `--allow-web-search` (`web_search_not_allowed`;
 * hello then has no `web_search`, so a server that checks never sends it) or
 * on a provider that cannot be given exactly that one tool
 * (`web_search_unsupported`; only Claude can). A turn that quietly ran without
 * the tool its server asked for would look exactly like one that searched.
 */
export function resolveWebSearch(
  request: Pick<AiRequestMessage, 'options'>,
  operatorAllows: boolean,
  isolation: CliIsolation,
  adapter: Pick<ProviderAdapter, 'enforcesServerToolsOnly' | 'providerName'>,
): { webSearch: boolean; refusal: RequestRefusal | null } {
  if (request.options?.web_search !== true || isolation !== 'isolated') return { webSearch: false, refusal: null };
  if (!operatorAllows) {
    return { webSearch: false, refusal: new RequestRefusal('web_search_not_allowed',
      'This turn asked for web search, and this machine\'s bridge was not started with --allow-web-search. It was not run.') };
  }
  if (!adapter.enforcesServerToolsOnly) {
    return { webSearch: false, refusal: new RequestRefusal('web_search_unsupported',
      `This turn asked for web search alone among the built-in tools, and the ${adapter.providerName} CLI cannot be given exactly that. It was not run.`) };
  }
  return { webSearch: true, refusal: null };
}

/**
 * The isolation posture one turn runs under.
 *
 * The connection's posture, unless the request narrows it with
 * `cli_isolation: "isolated"` (PROTOCOL.md, "Per-turn isolation"): then the
 * turn is launched exactly as an `isolated` one, holding it to the server's
 * own tools. A request can only narrow. Anything it cannot have is refused
 * with a reason, never quietly run with the connection's wider posture:
 *
 * - a value other than `isolated` (`isolation_not_narrowing`);
 * - a provider whose `isolated` launch does not deny every built-in tool
 *   (`isolation_unsupported`; Codex's read-only sandbox still has a shell,
 *   Gemini has no lever at all);
 * - a `working_dir` beside it (`isolation_conflict`): a folder is for file
 *   tools the turn does not have, and a session made in a checkout would be
 *   refused on its next resume anyway.
 */
export function turnPosture(
  connection: CliIsolation,
  request: Pick<AiRequestMessage, 'cli_isolation' | 'working_dir' | 'provider'>,
  adapter: Pick<ProviderAdapter, 'enforcesServerToolsOnly' | 'providerName'>,
): { isolation: CliIsolation; refusal: RequestRefusal | null } {
  const asked = (request as { cli_isolation?: unknown }).cli_isolation;
  if (asked === undefined || asked === null) return { isolation: connection, refusal: null };
  if (asked !== 'isolated') {
    return { isolation: connection, refusal: new RequestRefusal('isolation_not_narrowing',
      `This turn asked for \`${String(asked)}\` isolation, and a request may only narrow the connection's posture to \`isolated\`. It was not run.`) };
  }
  if (!adapter.enforcesServerToolsOnly) {
    return { isolation: connection, refusal: new RequestRefusal('isolation_unsupported',
      `This turn must use the server's tools only, and the ${adapter.providerName} CLI cannot be held to that on this machine. It was not run.`) };
  }
  if (request.working_dir) {
    return { isolation: connection, refusal: new RequestRefusal('isolation_conflict',
      'This turn must use the server\'s tools only, which have no use for a working folder, and it named one. It was not run.') };
  }
  return { isolation: 'isolated', refusal: null };
}
