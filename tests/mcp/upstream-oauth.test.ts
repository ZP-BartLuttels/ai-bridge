/**
 * Upstream sign-in (OAuth) in UpstreamHub, against a local fake authorization
 * server + protected MCP server: config, discovery -> registration -> link,
 * the code exchange, every way a state can be wrong, refresh, rejection,
 * forgetting, upstream_status and redaction.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UpstreamHub, parseUpstreamConfig, type UpstreamAuthFrame, type UpstreamConfig } from '../../src/mcp/upstream.js';
import { OAuthStore, SIGN_IN_TTL_MS } from '../../src/mcp/oauth.js';
import { startFakeOAuth, type FakeOAuth } from './fixtures/oauth-server.js';

const REDIRECT = 'https://app.example/ai-bridge/upstream-oauth/callback';

let fake: FakeOAuth;
let dir: string;
let hub: UpstreamHub | null = null;
let frames: UpstreamAuthFrame[];
let statuses: number;
let toolsChanged: number;

beforeEach(async () => {
  fake = await startFakeOAuth();
  dir = mkdtempSync(join(tmpdir(), 'aib-oauth-'));
  frames = [];
  statuses = 0;
  toolsChanged = 0;
});

afterEach(async () => {
  await hub?.close();
  hub = null;
  await fake.close();
  rmSync(dir, { recursive: true, force: true });
});

async function until<T>(fn: () => T | undefined | false | null, what: string, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(frames)}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

function make(cfg: Partial<UpstreamConfig> = {}, extra: Record<string, UpstreamConfig> = {}): UpstreamHub {
  hub = new UpstreamHub({ kz: { url: fake.url, auth: 'oauth', ...cfg } as UpstreamConfig, ...extra }, {
    oauthDir: join(dir, 'mcp-oauth'),
    sendAuthFrame: (f) => frames.push(f),
    onStatusChanged: () => { statuses += 1; },
    onToolsChanged: () => { toolsChanged += 1; },
  });
  return hub;
}

const required = (n = 1) => until(() => frames.filter((f) => f.type === 'upstream_auth_required').length >= n && frames.filter((f) => f.type === 'upstream_auth_required')[n - 1], 'upstream_auth_required') as Promise<Extract<UpstreamAuthFrame, { type: 'upstream_auth_required' }>>;
const result = (n = 1) => until(() => frames.filter((f) => f.type === 'upstream_auth_result').length >= n && frames.filter((f) => f.type === 'upstream_auth_result')[n - 1], 'upstream_auth_result') as Promise<Extract<UpstreamAuthFrame, { type: 'upstream_auth_result' }>>;
const entry = (h: UpstreamHub, name = 'kz') => h.upstreamStatus().find((e) => e.server === name)!;

/** Start, take the link, approve it, hand the code back: a connected upstream. */
async function signedIn(cfg: Partial<UpstreamConfig> = {}): Promise<UpstreamHub> {
  const h = make(cfg);
  await h.start();
  h.serverConnected(REDIRECT);
  const req = await required();
  const { code, state } = fake.approve(req.authorization_url);
  await h.authCode('kz', state, { code });
  await until(() => entry(h).state === 'connected', 'connected');
  return h;
}

// ---------------------------------------------------------------------------

describe('config', () => {
  it('accepts auth oauth with an optional oauth object', () => {
    expect(parseUpstreamConfig({ mcpServers: { kz: { url: 'https://k/mcp', auth: 'oauth' } } })).toEqual({ kz: { url: 'https://k/mcp', auth: 'oauth' } });
    expect(parseUpstreamConfig({ kz: { url: 'https://k/mcp', auth: 'oauth', oauth: { scope: 'mcp:use', client_name: 'Mine' } } }))
      .toEqual({ kz: { url: 'https://k/mcp', auth: 'oauth', oauth: { scope: 'mcp:use', client_name: 'Mine' } } });
  });

  it.each([
    [{ kz: { command: 'x', auth: 'oauth' } }, /needs "url"/],
    [{ kz: { url: 'https://k/mcp', auth: 'basic' } }, /auth must be "oauth"/],
    [{ kz: { url: 'https://k/mcp', auth: 'oauth', headers: { authorization: { env: 'T' } } } }, /Authorization header/],
    [{ kz: { url: 'https://k/mcp', auth: 'oauth', oauth: { scope: 'a', client_secret: 'x' } } }, /only "scope" and "client_name"/],
    [{ kz: { url: 'https://k/mcp', auth: 'oauth', oauth: { scope: 3 } } }, /oauth.scope must be/],
    [{ kz: { url: 'https://k/mcp', auth: 'oauth', oauth: [] } }, /oauth must be an object/],
    [{ kz: { url: 'https://k/mcp', oauth: { scope: 'a' } } }, /needs "auth": "oauth"/],
  ])('refuses %j', (doc, msg) => {
    expect(() => parseUpstreamConfig(doc)).toThrow(msg);
  });
});

