/**
 * OAuth sign-in for `--mcp-upstreams` servers that require it (the MCP
 * authorization spec: RFC 9728 protected resource metadata, RFC 8414 / OIDC
 * discovery, RFC 7591 dynamic client registration, PKCE S256, RFC 8707
 * `resource`). PROTOCOL.md, "Upstream sign-in (OAuth)".
 *
 * The bridge usually runs on a machine the person is not sitting at, so the
 * authorization server redirects the browser to the WEB APPLICATION
 * (`welcome.upstream_oauth.redirect_uri`), which passes the one-time code back
 * over the WebSocket (`upstream_auth_code`). Only this module holds the PKCE
 * verifier, so only the bridge can turn the code into tokens; the tokens never
 * leave this machine.
 *
 * Each protocol step uses the MCP SDK's own client auth helpers (discovery,
 * registration, startAuthorization, exchangeAuthorization,
 * refreshAuthorization). The SDK's all-in-one `auth()` / transport
 * `authProvider` is NOT used: it decides by itself between refreshing and
 * redirecting and reports every failure the same way, and the bridge must say
 * which step failed (`discovery_failed`, `registration_failed`, ...), why a
 * sign-in is needed (`no_token`, `refresh_failed`, `rejected`), and keep at
 * most one pending `state` per upstream. Instead the transport gets `fetch`
 * from here, which adds the bearer token, refreshes once before expiry or on a
 * 401, and throws NeedsAuthError when a person has to sign in.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  discoverOAuthServerInfo, exchangeAuthorization, extractWWWAuthenticateParams, refreshAuthorization,
  registerClient, selectResourceURL, startAuthorization,
  type OAuthClientProvider, type OAuthServerInfo,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { OAuthError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { Redaction } from '../local/scrub.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('mcp-oauth');

/** The revision of the bridge's upstream sign-in frames (hello.mcp_upstream_auth). */
export const MCP_UPSTREAM_AUTH_REVISION = 1;
/** How long a sign-in link (its `state`) is good for. */
export const SIGN_IN_TTL_MS = 10 * 60_000;
/** Refresh this long before the access token expires. */
const REFRESH_MARGIN_MS = 60_000;
const DEFAULT_CLIENT_NAME = 'AI Bridge';

/** Why a person is asked to sign in (`upstream_auth_required.reason`). */
export type AuthRequiredReason = 'no_token' | 'refresh_failed' | 'rejected' | 'requested';

/** `upstream_auth_result.code`. */
export type AuthResultCode =
  | 'unknown_server' | 'not_oauth' | 'unknown_state' | 'denied' | 'no_redirect_uri'
  | 'discovery_failed' | 'registration_failed' | 'exchange_failed' | 'issuer_mismatch';

export interface OAuthOptions {
  /** Space-separated scopes. Absent: the protected resource's scopes_supported, if any. */
  scope?: string;
  /** Sent at dynamic registration. Default 'AI Bridge'. */
  client_name?: string;
}

/** A step of a sign-in failed; `code` is what upstream_auth_result carries. */
export class OAuthFlowError extends Error {
  constructor(readonly code: AuthResultCode, message: string) {
    super(message);
    this.name = 'OAuthFlowError';
  }
}

/** The upstream cannot be used until a person signs in. Thrown out of the transport's fetch. */
export class NeedsAuthError extends Error {
  constructor(readonly reason: Exclude<AuthRequiredReason, 'requested'>, message: string) {
    super(message);
    this.name = 'NeedsAuthError';
  }
}

// ---------------------------------------------------------------------------
// Storage: <AI_BRIDGE_DATA_DIR>/mcp-oauth/, directory 0700, files 0600
// ---------------------------------------------------------------------------

export interface StoredTokens {
  /** The upstream's url, for a person reading the file. The file name is a hash of it. */
  url: string;
  access_token: string;
  token_type: string;
  refresh_token?: string;
  /** Epoch ms; absent when the server gave no expires_in. */
  expires_at?: number;
  scope?: string;
  /** The redirect the issuing client was registered with: a refresh uses that client. */
  redirect_uri?: string;
}

interface StoredClient {
  url: string;
  redirect_uri: string;
  client: OAuthClientInformationFull;
  registered_at: string;
}

export class OAuthStore {
  constructor(readonly dir: string) {}

  private path(kind: 'client' | 'tokens', key: string): string {
    return join(this.dir, `${kind}-${createHash('sha256').update(key).digest('hex').slice(0, 32)}.json`);
  }

  private read<T>(file: string): T | null {
    try { return JSON.parse(readFileSync(file, 'utf8')) as T; } catch { return null; }
  }

