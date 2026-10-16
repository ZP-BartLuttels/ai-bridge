/**
 * MCP Apps (ext-apps, spec 2026-01-26): MCP servers the bridge connects to
 * itself and offers to the CLI beside the server's tools, so the bridge sees
 * each tool DEFINITION, including `_meta.ui.resourceUri`, and can serve the
 * host (the web application) what a view needs:
 *
 *   - which call carries a view: the `ui` field on that call's tool_result
 *     stream event ({server, resource_uri, tool_name, arguments, result});
 *   - the view's document: `mcp_request` {method: "resources/read"}, a `ui://`
 *     uri only. The content item's `_meta.ui` (csp, permissions, domain,
 *     prefersBorder) goes to the host unchanged; when the item carries none,
 *     the `_meta.ui` of the server's resources/list entry for that uri is put
 *     there instead, which is the fallback the spec gives hosts;
 *   - the view's own calls back to its server: `mcp_request` {method:
 *     "tools/call"}, refused for a tool whose `_meta.ui.visibility` leaves out
 *     "app".
 *
 * A tool whose visibility leaves out "model" is never offered to the CLI.
 *
 * Generic: nothing here knows any particular server. Configured by the person
 * running the bridge (`--mcp-upstreams <file>`, see parseUpstreamConfig and
 * docs/mcp-upstreams.md); a web application cannot add one.
 *
 * What the CLI gets back from a call is the text content only. A result's
 * structuredContent and _meta go to the host, not into the model's context
 * (Claude Code hands the model the JSON instead of the text when
 * structuredContent is present, and inlines an embedded HTML resource).
 *
 * Secrets: a header or environment value may name where its value comes from
 * (`{"env": NAME}` or `{"vault": {space_id, secret_id}}`) instead of holding
 * it. A credential-looking name with a literal value is refused at load. Every
 * resolved value is redacted from whatever goes back out: model text, host
 * results, errors and the server's stderr in the log.
 */
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition } from '../protocol/types.js';
import { scrub, type Redaction } from '../local/scrub.js';
import {
  NeedsAuthError, OAuthFlowError, OAuthStore, UpstreamOAuth,
  type AuthRequiredReason, type AuthResultCode, type OAuthOptions, type RedirectParams,
} from './oauth.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('mcp-upstream');

/** Between server and tool in the name the CLI sees: `<server>__<tool>`. */
export const UPSTREAM_SEPARATOR = '__';

/** The ext-apps specification revision this bridge implements. */
export const MCP_APPS_SPEC = '2026-01-26';
/**
 * The revision of the bridge's OWN MCP Apps frames (hello.mcp_apps,
 * tool_result.ui, mcp_request/mcp_result, welcome tool `_meta`,
 * tool_call.provider_tool_call_id). Bumped when one of them changes shape.
 */
export const MCP_APPS_BRIDGE_REVISION = 1;

export const DEFAULT_CALL_TIMEOUT_MS = 60_000;
export const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
/** Reconnect backoff: first wait, doubled each failure, capped. */
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 60_000;
/** How long a call's view waits for its tool_result before it is dropped. */
const PENDING_UI_TTL_MS = 10 * 60_000;

/** Where a value comes from, instead of the value itself. */
export type SecretRef =
  | { env: string; prefix?: string }
  | { vault: { space_id: string; secret_id: string }; prefix?: string };

/** A header or environment value: a literal (not a secret), or a reference. */
export type ConfigValue = string | SecretRef;

interface UpstreamCommon {
  /** Per request (tools/call, resources/read), in ms. Default 60000. */
  timeout_ms?: number;
  /** Connect and initialize, in ms. Default 30000. */
  connect_timeout_ms?: number;
}

export type UpstreamConfig =
  | ({ command: string; args?: string[]; env?: Record<string, ConfigValue>; cwd?: string } & UpstreamCommon)
  | ({ url: string; headers?: Record<string, ConfigValue>; auth?: 'oauth'; oauth?: OAuthOptions } & UpstreamCommon);

/** Resolves a reference to its value. Throws when it cannot. */
export type SecretResolver = (ref: SecretRef) => Promise<string>;

interface UpstreamTool {
  server: string;
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

/** What the host needs to draw a call's view, kept until its tool_result goes out. */
export interface CallUi {
  server: string;
  tool_name: string;
  resource_uri: string;
  arguments: Record<string, unknown>;
  result: unknown;
}

/** Why an mcp_request failed, for the host to act on without parsing words. */
export type UpstreamErrorCode =
  | 'unknown_server' // no upstream of that name on this bridge
  | 'unavailable' // configured, but not connected and a reconnect failed
  | 'timeout' // the server did not answer in time
  | 'refused' // the bridge will not do this (visibility, non-ui:// uri, unknown tool)
  | 'unsupported' // a method the bridge does not relay
  | 'upstream_error'; // the server answered with an error, or the connection broke mid-request

export class UpstreamError extends Error {
  constructor(readonly code: UpstreamErrorCode, message: string) {
    super(message);
    this.name = 'UpstreamError';
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const NAME = /^[a-z0-9_-]{1,32}$/i;
/** Header names whose value is a credential. Lower case. */
const SECRET_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'x-api-key', 'api-key']);
/** Environment names that look like a credential. */
const SECRET_ENV = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL)/i;