describe('sign-in', () => {
  it('discovers, registers a public client and sends upstream_auth_required once the server connection is up', async () => {
    const h = make({ oauth: { client_name: 'Test Bridge' } });
    await h.start();
    // Before welcome: needs_auth, nothing sent, nothing offered.
    expect(entry(h)).toMatchObject({ state: 'needs_auth', auth: 'oauth', tools: 0, error: 'no_token' });
    expect(frames).toEqual([]);
    expect(fake.bearers[0]).toBeNull(); // the first request went without a token

    h.serverConnected(REDIRECT);
    const req = await required();
    expect(req).toMatchObject({ server: 'kz', reason: 'no_token' });
    expect(req.state).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(Date.parse(req.expires_at) - Date.now()).toBeGreaterThan(SIGN_IN_TTL_MS - 5000);
    expect(req.expires_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    const u = new URL(req.authorization_url);
    expect(u.origin + u.pathname).toBe(`${fake.base}/oauth/authorize`);
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      response_type: 'code', redirect_uri: REDIRECT, code_challenge_method: 'S256', state: req.state,
      resource: fake.url, scope: 'mcp:use',
    });
    expect(fake.registrations).toEqual([{
      redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      token_endpoint_auth_method: 'none', client_name: 'Test Bridge', scope: 'mcp:use',
    }]);
    // Once per server connection.
    await new Promise((r) => setTimeout(r, 100));
    expect(frames.filter((f) => f.type === 'upstream_auth_required')).toHaveLength(1);
  });

  it('exchanges the code, connects, lists the tools and reports connected', async () => {
    const h = make();
    await h.start();
    h.serverConnected(REDIRECT);
    const req = await required();
    const { code, state } = fake.approve(req.authorization_url);
    const before = toolsChanged;
    await h.authCode('kz', state, { code });
    expect(frames.at(-1)).toEqual({ type: 'upstream_auth_result', server: 'kz', state, ok: true });
    await until(() => entry(h).state === 'connected', 'connected');
    expect(entry(h)).toEqual({ server: 'kz', transport: 'http', origin: fake.base, auth: 'oauth', state: 'connected', tools: 2, error: null });
    expect(h.definitions().map((d) => d.name)).toEqual(['kz__plain', 'kz__echo_token']);
    expect(toolsChanged).toBeGreaterThan(before);
    expect((await h.callFromModel('kz__plain', {})).text).toBe('plain ok');
    expect(fake.bearers.at(-1)).toBe(fake.issued[0]);
    expect(fake.tokenRequests[0]).toMatchObject({ grant_type: 'authorization_code', redirect_uri: REDIRECT, resource: fake.url });
  });

  it('keeps tokens and the registration in mcp-oauth/, 0700 and 0600, and uses them after a restart', async () => {
    await signedIn();
    const d = join(dir, 'mcp-oauth');
    expect(statSync(d).mode & 0o777).toBe(0o700);
    const files = readdirSync(d);
    expect(files.filter((f) => f.startsWith('tokens-'))).toHaveLength(1);
    expect(files.filter((f) => f.startsWith('client-'))).toHaveLength(1);
    for (const f of files) expect(statSync(join(d, f)).mode & 0o777).toBe(0o600);
    expect(new OAuthStore(d).readTokens(fake.url)?.access_token).toBe(fake.issued[0]);

    await hub!.close();
    frames = [];
    const h2 = make();
    await h2.start();
    h2.serverConnected(REDIRECT);
    expect(entry(h2).state).toBe('connected');
    await new Promise((r) => setTimeout(r, 50));
    expect(frames).toEqual([]);
    expect(fake.registrations).toHaveLength(1);
  });

  it('registers once per redirect: a second web application gets its own client', async () => {
    const h = make();
    await h.start();
    h.serverConnected(REDIRECT);
    await required();
    h.serverDisconnected();
    h.serverConnected('https://other.example/cb');
    await required(2);
    expect(fake.registrations.map((r) => r['redirect_uris'])).toEqual([[REDIRECT], ['https://other.example/cb']]);
    h.serverConnected(REDIRECT);
    await required(3);
    expect(fake.registrations).toHaveLength(2);
  });

  it('answers unknown_state for a used, a superseded and an expired state, and for garbage', async () => {
    const h = make();
    await h.start();
    h.serverConnected(REDIRECT);
    const first = await required();
    await h.authStart('kz');
    const second = await required(2);
    expect(second.reason).toBe('requested');
    expect(second.state).not.toBe(first.state);

    // Superseded.
    await h.authCode('kz', first.state, { code: fake.approve(first.authorization_url).code });
    expect(await result(1)).toMatchObject({ ok: false, code: 'unknown_state', state: first.state });
    // Garbage, and a missing state.
    await h.authCode('kz', 'nope', { code: 'x' });
    expect(await result(2)).toMatchObject({ ok: false, code: 'unknown_state' });
    await h.authCode('kz', undefined, { code: 'x' });
    expect(await result(3)).toMatchObject({ ok: false, code: 'unknown_state', state: null });
    // The current one still works, once.
    const { code } = fake.approve(second.authorization_url);
    await h.authCode('kz', second.state, { code });
    expect(await result(4)).toMatchObject({ ok: true });
    await h.authCode('kz', second.state, { code });
    expect(await result(5)).toMatchObject({ ok: false, code: 'unknown_state' });
    expect(fake.tokenRequests.filter((r) => r['grant_type'] === 'authorization_code')).toHaveLength(1);
  });

  it('expires a state after ten minutes', async () => {
    const h = make();
    await h.start();
    h.serverConnected(REDIRECT);
    const req = await required();
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + SIGN_IN_TTL_MS + 1000;
      await h.authCode('kz', req.state, { code: 'whatever' });
    } finally {
      Date.now = realNow;
    }
    expect(await result()).toMatchObject({ ok: false, code: 'unknown_state' });
    expect(entry(h).state).toBe('needs_auth');
  });

  it('reports denied when the person refuses, and stays needs_auth', async () => {
    const h = make();
    await h.start();
    h.serverConnected(REDIRECT);
    const req = await required();
    await h.authCode('kz', req.state, { error: 'access_denied', error_description: 'The user denied the request' });
    expect(await result()).toMatchObject({ ok: false, code: 'denied', state: req.state, error: expect.stringContaining('denied the request') });
    expect(entry(h)).toMatchObject({ state: 'needs_auth', error: 'denied' });
    // The state is used up.
    await h.authCode('kz', req.state, { code: 'x' });
    expect(await result(2)).toMatchObject({ code: 'unknown_state' });
  });

  it('reports exchange_failed when the token endpoint refuses the code', async () => {
    const h = make();
    await h.start();
    h.serverConnected(REDIRECT);
    const req = await required();
    fake.knobs.failExchange = true;
    await h.authCode('kz', req.state, { code: fake.approve(req.authorization_url).code });
    expect(await result()).toMatchObject({ ok: false, code: 'exchange_failed' });
    expect(entry(h).state).toBe('needs_auth');
  });

  it('checks iss when the metadata says the server sends it', async () => {
    fake.knobs.issParam = true;
    const h = make();
    await h.start();
    h.serverConnected(REDIRECT);
    let req = await required();
    await h.authCode('kz', req.state, { code: fake.approve(req.authorization_url).code });
    expect(await result(1)).toMatchObject({ ok: false, code: 'issuer_mismatch' }); // missing
    await h.authStart('kz');
    req = await required(2);
    await h.authCode('kz', req.state, { code: fake.approve(req.authorization_url).code, iss: 'https://evil.example' });
    expect(await result(2)).toMatchObject({ ok: false, code: 'issuer_mismatch' });
    await h.authStart('kz');
    req = await required(3);
    await h.authCode('kz', req.state, { code: fake.approve(req.authorization_url).code, iss: fake.base });
    expect(await result(3)).toMatchObject({ ok: true });
  });

  it('reports discovery_failed and registration_failed as upstream_auth_result, not a link', async () => {
    fake.knobs.noMetadata = true;
    const h = make();
    await h.start();
    h.serverConnected(REDIRECT);
    expect(await result(1)).toMatchObject({ server: 'kz', state: null, ok: false, code: 'discovery_failed' });
    expect(entry(h)).toMatchObject({ state: 'needs_auth', error: 'discovery_failed' });
    fake.knobs.noMetadata = false;
    fake.knobs.noRegistration = true;
    await h.authStart('kz');
    expect(await result(2)).toMatchObject({ ok: false, code: 'registration_failed' });
    expect(frames.some((f) => f.type === 'upstream_auth_required')).toBe(false);
  });

  it('without a redirect_uri: needs_auth with no_redirect_uri, no link; upstream_auth_start answers no_redirect_uri', async () => {
    const h = make();
    await h.start();
    h.serverConnected(null);
    expect(entry(h)).toMatchObject({ state: 'needs_auth', error: 'no_redirect_uri' });
    await new Promise((r) => setTimeout(r, 50));
    expect(frames).toEqual([]);
    await h.authStart('kz');
    expect(frames).toEqual([{ type: 'upstream_auth_result', server: 'kz', state: null, ok: false, code: 'no_redirect_uri', error: expect.any(String) }]);
    expect(h.signInNeeded('kz__plain')).toMatch(/cannot offer one/);
  });

  it('answers unknown_server and not_oauth', async () => {
    const h = make({}, { plain: { command: process.execPath, args: ['-e', 'setTimeout(()=>{}, 1e9)'], connect_timeout_ms: 300 } });
    h.serverConnected(REDIRECT);
    await h.authStart('nope');
    await h.authStart('plain');
    await h.authCode('nope', 's', { code: 'c' });
    await h.authCode('plain', 's', { code: 'c' });
    const codes = frames.filter((f) => f.type === 'upstream_auth_result').map((f) => (f as { code: string }).code);
    expect(codes).toEqual(['unknown_server', 'not_oauth', 'unknown_server', 'not_oauth']);
  });
});