  private write(file: string, value: unknown): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  }

  /** Keyed by (url, redirect_uri): a bridge serving two web applications registers once per redirect. */
  readClient(url: string, redirectUri: string): OAuthClientInformationFull | null {
    const s = this.read<StoredClient>(this.path('client', JSON.stringify([url, redirectUri])));
    return s && s.url === url && s.redirect_uri === redirectUri ? s.client : null;
  }

  writeClient(url: string, redirectUri: string, client: OAuthClientInformationFull): void {
    this.write(this.path('client', JSON.stringify([url, redirectUri])), { url, redirect_uri: redirectUri, client, registered_at: new Date().toISOString() } satisfies StoredClient);
  }

  deleteClient(url: string, redirectUri: string): void {
    rmSync(this.path('client', JSON.stringify([url, redirectUri])), { force: true });
  }

  /** Keyed by the upstream's url. */
  readTokens(url: string): StoredTokens | null {
    const t = this.read<StoredTokens>(this.path('tokens', url));
    return t && t.url === url && typeof t.access_token === 'string' ? t : null;
  }

  writeTokens(tokens: StoredTokens): void {
    this.write(this.path('tokens', tokens.url), tokens);
  }

  deleteTokens(url: string): void {
    rmSync(this.path('tokens', url), { force: true });
  }
}

// ---------------------------------------------------------------------------
// One upstream's sign-in
// ---------------------------------------------------------------------------

interface Pending {
  state: string;
  verifier: string;
  redirectUri: string;
  client: OAuthClientInformationFull;
  expiresAt: number;
}

interface Discovered {
  info: OAuthServerInfo & { authorizationServerMetadata: NonNullable<OAuthServerInfo['authorizationServerMetadata']> };
  resource: URL | undefined;
  scope: string | undefined;
}

export interface SignInLink {
  state: string;
  authorization_url: string;
  /** ISO 8601, UTC, seconds precision. */
  expires_at: string;
}

/** The parameters of the redirect, as the web application passed them on. */
export interface RedirectParams {
  code?: string;
  error?: string;
  error_description?: string;
  iss?: string;
}

function message(err: unknown): string {
  if (err instanceof OAuthError) return err.message ? `${err.errorCode}: ${err.message}` : err.errorCode;
  return err instanceof Error ? err.message : String(err);
}