function isSecretName(kind: 'header' | 'env', name: string): boolean {
  return kind === 'header' ? SECRET_HEADERS.has(name.toLowerCase()) || /token|secret|api[-_]?key/i.test(name) : SECRET_ENV.test(name);
}

function checkValue(where: string, kind: 'header' | 'env', key: string, value: unknown): ConfigValue {
  if (typeof value === 'string') {
    if (isSecretName(kind, key)) {
      throw new Error(
        `${where}: ${kind} "${key}" looks like a credential and holds a literal value. ` +
        `Name where it comes from instead: {"env": "VAR"} or {"vault": {"space_id": "...", "secret_id": "..."}} ` +
        `(add "prefix": "Bearer " for a header that needs one).`,
      );
    }
    return value;
  }
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (v['prefix'] !== undefined && typeof v['prefix'] !== 'string') throw new Error(`${where}: ${kind} "${key}": prefix must be a string`);
    const prefix = v['prefix'] as string | undefined;
    if (typeof v['env'] === 'string' && v['env'].length > 0) return { env: v['env'], ...(prefix !== undefined ? { prefix } : {}) };
    const vault = v['vault'] as Record<string, unknown> | undefined;
    if (vault && typeof vault['space_id'] === 'string' && typeof vault['secret_id'] === 'string') {
      return { vault: { space_id: vault['space_id'], secret_id: vault['secret_id'] }, ...(prefix !== undefined ? { prefix } : {}) };
    }
  }
  throw new Error(`${where}: ${kind} "${key}" must be a string, {"env": "VAR"} or {"vault": {"space_id", "secret_id"}}`);
}

function checkTimeout(where: string, key: string, v: unknown): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 100 || v > 3_600_000) {
    throw new Error(`${where}: ${key} must be a number of milliseconds between 100 and 3600000`);
  }
  return v;
}