describe('while needs_auth', () => {
  it('offers no tools, refuses a call by name with a sign-in message, and answers mcp requests unavailable', async () => {
    const h = make();
    await h.start();
    expect(h.definitions()).toEqual([]);
    expect(h.owns('kz__plain')).toBe(false);
    expect(h.signInNeeded('kz__plain')).toMatch(/needs the person to sign in/);
    expect(h.signInNeeded('other__plain')).toBeNull();
    await expect(h.request('kz', 'tools/call', { name: 'plain' })).rejects.toMatchObject({ code: 'unavailable', message: expect.stringMatching(/sign in/) });
  });
});

describe('refresh', () => {
  it('refreshes before expiry and keeps working', async () => {
    fake.knobs.expiresIn = 30; // inside the one-minute margin: refreshed on the next request
    const h = await signedIn();
    expect((await h.callFromModel('kz__plain', {})).text).toBe('plain ok');
    expect(fake.tokenRequests.some((r) => r['grant_type'] === 'refresh_token')).toBe(true);
    expect(fake.bearers.at(-1)).toBe(fake.issued.at(-1));
    expect(entry(h).state).toBe('connected');
  });

  it('refreshes once on a 401 and retries the request', async () => {
    const h = await signedIn();
    fake.expireAccessTokens();
    expect((await h.callFromModel('kz__plain', {})).text).toBe('plain ok');
    expect(fake.tokenRequests.filter((r) => r['grant_type'] === 'refresh_token')).toHaveLength(1);
    expect(fake.issued).toHaveLength(2);
    expect(new OAuthStore(join(dir, 'mcp-oauth')).readTokens(fake.url)?.access_token).toBe(fake.issued[1]);
  });

  it('goes to needs_auth and sends refresh_failed when the refresh is refused', async () => {
    const h = await signedIn();
    fake.expireAccessTokens();
    fake.knobs.failRefresh = true;
    const before = toolsChanged;
    await expect(h.callFromModel('kz__plain', {})).rejects.toMatchObject({ code: 'unavailable' });
    expect(entry(h)).toMatchObject({ state: 'needs_auth', tools: 0, error: 'refresh_failed' });
    expect((await required(2)).reason).toBe('refresh_failed');
    expect(h.definitions()).toEqual([]);
    expect(toolsChanged).toBeGreaterThan(before);
    // The dead tokens are gone from disk.
    expect(new OAuthStore(join(dir, 'mcp-oauth')).readTokens(fake.url)).toBeNull();
  });

  it('a 401 to a token that refreshed fine is rejected', async () => {
    const h = await signedIn();
    fake.knobs.rejectAll = true;
    await expect(h.callFromModel('kz__plain', {})).rejects.toMatchObject({ code: 'unavailable' });
    expect(entry(h)).toMatchObject({ state: 'needs_auth', error: 'rejected' });
    expect((await required(2)).reason).toBe('rejected');
  });
});

