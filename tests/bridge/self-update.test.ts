/**
 * Self-update as the server sees it, over a real socket: the capability in
 * hello, the welcome's desired version reaching the updater, and "idle"
 * meaning no turn is running.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { Bridge } from '../../src/bridge.js';
import { ProviderAdapter, type AdapterStreamEvent, type ExecutionContext } from '../../src/providers/base.js';
import type { ModelInfo } from '../../src/protocol/types.js';

class Patient extends ProviderAdapter {
  readonly providerName = 'fake';
  execute(context: ExecutionContext, onEvent: (e: AdapterStreamEvent) => void): Promise<string | null> {
    onEvent({ event: 'block_start', data: { block_index: 0, block_type: 'text' } });
    return new Promise((resolve) => {
      context.signal.addEventListener('abort', () => { onEvent({ event: 'done', data: {} }); resolve('s'); }, { once: true });
    });
  }
  listModels(): Promise<ModelInfo[]> { return Promise.resolve([]); }
}

let wss: WebSocketServer;
let url: string;
let socket: WsSocket;
let frames: Record<string, unknown>[];
let bridge: Bridge | null = null;

async function waitFor(match: (f: Record<string, unknown>) => boolean, what: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 4000;
  for (;;) {
    const found = frames.find(match);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function start(selfUpdate?: { enabled: boolean; onDesired: (v: unknown) => void }): void {
  bridge = new Bridge({
    serverUrl: url,
    token: 'tok',
    providers: [{ name: 'fake', version: '1', available: true, supports_streaming: true, supports_tools: true, supports_thinking: false, supports_session_resume: true }],
    adapters: new Map([['fake', new Patient() as unknown as ProviderAdapter]]),
    sessionStorePath: null,
    allowedRoots: [],
    ...(selfUpdate ? { selfUpdate } : {}),
  });
  bridge.connect();
}

const welcome = (extra: Record<string, unknown> = {}) => JSON.stringify({
  type: 'welcome', session_id: 'c1', tools: [],
  config: { heartbeat_interval: 30, request_timeout: 0, silence_timeout: 0 },
  cli_isolation: 'workspace', ...extra,
});

beforeEach(async () => {
  frames = [];
  wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((r) => wss.once('listening', r));
  url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/ws`;
  wss.once('connection', (ws) => {
    socket = ws;
    ws.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as Record<string, unknown>));
  });
});

afterEach(async () => {
  await bridge?.disconnect();
  bridge = null;
  await new Promise<void>((r) => wss.close(() => r()));
});

describe('self-update over the wire', () => {
  it('hello says self_update: true only when the updater says it will follow', async () => {
    start({ enabled: true, onDesired: () => {} });
    expect((await waitFor((f) => f['type'] === 'hello', 'hello'))['self_update']).toBe(true);
  });

  it('hello announces effort_levels, the values options.effort takes', async () => {
    start();
    expect((await waitFor((f) => f['type'] === 'hello', 'hello'))['effort_levels'])
      .toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('hello says self_update: false for a bridge that will not', async () => {
    start({ enabled: false, onDesired: () => {} });
    expect((await waitFor((f) => f['type'] === 'hello', 'hello'))['self_update']).toBe(false);
  });

  it('every welcome hands its desired version over, and undefined when it has none', async () => {
    const seen: unknown[] = [];
    start({ enabled: true, onDesired: (v) => seen.push(v) });
    await waitFor((f) => f['type'] === 'hello', 'hello');
    socket.send(welcome({ desired_bridge_version: '0.25.0' }));
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual(['0.25.0']);
  });

  it('a welcome without the field still works, as from an older server', async () => {
    const seen: unknown[] = [];
    start({ enabled: true, onDesired: (v) => seen.push(v) });
    await waitFor((f) => f['type'] === 'hello', 'hello');
    socket.send(welcome());
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual([undefined]);
    expect(bridge!.isConnected()).toBe(true);
  });

  it('is not idle while a turn runs, and idle again once it has stopped', async () => {
    start({ enabled: true, onDesired: () => {} });
    await waitFor((f) => f['type'] === 'hello', 'hello');
    socket.send(welcome());
    await new Promise((r) => setTimeout(r, 50));
    expect(bridge!.isIdle()).toBe(true);
    socket.send(JSON.stringify({
      type: 'ai_request', request_id: 'r1', conversation_id: 'c', provider: 'fake',
      message: 'hi', system_prompt: null, options: {}, cli_session_id: null,
    }));
    await waitFor((f) => f['type'] === 'stream' && f['event'] === 'block_start', 'the turn starting');
    expect(bridge!.isIdle()).toBe(false);
    socket.send(JSON.stringify({ type: 'cancel', request_id: 'r1' }));
    await waitFor((f) => f['type'] === 'cancelled' || (f['type'] === 'stream' && f['event'] === 'done'), 'the turn stopping');
    const deadline = Date.now() + 2000;
    while (!bridge!.isIdle() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(bridge!.isIdle()).toBe(true);
  });
});