function checkOAuth(where: string, v: unknown): OAuthOptions {
  if (v === undefined) return {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${where}: oauth must be an object`);
  const o = v as Record<string, unknown>;
  const out: OAuthOptions = {};
  for (const [k, val] of Object.entries(o)) {
    if (k !== 'scope' && k !== 'client_name') throw new Error(`${where}: oauth takes only "scope" and "client_name", not "${k}"`);
    if (typeof val !== 'string' || val.trim() === '') throw new Error(`${where}: oauth.${k} must be a non-empty string`);
    out[k] = val;
  }
  return out;
}

/**
 * Validate an upstreams document. Accepts `{"mcpServers": {...}}` (the shape
 * Claude Code and Claude Desktop use) or the bare map. Throws, naming the
 * server and the field, on anything it would otherwise have to guess about.
 */
export function parseUpstreamConfig(doc: unknown): Record<string, UpstreamConfig> {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('MCP upstreams: expected a JSON object');
  const d = doc as Record<string, unknown>;
  const map = (d['mcpServers'] ?? d) as Record<string, unknown>;
  if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error('MCP upstreams: "mcpServers" must be an object');
  const out: Record<string, UpstreamConfig> = {};
  for (const [name, raw] of Object.entries(map)) {
    const where = `MCP upstream "${name}"`;
    if (!NAME.test(name) || name.includes(UPSTREAM_SEPARATOR)) {
      throw new Error(`${where}: a name is 1-32 letters, digits, "-" or "_", without "${UPSTREAM_SEPARATOR}"`);
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${where}: expected an object`);
    const c = raw as Record<string, unknown>;
    const common: UpstreamCommon = {};
    const t = checkTimeout(where, 'timeout_ms', c['timeout_ms']);
    if (t !== undefined) common.timeout_ms = t;
    const ct = checkTimeout(where, 'connect_timeout_ms', c['connect_timeout_ms']);
    if (ct !== undefined) common.connect_timeout_ms = ct;

    if (c['auth'] !== undefined && c['auth'] !== 'oauth') throw new Error(`${where}: auth must be "oauth" or absent`);
    if (c['oauth'] !== undefined && c['auth'] !== 'oauth') throw new Error(`${where}: "oauth" needs "auth": "oauth"`);
    if (typeof c['command'] === 'string' && c['command'].length > 0) {
      if (c['url'] !== undefined) throw new Error(`${where}: give "command" or "url", not both`);
      if (c['auth'] !== undefined) throw new Error(`${where}: "auth": "oauth" needs "url" (an HTTP server), not "command"`);
      if (c['args'] !== undefined && (!Array.isArray(c['args']) || !c['args'].every((a) => typeof a === 'string'))) {
        throw new Error(`${where}: args must be an array of strings`);
      }
      if (c['cwd'] !== undefined && typeof c['cwd'] !== 'string') throw new Error(`${where}: cwd must be a string`);
      const env: Record<string, ConfigValue> = {};
      for (const [k, v] of Object.entries((c['env'] ?? {}) as Record<string, unknown>)) env[k] = checkValue(where, 'env', k, v);
      out[name] = {
        command: c['command'],
        ...(c['args'] ? { args: c['args'] as string[] } : {}),
        ...(Object.keys(env).length ? { env } : {}),
        ...(c['cwd'] ? { cwd: c['cwd'] as string } : {}),
        ...common,
      };
    } else if (typeof c['url'] === 'string') {
      let url: URL;
      try { url = new URL(c['url']); } catch { throw new Error(`${where}: url is not a URL`); }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${where}: url must be http(s)`);
      if (url.username || url.password) throw new Error(`${where}: no credentials in the url; use headers with {"env"} or {"vault"}`);
      const headers: Record<string, ConfigValue> = {};
      for (const [k, v] of Object.entries((c['headers'] ?? {}) as Record<string, unknown>)) headers[k] = checkValue(where, 'header', k, v);
      let oauth: OAuthOptions | undefined;
      if (c['auth'] === 'oauth') {
        if (Object.keys(headers).some((h) => h.toLowerCase() === 'authorization')) {
          throw new Error(`${where}: "auth": "oauth" and an Authorization header cannot both be given`);
        }
        oauth = checkOAuth(where, c['oauth']);
      }
      out[name] = {
        url: c['url'],
        ...(Object.keys(headers).length ? { headers } : {}),
        ...(oauth ? { auth: 'oauth' as const, ...(Object.keys(oauth).length ? { oauth } : {}) } : {}),
        ...common,
      };
    } else {
      throw new Error(`${where}: needs "command" (stdio) or "url" (Streamable HTTP)`);
    }
  }
  // OAuth tokens are kept per url: two upstreams on one url would rotate each other's refresh token away.
  const seen = new Map<string, string>();
  for (const [name, cfg] of Object.entries(out)) {
    if (!('url' in cfg) || cfg.auth !== 'oauth') continue;
    const key = new URL(cfg.url).href;
    const other = seen.get(key);
    if (other) throw new Error(`MCP upstream "${name}": same url as "${other}"; one OAuth upstream per url`);
    seen.set(key, name);
  }
  return out;
}

export function readUpstreamConfig(path: string): Record<string, UpstreamConfig> {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch (err) {
    throw new Error(`MCP upstreams: cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let doc: unknown;
  try { doc = JSON.parse(text); } catch (err) {
    throw new Error(`MCP upstreams: ${path} is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseUpstreamConfig(doc);
}

/** The default resolver for `{"env"}`: the bridge's own environment. `{"vault"}` needs the bridge's. */
export const envResolver: SecretResolver = async (ref) => {
  if ('env' in ref) {
    const v = process.env[ref.env];
    if (v === undefined || v === '') throw new Error(`environment variable ${ref.env} is not set`);
    return (ref.prefix ?? '') + v;
  }
  throw new Error('a vault reference needs the bridge enrolled with Engram (--engram)');
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resourceUriOf(meta: unknown): string | null {
  const m = meta as { ui?: { resourceUri?: unknown }; 'ui/resourceUri'?: unknown } | undefined;
  const uri = m?.ui?.resourceUri ?? m?.['ui/resourceUri'];
  return typeof uri === 'string' && uri.startsWith('ui://') ? uri : null;
}

/** Spec default when absent: ["model", "app"]. */
export function visibility(meta: unknown): string[] {
  const v = (meta as { ui?: { visibility?: unknown } } | undefined)?.ui?.visibility;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : ['model', 'app'];
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new UpstreamError('timeout', `${what} timed out after ${ms} ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** True when the SERVER answered with an error; false when the connection itself failed. */
function answeredByServer(err: unknown): boolean {
  return err instanceof McpError && err.code !== ErrorCode.ConnectionClosed && err.code !== ErrorCode.RequestTimeout;
}

function scrubDeep<T>(value: T, secrets: Redaction[]): T {
  if (secrets.length === 0 || value === undefined) return value;
  const text = JSON.stringify(value);
  const clean = scrub(text, secrets.map((s) => ({ name: s.name, value: JSON.stringify(s.value).slice(1, -1) })));
  return clean === text ? value : JSON.parse(clean) as T;
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

interface Conn {
  name: string;
  cfg: UpstreamConfig;
  client: Client | null;
  connecting: Promise<Client> | null;
  tools: UpstreamTool[];
  /** resources/list entries' _meta.ui by uri, fetched once per connection. */
  resourceUi: Map<string, unknown> | null;
  secrets: Redaction[];
  failures: number;
  retryTimer: NodeJS.Timeout | null;
  lastError: string | null;
  /** How the upstream is authenticated, for upstream_status. */
  auth: 'none' | 'secrets' | 'oauth';
  /** OAuth upstreams only. */
  oauth: UpstreamOAuth | null;
  /** Set while a person has to sign in; `error` is upstream_status.error. */
  needsAuth: { reason: Exclude<AuthRequiredReason, 'requested'>; error: string } | null;
  /** After upstream_auth_forget: no upstream_auth_required until upstream_auth_start. */
  quiet: boolean;
  /** The server connection (session number) this upstream last sent upstream_auth_required on. */
  promptedIn: number;
}

/** One entry of `upstream_status`. */
export interface UpstreamStatusEntry {
  server: string;
  transport: 'http' | 'stdio';
  /** http: scheme + host + port only. stdio: null. */
  origin: string | null;
  auth: 'none' | 'secrets' | 'oauth';
  state: 'connecting' | 'connected' | 'needs_auth' | 'unavailable';
  tools: number;
  error: string | null;
}

/** The upstream sign-in frames the bridge sends (PROTOCOL.md, "Upstream sign-in (OAuth)"). */
export type UpstreamAuthFrame =
  | { type: 'upstream_auth_required'; server: string; state: string; authorization_url: string; expires_at: string; reason: AuthRequiredReason }
  | { type: 'upstream_auth_result'; server: string; state: string | null; ok: true }
  | { type: 'upstream_auth_result'; server: string; state: string | null; ok: false; code: AuthResultCode; error: string };

export interface UpstreamHubOptions {
  resolveSecret?: SecretResolver;
  /** Called when the set of tools the model may see changed. */
  onToolsChanged?: () => void;
  /** Where OAuth registrations and tokens are kept (`<AI_BRIDGE_DATA_DIR>/mcp-oauth`). Needed for an `auth: "oauth"` upstream. */
  oauthDir?: string;
  /** An upstream's state, auth or tool count changed: send upstream_status. */
  onStatusChanged?: () => void;
  /** Send an upstream sign-in frame to the server. */
  sendAuthFrame?: (frame: UpstreamAuthFrame) => void;
  /** Tests: a transport of your own per server. */
  transportFor?: (name: string, cfg: UpstreamConfig, resolved: { env?: Record<string, string>; headers?: Record<string, string> }) => import('@modelcontextprotocol/sdk/shared/transport.js').Transport;
}

export class UpstreamHub {
  private readonly conns = new Map<string, Conn>();
  private readonly pendingUi = new Map<string, CallUi>();
  private closed = false;
  private readonly resolveSecret: SecretResolver;
  /** Counts server connections (welcomes); 0 while none is up. */
  private session = 0;
  private serverUp = false;
  /** welcome.upstream_oauth.redirect_uri of the current server connection. */
  private redirectUri: string | null = null;
  private lastStatus: string | null = null;

  constructor(config: Record<string, UpstreamConfig>, private readonly options: UpstreamHubOptions = {}) {
    this.resolveSecret = options.resolveSecret ?? envResolver;
    for (const [name, cfg] of Object.entries(config)) {
      if (!NAME.test(name) || name.includes(UPSTREAM_SEPARATOR)) {
        log.warn('upstream name refused', { name });
        continue;
      }
      let oauth: UpstreamOAuth | null = null;
      if ('url' in cfg && cfg.auth === 'oauth') {
        if (!options.oauthDir) throw new Error(`MCP upstream "${name}": an OAuth upstream needs a data directory`);
        oauth = new UpstreamOAuth(name, cfg.url, cfg.oauth ?? {}, new OAuthStore(options.oauthDir));
      }
      const refs = Object.values(('url' in cfg ? cfg.headers : cfg.env) ?? {}).some((v) => typeof v !== 'string');
      this.conns.set(name, {
        name, cfg, client: null, connecting: null, tools: [], resourceUi: null,
        secrets: [], failures: 0, retryTimer: null, lastError: null,
        auth: oauth ? 'oauth' : refs ? 'secrets' : 'none',
        oauth, needsAuth: null, quiet: false, promptedIn: 0,
      });
    }
  }

  get serverNames(): string[] {
    return [...this.conns.keys()];
  }

  /** Which servers are connected right now, for logging and tests. */
  status(): Record<string, { connected: boolean; tools: number; last_error: string | null; state: UpstreamStatusEntry['state'] }> {
    const out: Record<string, { connected: boolean; tools: number; last_error: string | null; state: UpstreamStatusEntry['state'] }> = {};
    for (const c of this.conns.values()) out[c.name] = { connected: c.client !== null, tools: c.tools.length, last_error: c.lastError, state: this.stateOf(c) };
    return out;
  }

  /** Resolved values plus every OAuth token: what is redacted from anything going out. */
  private secretsOf(c: Conn): Redaction[] {
    return c.oauth ? [...c.secrets, ...c.oauth.secrets()] : c.secrets;
  }

  /**
   * Connect to every configured server, in parallel. One that fails is logged
   * and retried in the background with backoff; it never fails the bridge.
   */
  async start(): Promise<void> {
    await Promise.all([...this.conns.values()].map((c) => this.ensure(c).catch(() => undefined)));
  }

  private async resolveAll(c: Conn): Promise<{ env?: Record<string, string>; headers?: Record<string, string> }> {
    const secrets: Redaction[] = [];
    const resolveMap = async (kind: 'env' | 'header', m: Record<string, ConfigValue> | undefined) => {
      if (!m) return undefined;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(m)) {
        if (typeof v === 'string') { out[k] = v; continue; }
        let value: string;
        try { value = await this.resolveSecret(v); } catch (err) {
          throw new UpstreamError('unavailable', `${kind} ${k}: ${err instanceof Error ? err.message : String(err)}`);
        }
        out[k] = value;
        // The bare secret, not the prefix: "Bearer " is not worth hiding.
        const bare = v.prefix && value.startsWith(v.prefix) ? value.slice(v.prefix.length) : value;
        secrets.push({ name: `${c.name}.${k}`, value: bare });
      }
      return out;
    };
    const env = 'command' in c.cfg ? await resolveMap('env', c.cfg.env) : undefined;
    const headers = 'url' in c.cfg ? await resolveMap('header', c.cfg.headers) : undefined;
    c.secrets = secrets;
    return { ...(env ? { env } : {}), ...(headers ? { headers } : {}) };
  }

  /** The connected client, connecting (now, not at the next backoff) when it is not. */
  private ensure(c: Conn): Promise<Client> {
    if (this.closed) return Promise.reject(new UpstreamError('unavailable', 'the bridge is shutting down'));
    if (c.client) return Promise.resolve(c.client);
    if (c.needsAuth) return Promise.reject(new UpstreamError('unavailable', this.signInText(c)));
    if (c.connecting) return c.connecting;
    if (c.retryTimer) { clearTimeout(c.retryTimer); c.retryTimer = null; }
    c.connecting = this.connect(c).then(
      (client) => { c.connecting = null; this.statusMaybeChanged(); return client; },
      (err: unknown) => {
        c.connecting = null;
        if (err instanceof NeedsAuthError) {
          this.enterNeedsAuth(c, err.reason);
          throw new UpstreamError('unavailable', this.signInText(c));
        }
        c.failures += 1;
        c.lastError = scrub(err instanceof Error ? err.message : String(err), this.secretsOf(c));
        log.warn('upstream MCP server unavailable', { name: c.name, error: c.lastError, attempt: c.failures });
        this.scheduleReconnect(c);
        this.statusMaybeChanged();
        throw err instanceof UpstreamError ? new UpstreamError(err.code === 'timeout' ? 'unavailable' : err.code, `upstream ${c.name} is unavailable: ${c.lastError}`)
          : new UpstreamError('unavailable', `upstream ${c.name} is unavailable: ${c.lastError}`);
      },
    );
    return c.connecting;
  }

  private scheduleReconnect(c: Conn): void {
    if (this.closed || c.retryTimer || c.needsAuth) return;
    const wait = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, c.failures - 1));
    c.retryTimer = setTimeout(() => {
      c.retryTimer = null;
      this.ensure(c).catch(() => undefined);
    }, wait);
    c.retryTimer.unref();
  }

  private async connect(c: Conn): Promise<Client> {
    const resolved = await this.resolveAll(c);
    const client = new Client({ name: 'ai-bridge', version: '0.1.0' }, {
      capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } } as never,
    });
    let transport;
    if (this.options.transportFor) {
      transport = this.options.transportFor(c.name, c.cfg, resolved);
    } else if ('url' in c.cfg) {
      transport = new StreamableHTTPClientTransport(new URL(c.cfg.url), {
        ...(resolved.headers ? { requestInit: { headers: resolved.headers } } : {}),
        // OAuth: the bearer token, refreshed before expiry or on a 401 (src/mcp/oauth.ts).
        ...(c.oauth ? { fetch: c.oauth.fetch } : {}),
      });
    } else {
      // Never the bridge's own environment: it holds AI_BRIDGE_TOKEN. Only the
      // SDK's safe defaults (HOME, PATH, ...) and what the config names.
      const stdio = new StdioClientTransport({
        command: c.cfg.command,
        args: c.cfg.args ?? [],
        env: { ...getDefaultEnvironment(), ...(resolved.env ?? {}) },
        ...(c.cfg.cwd ? { cwd: c.cfg.cwd } : {}),
        stderr: 'pipe',
      });
      stdio.stderr?.on('data', (chunk: Buffer) => {
        log.debug('upstream stderr', { name: c.name, text: scrub(chunk.toString('utf8').trimEnd(), this.secretsOf(c)) });
      });
      transport = stdio;
    }
    try {
      await withTimeout(client.connect(transport), c.cfg.connect_timeout_ms ?? DEFAULT_CONNECT_TIMEOUT_MS, `connecting to ${c.name}`);
      const tools = await this.listAllTools(client, c);
      if (this.closed) throw new UpstreamError('unavailable', 'the bridge is shutting down');
      c.client = client;
      c.tools = tools;
      c.resourceUi = null;
      c.failures = 0;
      c.lastError = null;
      c.needsAuth = null;
    } catch (err) {
      await client.close().catch(() => undefined);
      throw err;
    }
    client.onclose = () => this.dropped(c, client, 'connection closed');
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      try {
        c.tools = await this.listAllTools(client, c);
        this.options.onToolsChanged?.();
        this.statusMaybeChanged();
      } catch (err) {
        log.warn('upstream tools/list after list_changed failed', { name: c.name, error: err instanceof Error ? err.message : String(err) });
      }
    });
    log.info('upstream MCP server connected', { name: c.name, tools: c.tools.map((t) => t.name) });
    this.options.onToolsChanged?.();
    return client;
  }

  private async listAllTools(client: Client, c: Conn): Promise<UpstreamTool[]> {
    const tools: UpstreamTool[] = [];
    let cursor: string | undefined;
    const timeout = c.cfg.timeout_ms ?? DEFAULT_CALL_TIMEOUT_MS;
    for (let page = 0; page < 50; page++) {
      const listed = await client.listTools(cursor ? { cursor } : undefined, { timeout });
      for (const t of listed.tools) {
        tools.push({ server: c.name, name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown>, _meta: t._meta as Record<string, unknown> | undefined });
      }
      cursor = listed.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  /**
   * The connection went away (the process exited, the transport closed, or a
   * request failed without the server answering). Its tools stay listed, so a
   * CLI mid-turn does not see them vanish; the next use reconnects at once, and
   * a reconnect is also tried in the background.
   */
  private dropped(c: Conn, client: Client, why: string): void {
    if (c.client !== client) return;
    c.client = null;
    c.lastError = why;
    if (this.closed) return;
    log.warn('upstream MCP server disconnected; reconnecting', { name: c.name, why });
    client.onclose = undefined;
    void client.close().catch(() => undefined);
    c.failures = Math.max(c.failures, 1);
    this.scheduleReconnect(c);
    this.statusMaybeChanged();
  }

  /** Run one request on a server, with its timeout, mapping failures to codes. */
  private async run<T>(c: Conn, what: string, fn: (client: Client, timeout: number) => Promise<T>): Promise<T> {
    const client = await this.ensure(c);
    const timeout = c.cfg.timeout_ms ?? DEFAULT_CALL_TIMEOUT_MS;
    try {
      return await fn(client, timeout);
    } catch (err) {
      if (err instanceof NeedsAuthError) {
        this.enterNeedsAuth(c, err.reason);
        throw new UpstreamError('unavailable', this.signInText(c));
      }
      const msg = scrub(err instanceof Error ? err.message : String(err), this.secretsOf(c));
      if (err instanceof McpError && err.code === ErrorCode.RequestTimeout) {
        throw new UpstreamError('timeout', `${what} on ${c.name} timed out after ${timeout} ms`);
      }
      if (!answeredByServer(err)) this.dropped(c, client, msg);
      throw new UpstreamError('upstream_error', `${what} on ${c.name} failed: ${msg}`);
    }
  }

  // -------------------------------------------------------------------------
  // What the model sees
  // -------------------------------------------------------------------------

  /** The tools the MODEL sees, namespaced. A tool only for its app ("visibility": ["app"]) is left out. */
  definitions(): ToolDefinition[] {
    return this.allTools()
      .filter((t) => visibility(t._meta).includes('model'))
      .map((t) => ({
        name: `${t.server}${UPSTREAM_SEPARATOR}${t.name}`,
        description: t.description ?? '',
        parameters: t.inputSchema ?? { type: 'object', properties: {} },
        ...(t._meta ? { _meta: t._meta } : {}),
      }));
  }

  private allTools(): UpstreamTool[] {
    return [...this.conns.values()].filter((c) => !c.needsAuth).flatMap((c) => c.tools);
  }

  /**
   * For a call by name to a tool of an upstream that needs a sign-in (and so
   * is not offered): what to tell the model. Null when that is not the case.
   */
  signInNeeded(qualified: string): string | null {
    const i = qualified.indexOf(UPSTREAM_SEPARATOR);
    if (i <= 0) return null;
    const c = this.conns.get(qualified.slice(0, i));
    return c?.needsAuth ? this.signInText(c) : null;
  }

  private signInText(c: Conn): string {
    if (c.needsAuth?.error === 'no_redirect_uri') {
      return `The MCP server "${c.name}" needs a sign-in, and this application cannot offer one (it gave the bridge no redirect address). Its tools cannot be used until the bridge operator fixes that.`;
    }
    if (c.quiet) {
      return `The MCP server "${c.name}" was signed out on this bridge. The person can connect it again in the application; until then its tools cannot be used.`;
    }
    return `The MCP server "${c.name}" needs the person to sign in before its tools can be used. They have been asked to sign in; try again after they have.`;
  }

  owns(qualified: string): boolean {
    return this.find(qualified) !== undefined;
  }

  private find(qualified: string): UpstreamTool | undefined {
    return this.allTools().find((t) => `${t.server}${UPSTREAM_SEPARATOR}${t.name}` === qualified && visibility(t._meta).includes('model'));
  }

  /** A call from the CLI. Returns the text the model reads; remembers the view for the host. */
  async callFromModel(qualified: string, args: Record<string, unknown>, providerToolCallId?: string): Promise<{ text: string; isError: boolean }> {
    const tool = this.find(qualified);
    if (!tool) throw new UpstreamError('refused', `no upstream tool ${qualified}`);
    const c = this.conns.get(tool.server)!;
    const raw = await this.run(c, `tools/call ${tool.name}`, (client, timeout) => client.callTool({ name: tool.name, arguments: args }, undefined, { timeout }));
    const result = scrubDeep(raw, this.secretsOf(c)) as {
      content?: { type: string; text?: string }[]; isError?: boolean; structuredContent?: unknown; _meta?: unknown;
    };
    const uri = resourceUriOf(tool._meta);
    if (uri && providerToolCallId) {
      this.pendingUi.set(providerToolCallId, { server: tool.server, tool_name: tool.name, resource_uri: uri, arguments: args, result });
      // Never held for ever: a CLI that never reports the result frees it.
      setTimeout(() => this.pendingUi.delete(providerToolCallId), PENDING_UI_TTL_MS).unref();
    }
    let text = (result.content ?? []).map((c) => (c.type === 'text' ? c.text ?? '' : `[${c.type} content]`)).join('\n');
    // A server that gives only structuredContent still tells the model something.
    if (text === '' && result.structuredContent !== undefined) text = JSON.stringify(result.structuredContent);
    return { text, isError: result.isError === true };
  }

  /** The view for a call, once: attached to the first tool_result frame that names it. */
  takeUi(toolCallId: string): CallUi | undefined {
    const ui = this.pendingUi.get(toolCallId);
    if (ui) this.pendingUi.delete(toolCallId);
    return ui;
  }

  // -------------------------------------------------------------------------
  // What a view asks for, through the host
  // -------------------------------------------------------------------------

  /**
   * A view's request, relayed by the host. Only the two methods a view needs,
   * and a tools/call only for a tool its server lets an app call.
   */
  async request(server: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    const c = this.conns.get(server);
    if (!c) throw new UpstreamError('unknown_server', `no upstream server ${server}`);
    if (c.needsAuth) throw new UpstreamError('unavailable', this.signInText(c));
    if (method === 'resources/read') {
      const uri = String(params['uri'] ?? '');
      if (!uri.startsWith('ui://')) throw new UpstreamError('refused', 'only ui:// resources are read for a view');
      const result = await this.run(c, 'resources/read', (client, timeout) => client.readResource({ uri }, { timeout }));
      await this.fillResourceUi(c, result as { contents?: Record<string, unknown>[] });
      return scrubDeep(result, this.secretsOf(c));
    }
    if (method === 'tools/call') {
      const name = String(params['name'] ?? '');
      const tool = c.tools.find((t) => t.name === name);
      if (!tool) throw new UpstreamError('refused', `no tool ${name} on ${server}`);
      if (!visibility(tool._meta).includes('app')) throw new UpstreamError('refused', `${name} is not callable from a view`);
      const args = (params['arguments'] ?? {}) as Record<string, unknown>;
      return scrubDeep(await this.run(c, `tools/call ${name}`, (client, timeout) => client.callTool({ name, arguments: args }, undefined, { timeout })), this.secretsOf(c));
    }
    throw new UpstreamError('unsupported', `unsupported method ${method}`);
  }

  /**
   * The spec's fallback, done here so the host needs no second call: a content
   * item without `_meta.ui` gets the `_meta.ui` of its resources/list entry.
   * What the item itself declares is never changed.
   */
  private async fillResourceUi(c: Conn, result: { contents?: Record<string, unknown>[] }): Promise<void> {
    const missing = (result.contents ?? []).filter((item) => !(item['_meta'] as { ui?: unknown } | undefined)?.ui);
    if (missing.length === 0) return;
    if (!c.resourceUi) {
      const map = new Map<string, unknown>();
      try {
        const listed = await this.run(c, 'resources/list', (client, timeout) => client.listResources(undefined, { timeout }));
        for (const r of listed.resources) {
          const ui = (r._meta as { ui?: unknown } | undefined)?.ui;
          if (ui) map.set(r.uri, ui);
        }
      } catch (err) {
        log.debug('resources/list for view metadata failed; reading without it', { name: c.name, error: err instanceof Error ? err.message : String(err) });
      }
      c.resourceUi = map;
    }
    for (const item of missing) {
      const ui = c.resourceUi.get(String(item['uri']));
      if (ui) item['_meta'] = { ...((item['_meta'] as Record<string, unknown> | undefined) ?? {}), ui };
    }
  }

  // -------------------------------------------------------------------------
  // Upstream sign-in (OAuth) and upstream_status
  // -------------------------------------------------------------------------

  private stateOf(c: Conn): UpstreamStatusEntry['state'] {
    if (c.client) return 'connected';
    if (c.needsAuth) return 'needs_auth';
    if (c.connecting || (c.failures === 0 && c.lastError === null)) return 'connecting';
    return 'unavailable';
  }

  /** The complete list, as upstream_status carries it. Never holds a secret. */
  upstreamStatus(): UpstreamStatusEntry[] {
    return [...this.conns.values()].map((c) => {
      const state = this.stateOf(c);
      const error = state === 'needs_auth' ? c.needsAuth!.error
        : state === 'unavailable' ? scrub(c.lastError ?? 'unavailable', this.secretsOf(c)).slice(0, 300)
        : null;
      return {
        server: c.name,
        transport: 'url' in c.cfg ? 'http' as const : 'stdio' as const,
        origin: 'url' in c.cfg ? new URL(c.cfg.url).origin : null,
        auth: c.auth,
        state,
        tools: state === 'connected' ? c.tools.length : 0,
        error,
      };
    });
  }

  /** Send upstream_status when the list differs from the last one sent on this server connection. */
  private statusMaybeChanged(): void {
    if (!this.serverUp || this.closed) return;
    const now = JSON.stringify(this.upstreamStatus());
    if (now === this.lastStatus) return;
    this.lastStatus = now;
    this.options.onStatusChanged?.();
  }

  /**
   * A server connection completed its handshake. `redirectUri` is its
   * welcome.upstream_oauth.redirect_uri, or null without one. Sends
   * upstream_status, and asks for a sign-in for every OAuth upstream that
   * needs one (once per server connection), unless it was signed out.
   */
  serverConnected(redirectUri: string | null): void {
    this.session += 1;
    this.serverUp = true;
    this.redirectUri = redirectUri;
    this.lastStatus = null;
    for (const c of this.conns.values()) {
      if (!c.oauth || !c.needsAuth) continue;
      if (!redirectUri) c.needsAuth.error = 'no_redirect_uri';
      else if (c.needsAuth.error === 'no_redirect_uri') c.needsAuth.error = c.needsAuth.reason;
    }
    this.statusMaybeChanged();
    for (const c of this.conns.values()) {
      if (c.oauth && c.needsAuth && !c.quiet) void this.prompt(c, c.needsAuth.reason);
    }
  }

  /** The server connection went away. Pending sign-ins stay valid until they expire. */
  serverDisconnected(): void {
    this.serverUp = false;
    this.lastStatus = null;
  }

  private enterNeedsAuth(c: Conn, reason: Exclude<AuthRequiredReason, 'requested'>): void {
    const client = c.client;
    c.client = null;
    if (client) { client.onclose = undefined; void client.close().catch(() => undefined); }
    if (c.retryTimer) { clearTimeout(c.retryTimer); c.retryTimer = null; }
    const hadTools = c.tools.length > 0;
    c.tools = [];
    c.resourceUi = null;
    c.failures = 0;
    c.lastError = null;
    const fresh = !c.needsAuth;
    c.needsAuth = { reason, error: this.serverUp && !this.redirectUri ? 'no_redirect_uri' : reason };
    log.info('upstream MCP server needs a sign-in', { name: c.name, reason });
    if (hadTools) this.options.onToolsChanged?.();
    this.statusMaybeChanged();
    if (c.quiet) return;
    // no_token: once per server connection. A failed refresh or a rejected
    // token is news each time it happens.
    if (reason !== 'no_token' || (fresh && c.promptedIn !== this.session)) void this.prompt(c, reason);
  }

  /** Make a sign-in link and send it. Failures go out as upstream_auth_result ok:false. */
  private async prompt(c: Conn, reason: AuthRequiredReason): Promise<void> {
    if (!this.serverUp || !c.oauth || this.closed) return;
    const session = this.session;
    if (!this.redirectUri) {
      if (c.needsAuth) c.needsAuth.error = 'no_redirect_uri';
      this.statusMaybeChanged();
      if (reason === 'requested') this.authFailure(c.name, null, 'no_redirect_uri', 'This application gave the bridge no redirect address, so it cannot offer a sign-in.');
      return;
    }
    c.promptedIn = session;
    try {
      const link = await c.oauth.begin(this.redirectUri);
      if (session !== this.session || !this.serverUp) return; // that server connection is gone
      this.options.sendAuthFrame?.({ type: 'upstream_auth_required', server: c.name, ...link, reason });
    } catch (err) {
      const code: AuthResultCode = err instanceof OAuthFlowError ? err.code : 'discovery_failed';
      const text = scrub(err instanceof Error ? err.message : String(err), this.secretsOf(c));
      log.warn('upstream sign-in could not be prepared', { name: c.name, code, error: text });
      if (c.needsAuth) c.needsAuth.error = code;
      this.statusMaybeChanged();
      this.authFailure(c.name, null, code, text);
    }
  }

  private authFailure(server: string, state: string | null, code: AuthResultCode, error: string): void {
    this.options.sendAuthFrame?.({ type: 'upstream_auth_result', server, state, ok: false, code, error });
  }

  /** upstream_auth_start: the person asked to (re)connect. */
  async authStart(server: string): Promise<void> {
    const c = this.conns.get(server);
    if (!c) return this.authFailure(server, null, 'unknown_server', `no upstream server ${server} on this bridge`);
    if (!c.oauth) return this.authFailure(server, null, 'not_oauth', `upstream ${server} does not use OAuth`);
    c.quiet = false;
    await this.prompt(c, 'requested');
  }

  /** upstream_auth_code: the redirect came back through the web application. Answered exactly once. */
  async authCode(server: string, state: unknown, params: RedirectParams): Promise<void> {
    const st = typeof state === 'string' ? state : null;
    const c = this.conns.get(server);
    if (!c) return this.authFailure(server, st, 'unknown_server', `no upstream server ${server} on this bridge`);
    if (!c.oauth) return this.authFailure(server, st, 'not_oauth', `upstream ${server} does not use OAuth`);
    try {
      await c.oauth.complete(st ?? '', params);
    } catch (err) {
      const code: AuthResultCode = err instanceof OAuthFlowError ? err.code : 'exchange_failed';
      const text = scrub(err instanceof Error ? err.message : String(err), this.secretsOf(c));
      log.info('upstream sign-in failed', { name: c.name, code, error: text });
      // A stale link changes nothing; a refused or failed sign-in is the upstream's state now.
      if (code !== 'unknown_state' && c.needsAuth) { c.needsAuth.error = code; this.statusMaybeChanged(); }
      return this.authFailure(server, st, code, text);
    }
    this.options.sendAuthFrame?.({ type: 'upstream_auth_result', server, state: st, ok: true });
    // Connect with the new token: lists the tools, tells the CLI (onToolsChanged), sends upstream_status.
    const old = c.client;
    c.client = null;
    if (old) { old.onclose = undefined; await old.close().catch(() => undefined); }
    c.needsAuth = null;
    c.quiet = false;
    // Signed in: a later loss of the token is news again on this server connection.
    c.promptedIn = 0;
    c.failures = 0;
    c.lastError = null;
    if (c.retryTimer) { clearTimeout(c.retryTimer); c.retryTimer = null; }
    this.statusMaybeChanged();
    await this.ensure(c).catch(() => undefined);
  }

  /** upstream_auth_forget: drop this upstream's tokens here. No sign-in is offered until upstream_auth_start. */
  async authForget(server: string): Promise<void> {
    const c = this.conns.get(server);
    if (!c || !c.oauth) {
      log.info('upstream_auth_forget for an unknown or non-OAuth upstream; ignored', { server });
      return;
    }
    c.oauth.forget();
    c.quiet = true;
    const pending = c.connecting;
    this.enterNeedsAuth(c, 'no_token');
    await pending?.catch(() => undefined);
    // A connect that was under way when the tokens went may have finished.
    if (c.client) this.enterNeedsAuth(c, 'no_token');
    log.info('upstream tokens forgotten', { name: c.name });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const c of this.conns.values()) {
      if (c.retryTimer) { clearTimeout(c.retryTimer); c.retryTimer = null; }
      const client = c.client;
      c.client = null;
      if (client) { client.onclose = undefined; await client.close().catch(() => undefined); }
      await c.connecting?.then((cl) => cl.close(), () => undefined).catch(() => undefined);
    }
  }
}