function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function isoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export class UpstreamOAuth {
  private tokens: StoredTokens | null | undefined; // undefined: not read from disk yet
  private pending: Pending | null = null;
  private discovered: Discovered | null = null;
  private resourceMetadataUrl: URL | undefined;
  private refreshing: Promise<StoredTokens> | null = null;
  private readonly base: FetchLike;

  constructor(
    readonly server: string,
    readonly url: string,
    private readonly options: OAuthOptions,
    private readonly store: OAuthStore,
    fetchFn?: FetchLike,
  ) {
    this.base = fetchFn ?? ((input, init) => fetch(input, init));
  }

  private current(): StoredTokens | null {
    if (this.tokens === undefined) this.tokens = this.store.readTokens(this.url);
    return this.tokens;
  }

  /** Whether there is a token to try. Not whether the upstream will accept it. */
  hasToken(): boolean {
    return this.current() !== null;
  }

  /** Every token value, for the redaction set. Never logged, never sent to the server. */
  secrets(): Redaction[] {
    const out: Redaction[] = [];
    const t = this.current();
    if (t) {
      out.push({ name: `${this.server}.access_token`, value: t.access_token });
      if (t.refresh_token) out.push({ name: `${this.server}.refresh_token`, value: t.refresh_token });
    }
    if (this.pending) out.push({ name: `${this.server}.code_verifier`, value: this.pending.verifier });
    const secret = this.pending?.client.client_secret;
    if (secret) out.push({ name: `${this.server}.client_secret`, value: secret });
    return out;
  }

  /** Forget the tokens, here and on disk. The client registration stays. */
  forget(): void {
    this.tokens = null;
    this.pending = null;
    this.store.deleteTokens(this.url);
  }

  private save(tokens: OAuthTokens, previous: StoredTokens | null, redirectUri?: string): StoredTokens {
    const stored: StoredTokens = {
      url: this.url,
      access_token: tokens.access_token,
      token_type: tokens.token_type,
      // A refresh response may leave the refresh token out: the old one stays good.
      ...(tokens.refresh_token ?? previous?.refresh_token ? { refresh_token: tokens.refresh_token ?? previous!.refresh_token! } : {}),
      ...(typeof tokens.expires_in === 'number' ? { expires_at: Date.now() + tokens.expires_in * 1000 } : {}),
      ...(tokens.scope ? { scope: tokens.scope } : {}),
      ...(redirectUri ?? previous?.redirect_uri ? { redirect_uri: redirectUri ?? previous!.redirect_uri! } : {}),
    };
    this.store.writeTokens(stored);
    this.tokens = stored;
    return stored;
  }

  private drop(deleteFile: boolean): void {
    this.tokens = null;
    if (deleteFile) this.store.deleteTokens(this.url);
  }

  // -------------------------------------------------------------------------
  // The transport's fetch
  // -------------------------------------------------------------------------

  private noteChallenge(res: Response): void {
    const { resourceMetadataUrl } = extractWWWAuthenticateParams(res);
    if (resourceMetadataUrl && resourceMetadataUrl.href !== this.resourceMetadataUrl?.href) {
      this.resourceMetadataUrl = resourceMetadataUrl;
      this.discovered = null;
    }
  }

  /** The token to send, refreshed first when it expires within a minute. */
  private async usable(): Promise<StoredTokens | null> {
    const t = this.current();
    if (!t) return null;
    if (t.expires_at === undefined || t.expires_at - Date.now() > REFRESH_MARGIN_MS) return t;
    if (!t.refresh_token) {
      this.drop(true);
      return null;
    }
    try {
      return await this.refresh(t);
    } catch (err) {
      throw new NeedsAuthError('refresh_failed', `refreshing the token failed: ${message(err)}`);
    }
  }

  /** Refresh once; concurrent callers share the one attempt. */
  private refresh(t: StoredTokens): Promise<StoredTokens> {
    if (!this.refreshing) {
      this.refreshing = (async () => {
        try {
          const d = await this.discover();
          const client = this.anyClient();
          if (!client) throw new Error('no client registration to refresh with');
          const tokens = await refreshAuthorization(d.info.authorizationServerUrl, {
            metadata: d.info.authorizationServerMetadata,
            clientInformation: client,
            refreshToken: t.refresh_token!,
            ...(d.resource ? { resource: d.resource } : {}),
            fetchFn: this.base,
          });
          log.info('upstream token refreshed', { name: this.server });
          return this.save(tokens, t);
        } catch (err) {
          // An answer from the authorization server (invalid_grant, ...) means
          // the refresh token is dead; a network failure does not, so the file
          // stays for the next start. Either way this process asks to sign in.
          this.drop(err instanceof OAuthError);
          throw err;
        } finally {
          this.refreshing = null;
        }
      })();
    }
    return this.refreshing;
  }

  /** The client the current tokens were issued to (registered for the redirect they came back through). */
  private anyClient(): OAuthClientInformationFull | null {
    const redirect = this.current()?.redirect_uri;
    return redirect ? this.store.readClient(this.url, redirect) : null;
  }

  /** For StreamableHTTPClientTransport's `fetch` option. */
  readonly fetch: FetchLike = async (input, init) => {
    const t = await this.usable();
    if (!t) {
      // No token: the request goes without one. A 401 is how the upstream
      // says where its protected resource metadata is.
      const res = await this.base(input, init);
      if (res.status === 401) {
        this.noteChallenge(res);
        await res.body?.cancel().catch(() => undefined);
        throw new NeedsAuthError('no_token', `${this.server} requires a sign-in`);
      }
      return res;
    }
    const res = await this.base(input, withBearer(init, t.access_token));
    if (res.status !== 401) return res;
    this.noteChallenge(res);
    await res.body?.cancel().catch(() => undefined);
    if (!t.refresh_token) {
      this.drop(true);
      throw new NeedsAuthError('rejected', `${this.server} rejected the token`);
    }
    let fresh: StoredTokens;
    try {
      fresh = await this.refresh(t);
    } catch (err) {
      throw new NeedsAuthError('refresh_failed', `refreshing the token failed: ${message(err)}`);
    }
    const again = await this.base(input, withBearer(init, fresh.access_token));
    if (again.status === 401) {
      await again.body?.cancel().catch(() => undefined);
      this.drop(true);
      throw new NeedsAuthError('rejected', `${this.server} rejected a freshly refreshed token`);
    }
    return again;
  };

  // -------------------------------------------------------------------------
  // Discovery, registration, the link
  // -------------------------------------------------------------------------

  /** Ask the upstream, without a token, where its metadata is. */
  private async probe(): Promise<void> {
    const res = await this.base(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ai-bridge', version: '0' } } }),
    });
    if (res.status === 401) this.noteChallenge(res);
    await res.body?.cancel().catch(() => undefined);
  }

  private async discover(): Promise<Discovered> {
    if (this.discovered) return this.discovered;
    if (!this.resourceMetadataUrl) await this.probe();
    const info = await discoverOAuthServerInfo(this.url, {
      ...(this.resourceMetadataUrl ? { resourceMetadataUrl: this.resourceMetadataUrl } : {}),
      fetchFn: this.base,
    });
    if (!info.authorizationServerMetadata) throw new Error(`no authorization server metadata at ${info.authorizationServerUrl}`);
    // Only selectResourceURL's default validation is wanted, which needs no provider methods.
    const resource = await selectResourceURL(this.url, {} as OAuthClientProvider, info.resourceMetadata);
    const scope = this.options.scope ?? info.resourceMetadata?.scopes_supported?.join(' ') ?? undefined;
    this.discovered = { info: info as Discovered['info'], resource, scope: scope || undefined };
    return this.discovered;
  }

  /**
   * Discovery, registration when there is none for this redirect, and a fresh
   * link. A new link replaces the pending one: its state stops working.
   */
  async begin(redirectUri: string): Promise<SignInLink> {
    let d: Discovered;
    try {
      d = await this.discover();
    } catch (err) {
      throw new OAuthFlowError('discovery_failed', `discovery failed: ${message(err)}`);
    }
    let client = this.store.readClient(this.url, redirectUri);
    if (!client) {
      try {
        client = await registerClient(d.info.authorizationServerUrl, {
          metadata: d.info.authorizationServerMetadata,
          clientMetadata: {
            redirect_uris: [redirectUri],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
            client_name: this.options.client_name ?? DEFAULT_CLIENT_NAME,
          },
          ...(d.scope ? { scope: d.scope } : {}),
          fetchFn: this.base,
        });
      } catch (err) {
        throw new OAuthFlowError('registration_failed', `client registration failed: ${message(err)}`);
      }
      this.store.writeClient(this.url, redirectUri, client);
      log.info('registered with the authorization server', { name: this.server, issuer: d.info.authorizationServerMetadata.issuer });
    }
    const state = randomBytes(32).toString('base64url');
    let started: { authorizationUrl: URL; codeVerifier: string };
    try {
      started = await startAuthorization(d.info.authorizationServerUrl, {
        metadata: d.info.authorizationServerMetadata,
        clientInformation: client,
        redirectUrl: redirectUri,
        state,
        ...(d.scope ? { scope: d.scope } : {}),
        ...(d.resource ? { resource: d.resource } : {}),
      });
    } catch (err) {
      // The metadata says it cannot do code + S256.
      throw new OAuthFlowError('discovery_failed', message(err));
    }
    const expiresAt = Date.now() + SIGN_IN_TTL_MS;
    this.pending = { state, verifier: started.codeVerifier, redirectUri, client, expiresAt };
    return { state, authorization_url: started.authorizationUrl.href, expires_at: isoSeconds(expiresAt) };
  }

  /** Whether `state` is this upstream's pending, unexpired sign-in. */
  isPending(state: string): boolean {
    const p = this.pending;
    return !!p && typeof state === 'string' && sameString(p.state, state) && Date.now() <= p.expiresAt;
  }

  /** The redirect came back. The state is used up whatever happens next. */
  async complete(state: string, params: RedirectParams): Promise<void> {
    if (!this.isPending(state)) {
      if (this.pending && Date.now() > this.pending.expiresAt) this.pending = null;
      throw new OAuthFlowError('unknown_state', 'This sign-in link expired or was replaced by a newer one.');
    }
    const p = this.pending!;
    this.pending = null;
    if (params.error) {
      const detail = params.error_description ? `: ${params.error_description}` : '';
      if (params.error === 'access_denied') throw new OAuthFlowError('denied', `The sign-in was refused${detail}`);
      throw new OAuthFlowError('exchange_failed', `The authorization server answered ${params.error}${detail}`);
    }
    const d = this.discovered ?? await this.discover().catch((err: unknown) => {
      throw new OAuthFlowError('discovery_failed', `discovery failed: ${message(err)}`);
    });
    const meta = d.info.authorizationServerMetadata;
    // RFC 9207: checked when the metadata says the server sends it, and
    // whenever it is present (a wrong issuer is never right).
    if ((meta as Record<string, unknown>)['authorization_response_iss_parameter_supported'] === true || params.iss !== undefined) {
      if (params.iss !== meta.issuer) {
        throw new OAuthFlowError('issuer_mismatch', `The authorization response came from ${params.iss ?? 'an unnamed issuer'}, not ${meta.issuer}`);
      }
    }
    if (!params.code) throw new OAuthFlowError('exchange_failed', 'The redirect carried no code');
    let tokens: OAuthTokens;
    try {
      tokens = await exchangeAuthorization(d.info.authorizationServerUrl, {
        metadata: meta,
        clientInformation: p.client,
        authorizationCode: params.code,
        codeVerifier: p.verifier,
        redirectUri: p.redirectUri,
        ...(d.resource ? { resource: d.resource } : {}),
        fetchFn: this.base,
      });
    } catch (err) {
      throw new OAuthFlowError('exchange_failed', `exchanging the code failed: ${message(err)}`);
    }
    this.save(tokens, null, p.redirectUri);
    log.info('upstream signed in', { name: this.server });
  }
}

function withBearer(init: RequestInit | undefined, token: string): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${token}`);
  return { ...init, headers };
}