describe('upstream_auth_forget', () => {
  it('drops the tokens, goes to needs_auth, sends no link until upstream_auth_start', async () => {
    const h = await signedIn();
    const n = frames.length;
    await h.authForget('kz');
    expect(entry(h)).toMatchObject({ state: 'needs_auth', tools: 0 });
    expect(h.definitions()).toEqual([]);
    expect(new OAuthStore(join(dir, 'mcp-oauth')).readTokens(fake.url)).toBeNull();
    // The registration stays.
    expect(readdirSync(join(dir, 'mcp-oauth')).some((f) => f.startsWith('client-'))).toBe(true);
    h.serverDisconnected();
    h.serverConnected(REDIRECT);
    await new Promise((r) => setTimeout(r, 100));
    expect(frames.length).toBe(n);
    await h.authStart('kz');
    expect((await required(2)).reason).toBe('requested');
    expect(fake.registrations).toHaveLength(1);
  });

  it('ignores an unknown or non-OAuth server', async () => {
    const h = make();
    await h.authForget('nope');
    expect(frames).toEqual([]);
  });
});

describe('upstream_status', () => {
  it('lists every upstream with origin only, auth kind, and changes as state changes', async () => {
    const h = make({}, {
      st: { command: process.execPath, args: ['-e', 'process.exit(1)'], env: { X_TOKEN: { env: 'NOPE_NOT_SET' } } },
      web: { url: 'http://127.0.0.1:1/mcp?key=1', connect_timeout_ms: 500 },
    });
    await h.start();
    h.serverConnected(REDIRECT);
    expect(statuses).toBe(1);
    const list = h.upstreamStatus();
    expect(list.map((e) => e.server)).toEqual(['kz', 'st', 'web']);
    expect(list[0]).toMatchObject({ transport: 'http', origin: fake.base, auth: 'oauth', state: 'needs_auth' });
    expect(list[1]).toMatchObject({ transport: 'stdio', origin: null, auth: 'secrets', state: 'unavailable', tools: 0 });
    expect(list[2]).toMatchObject({ transport: 'http', origin: 'http://127.0.0.1:1', auth: 'none', state: 'unavailable' });
    expect(typeof list[2]!.error).toBe('string');
    // Signing in changes kz: a new upstream_status.
    const req = await required();
    const before = statuses;
    await h.authCode('kz', req.state, fake.approve(req.authorization_url));
    await until(() => statuses > before && entry(h).state === 'connected', 'status after sign-in');
  });
});

describe('redaction', () => {
  it('never lets a token out: tool text, host results, errors and the status', async () => {
    const h = await signedIn();
    const token = fake.issued[0]!;
    const text = (await h.callFromModel('kz__echo_token', {})).text;
    expect(text).not.toContain(token);
    expect(text).toContain('[redacted: kz.access_token]');
    const host = JSON.stringify(await h.request('kz', 'tools/call', { name: 'echo_token' }));
    // A view may call it only if app-visible (default model+app).
    expect(host).not.toContain(token);
    expect(JSON.stringify(h.upstreamStatus())).not.toContain(token);
    expect(JSON.stringify(frames)).not.toContain(token);
    // And nothing in a frame ever carries the refresh token or the code verifier.
    const stored = JSON.parse(readFileSync(join(dir, 'mcp-oauth', readdirSync(join(dir, 'mcp-oauth')).find((f) => f.startsWith('tokens-'))!), 'utf8')) as { refresh_token: string };
    expect(JSON.stringify(frames)).not.toContain(stored.refresh_token);
  });
});
