/**
 * Upstream sign-in (OAuth) through the whole Bridge: hello.mcp_upstream_auth,
 * welcome.upstream_oauth, upstream_status, upstream_auth_required -> code ->
 * result, what the CLI sees while a sign-in is needed, and that no token ever
 * reaches the server.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Bridge } from '../../src/bridge.js';
import { ProviderAdapter, type AdapterStreamEvent, type ExecutionContext } from '../../src/providers/base.js';
import type { ModelInfo } from '../../src/protocol/types.js';
import type { UpstreamConfig } from '../../src/mcp/upstream.js';
import { startFakeOAuth, type FakeOAuth } from '../mcp/fixtures/oauth-server.js';

const REDIRECT = 'https://app.example/ai-bridge/upstream-oauth/callback';

type Cli = (client: Client) => Promise<void>;

class CliAdapter extends ProviderAdapter {
  readonly providerName = 'fake';
  constructor(private readonly cli: Cli) { super(); }
  async execute(context: ExecutionContext, onEvent: (e: AdapterStreamEvent) => void): Promise<string | null> {
    if (!context.mcp) throw new Error('no MCP channel for the turn');
    const client = new Client({ name: 'fake-cli', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(context.mcp.url), {
      requestInit: { headers: { Authorization: `Bearer ${context.mcp.bearerToken}` } },
    }));
    try { await this.cli(client); } finally { await client.close(); }
    onEvent({ event: 'done', data: {} });
    return 'sess-1';
  }
  listModels(): Promise<ModelInfo[]> { return Promise.resolve([]); }
}

let wss: WebSocketServer;
let socket: WsSocket;
let frames: Record<string, unknown>[];
let bridge: Bridge | null = null;
let fake: FakeOAuth;
let dir: string;

async function waitFor(match: (f: Record<string, unknown>) => boolean, what: string, ms = 8000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = frames.find(match);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(frames).slice(0, 3000)}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(async () => {
  frames = [];
  fake = await startFakeOAuth();
  dir = mkdtempSync(join(tmpdir(), 'aib-oauth-bridge-'));
  wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  wss.on('connection', (ws) => {
    socket = ws;
    ws.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as Record<string, unknown>));
  });
});

afterEach(async () => {
  await bridge?.disconnect();
  bridge = null;
  await new Promise<void>((r) => wss.close(() => r()));
  await fake.close();
  rmSync(dir, { recursive: true, force: true });
});

async function start(opts: { upstreams?: Record<string, UpstreamConfig>; redirect?: string | null; cli?: Cli } = {}): Promise<void> {
  bridge = new Bridge({
    serverUrl: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/ws`,
    token: 'tok-1',
    providers: [],
    adapters: new Map([['fake', new CliAdapter(opts.cli ?? (async () => {})) as unknown as ProviderAdapter]]),
    sessionStorePath: null,
    allowedRoots: [{ path: tmpdir(), label: 'tmp' }],
    mcpOAuthDir: join(dir, 'mcp-oauth'),
    ...(opts.upstreams ? { mcpUpstreams: opts.upstreams } : {}),
  });
  bridge.connect();
  await waitFor((f) => f['type'] === 'hello', 'hello');
  // Let the upstream's first, tokenless request finish, so the order below is deterministic.
  if (opts.upstreams) await waitFor(() => fake.bearers.length > 0, 'first upstream request').catch(() => undefined);
  socket.send(JSON.stringify({
    type: 'welcome',
    session_id: 'conn-1',
    tools: [],
    config: { heartbeat_interval: 30, request_timeout: 30 },
    cli_isolation: 'workspace',
    ...(opts.redirect !== null ? { upstream_oauth: { redirect_uri: opts.redirect ?? REDIRECT } } : {}),
  }));
  await waitFor((f) => f['type'] === 'posture', 'posture');
}

function setCli(cli: Cli): void {
  (bridge as unknown as { adapters: Map<string, CliAdapter> }).adapters.set('fake', new CliAdapter(cli));
}

async function turn(id: string): Promise<void> {
  socket.send(JSON.stringify({
    type: 'ai_request', request_id: id, conversation_id: 'conv-1', provider: 'fake',
    message: 'go', system_prompt: null, options: {}, cli_session_id: null,
  }));
  await waitFor((f) => f['type'] === 'stream' && f['request_id'] === id && (f['event'] === 'done' || f['event'] === 'error'), 'end of turn', 15000);
}

const kz = (): Record<string, UpstreamConfig> => ({ kz: { url: fake.url, auth: 'oauth' } });
const statuses = () => frames.filter((f) => f['type'] === 'upstream_status') as { upstreams: Record<string, unknown>[] }[];

describe('handshake', () => {
  it('hello carries mcp_upstream_auth revision 1', async () => {
    await start();
    expect(frames.find((f) => f['type'] === 'hello')!['mcp_upstream_auth']).toEqual({ revision: 1 });
  });

  it('a bridge without upstreams answers upstream_auth_start with unknown_server', async () => {
    await start();
    socket.send(JSON.stringify({ type: 'upstream_auth_start', server: 'kz' }));
    expect(await waitFor((f) => f['type'] === 'upstream_auth_result', 'result')).toEqual({
      type: 'upstream_auth_result', server: 'kz', state: null, ok: false, code: 'unknown_server', error: expect.any(String),
    });
  });
});

describe('sign-in through the server', () => {
  it('status, link, code, result, connected: and the CLI then sees the tools', async () => {
    await start({ upstreams: kz() });
    const first = await waitFor((f) => f['type'] === 'upstream_status', 'upstream_status');
    expect(first['upstreams']).toEqual([{ server: 'kz', transport: 'http', origin: fake.base, auth: 'oauth', state: 'needs_auth', tools: 0, error: 'no_token' }]);
    const req = await waitFor((f) => f['type'] === 'upstream_auth_required', 'upstream_auth_required');
    expect(req).toMatchObject({ server: 'kz', reason: 'no_token', expires_at: expect.any(String) });

    // The person approves; the web application relays the redirect's parameters.
    const { code, state } = fake.approve(req['authorization_url'] as string);
    socket.send(JSON.stringify({ type: 'upstream_auth_code', server: 'kz', state, code, iss: fake.base }));
    expect(await waitFor((f) => f['type'] === 'upstream_auth_result', 'result')).toEqual({ type: 'upstream_auth_result', server: 'kz', state, ok: true });
    await waitFor(() => statuses().some((s) => s.upstreams[0]!['state'] === 'connected'), 'connected status');
    expect(statuses().at(-1)!.upstreams[0]).toMatchObject({ state: 'connected', tools: 2, error: null });

    let names: string[] = [];
    let text = '';
    setCli(async (client) => {
      names = (await client.listTools()).tools.map((t) => t.name);
      text = ((await client.callTool({ name: 'kz__echo_token', arguments: {} })) as { content: { text: string }[] }).content[0]!.text;
    });
    await turn('req_1');
    expect(names).toEqual(expect.arrayContaining(['kz__plain', 'kz__echo_token']));
    expect(text).toContain('[redacted: kz.access_token]');
    // No token ever went to the server, in any frame.
    const all = JSON.stringify(frames);
    for (const t of fake.issued) expect(all).not.toContain(t);
  });

  it('upstream_auth_forget: needs_auth, a new status, no link; upstream_auth_start brings one', async () => {
    await start({ upstreams: kz() });
    const req = await waitFor((f) => f['type'] === 'upstream_auth_required', 'link');
    const { code, state } = fake.approve(req['authorization_url'] as string);
    socket.send(JSON.stringify({ type: 'upstream_auth_code', server: 'kz', state, code }));
    await waitFor(() => statuses().some((s) => s.upstreams[0]!['state'] === 'connected'), 'connected');
    socket.send(JSON.stringify({ type: 'upstream_auth_forget', server: 'kz' }));
    await waitFor(() => statuses().at(-1)!.upstreams[0]!['state'] === 'needs_auth', 'needs_auth after forget');
    await new Promise((r) => setTimeout(r, 100));
    expect(frames.filter((f) => f['type'] === 'upstream_auth_required')).toHaveLength(1);
    socket.send(JSON.stringify({ type: 'upstream_auth_start', server: 'kz' }));
    await waitFor((f) => f['type'] === 'upstream_auth_required' && f['reason'] === 'requested', 'requested link');
  });
});

describe('a welcome without upstream_oauth', () => {
  it('reports no_redirect_uri, sends no link, and tells the CLI and the host a sign-in is needed', async () => {
    await start({ upstreams: kz(), redirect: null });
    await waitFor(() => statuses().length > 0, 'status');
    expect(statuses()[0]!.upstreams[0]).toMatchObject({ state: 'needs_auth', error: 'no_redirect_uri' });

    let names: string[] = [];
    let err = '';
    setCli(async (client) => {
      names = (await client.listTools()).tools.map((t) => t.name);
      const r = await client.callTool({ name: 'kz__plain', arguments: {} }) as { isError?: boolean; content: { text: string }[] };
      err = r.isError ? r.content[0]!.text : '';
    });
    await turn('req_2');
    expect(names).not.toContain('kz__plain');
    expect(err).toMatch(/needs a sign-in/);
    expect(frames.some((f) => f['type'] === 'tool_call')).toBe(false);

    socket.send(JSON.stringify({ type: 'mcp_request', id: 'm1', server: 'kz', method: 'tools/call', params: { name: 'plain' } }));
    expect(await waitFor((f) => f['type'] === 'mcp_result', 'mcp_result')).toMatchObject({ code: 'unavailable', error: expect.stringMatching(/sign-in/) });
    expect(frames.some((f) => f['type'] === 'upstream_auth_required')).toBe(false);
  });
});
