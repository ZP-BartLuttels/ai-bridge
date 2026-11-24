/**
 * Machine secrets over a real WebSocket (decision 0020): off unless the
 * operator passed --machine-secrets, and then one `secret_result` per frame
 * from the built-in store, never carrying a value, with the value nowhere in
 * the bridge's log.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { Bridge } from '../../src/bridge.js';
import { closeLogFile, setLogFile } from '../../src/utils/logger.js';

const VALUE = 'pw-0123456789-do-not-log';

let wss: WebSocketServer | null = null;
let socket: WsSocket;
let frames: Record<string, unknown>[];
let bridge: Bridge | null = null;
let home: string | null = null;
let logDir: string | null = null;

async function waitFor(match: (f: Record<string, unknown>) => boolean, what: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 8000;
  for (;;) {
    const found = frames.find(match);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; saw: ${JSON.stringify(frames).slice(0, 2000)}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function connect(machineSecrets = false, sweepMs?: number): Promise<Record<string, unknown>> {
  frames = [];
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  wss = server;
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
  server.once('connection', (ws) => {
    socket = ws;
    ws.on('message', (raw) => { frames.push(JSON.parse(raw.toString()) as Record<string, unknown>); });
  });
  bridge = new Bridge({
    serverUrl: url, token: 'tok', sessionStorePath: null, providers: [], adapters: new Map(),
    ...(machineSecrets ? { machineSecrets: true, secretsDir: secretsDir() } : {}),
    ...(sweepMs ? { secretsSweepMs: sweepMs } : {}),
  });
  bridge.connect();
  const hello = await waitFor((f) => f['type'] === 'hello', 'hello');
  socket.send(JSON.stringify({ type: 'welcome', session_id: 'conn-1', tools: [], config: { heartbeat_interval: 30, request_timeout: 30 } }));
  return hello;
}

function secretsDir(): string {
  home ??= mkdtempSync(join(tmpdir(), 'secrets-home-'));
  return join(home, '.ai-bridge', 'secrets');
}

async function ask(frame: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = `s_${Math.random().toString(36).slice(2, 8)}`;
  socket.send(JSON.stringify({ ...frame, id }));
  return waitFor((f) => f['type'] === 'secret_result' && f['id'] === id, `secret_result ${id}`);
}

afterEach(async () => {
  await bridge?.disconnect();
  bridge = null;
  if (wss) await new Promise<void>((resolve) => wss!.close(() => resolve()));
  wss = null;
  if (home) rmSync(home, { recursive: true, force: true });
  home = null;
  closeLogFile();
  if (logDir) rmSync(logDir, { recursive: true, force: true });
  logDir = null;
});

describe('a bridge without --machine-secrets', () => {
  it('does not announce machine_secrets, and does announce the 16 KB prompt cap', async () => {
    const hello = await connect();
    expect(hello).not.toHaveProperty('machine_secrets');
    expect(hello['bridge_prompt_max_bytes']).toBe(16384);
  });

  it('refuses every secret_* frame with machine_secrets_unsupported', async () => {
    await connect();
    for (const frame of [
      { type: 'secret_list' },
      { type: 'secret_put', name: 'k', value: VALUE },
      { type: 'secret_describe', name: 'k', description: 'd' },
      { type: 'secret_remove', name: 'k' },
    ]) {
      const result = await ask(frame);
      expect(result).toMatchObject({ ok: false, code: 'machine_secrets_unsupported' });
      expect(JSON.stringify(result)).not.toContain(VALUE);
    }
  });
});

describe('a bridge with --machine-secrets', () => {
  it('announces machine_secrets revision 3', async () => {
    const hello = await connect(true);
    expect(hello['machine_secrets']).toEqual({ revision: 3 });
  });

  it('puts, refuses a second put as exists, replaces, lists, describes and removes; the value is in no answer and no log line', async () => {
    logDir = mkdtempSync(join(tmpdir(), 'secrets-log-'));
    const logFile = join(logDir, 'bridge.log');
    setLogFile(logFile);
    await connect(true);

    expect(await ask({ type: 'secret_put', name: 'db_password', value: VALUE, description: 'Postgres' }))
      .toMatchObject({ ok: true, replaced: false });
    const file = join(secretsDir(), 'db_password');
    expect(readFileSync(file, 'utf8')).toBe(VALUE);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(secretsDir()).mode & 0o777).toBe(0o700);
    expect(await ask({ type: 'secret_put', name: 'db_password', value: 'other' }))
      .toMatchObject({ ok: false, code: 'exists' });
    expect(await ask({ type: 'secret_put', name: 'db_password', value: VALUE, replace: true }))
      .toMatchObject({ ok: true, replaced: true });
    const listed = await ask({ type: 'secret_list' });
    expect(listed).toMatchObject({ ok: true, secrets: [{ name: 'db_password', description: 'Postgres' }] });
    expect(await ask({ type: 'secret_describe', name: 'db_password', description: 'Postgres, production' }))
      .toMatchObject({ ok: true });
    expect(await ask({ type: 'secret_list' }))
      .toMatchObject({ secrets: [{ name: 'db_password', description: 'Postgres, production' }] });
    expect(await ask({ type: 'secret_remove', name: 'db_password' })).toMatchObject({ ok: true });
    expect(await ask({ type: 'secret_remove', name: 'db_password' })).toMatchObject({ ok: false, code: 'not_found' });
    expect(await ask({ type: 'secret_put', name: '../etc', value: VALUE })).toMatchObject({ ok: false, code: 'invalid_name' });

    const answers = JSON.stringify(frames.filter((f) => f['type'] === 'secret_result'));
    expect(answers).not.toContain(VALUE);
    closeLogFile();
    const log = readFileSync(logFile, 'utf8');
    expect(log).toContain('Machine secret put');
    expect(log).not.toContain(VALUE);
  });
});

describe('secrets with an end (revision 3)', () => {
  const soon = (ms: number): string => `${new Date(Date.now() + ms).toISOString().slice(0, 19)}Z`;

  const PASSED = soon(-3_600_000);

  /** A secret whose end has already passed, written as an earlier run of the store would have left it. */
  function storeWithPassedEnd(kind: 'expire' | 'delete'): void {
    const dir = secretsDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'k'), VALUE, { mode: 0o600 });
    writeFileSync(join(dir, 'index.json'), JSON.stringify({ version: 1, secrets: {
      k: { description: 'd', updated_at: '2026-01-01T00:00:00.000Z', ends_at: PASSED, end_kind: kind },
    } }), { mode: 0o600 });
  }

  async function until(check: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 8000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it('puts with an end, sets and removes it, and lists the ends; refuses bad ends and an unknown name', async () => {
    await connect(true);
    expect(await ask({ type: 'secret_put', name: 'rpa-pass', value: VALUE, ends_at: soon(3_600_000), end_kind: 'delete' }))
      .toMatchObject({ ok: true, replaced: false });
    expect(await ask({ type: 'secret_put', name: 'openai-key', value: VALUE }))
      .toMatchObject({ ok: true });
    const listed = await ask({ type: 'secret_list' });
    expect(listed).toMatchObject({ ok: true, ended: [], secrets: [
      { name: 'openai-key', ends_at: null, end_kind: null, expired_at: null },
      { name: 'rpa-pass', ends_at: expect.stringMatching(/Z$/), end_kind: 'delete', expired_at: null },
    ] });
    const at = soon(7_200_000);
    expect(await ask({ type: 'secret_set_end', name: 'openai-key', ends_at: at, end_kind: 'expire' })).toEqual({ type: 'secret_result', id: expect.any(String), ok: true });
    expect(await ask({ type: 'secret_list' })).toMatchObject({ secrets: [{ name: 'openai-key', ends_at: at, end_kind: 'expire' }, { name: 'rpa-pass' }] });
    expect(await ask({ type: 'secret_set_end', name: 'openai-key', ends_at: null })).toMatchObject({ ok: true });
    expect(await ask({ type: 'secret_list' })).toMatchObject({ secrets: [{ name: 'openai-key', ends_at: null, end_kind: null }, { name: 'rpa-pass' }] });
    expect(await ask({ type: 'secret_set_end', name: 'nope', ends_at: null })).toMatchObject({ ok: false, code: 'not_found' });
    expect(await ask({ type: 'secret_set_end', name: 'openai-key', ends_at: '2020-01-01T00:00:00Z', end_kind: 'expire' }))
      .toMatchObject({ ok: false, code: 'invalid_end' });
    expect(await ask({ type: 'secret_put', name: 'x1', value: VALUE, ends_at: soon(60_000) }))
      .toMatchObject({ ok: false, code: 'invalid_end' });
    expect(JSON.stringify(frames)).not.toContain(VALUE);
  });

  it('sweeps at start an end that passed while the bridge was not running, logging name and kind only', async () => {
    logDir = mkdtempSync(join(tmpdir(), 'secrets-log-'));
    const logFile = join(logDir, 'bridge.log');
    setLogFile(logFile);
    storeWithPassedEnd('expire');
    await connect(true);
    await until(() => !existsSync(join(secretsDir(), 'k')), 'the sweep at start');
    expect(await ask({ type: 'secret_list' })).toMatchObject({
      ok: true,
      secrets: [{ name: 'k', description: 'd', ends_at: PASSED, end_kind: 'expire', expired_at: PASSED }],
      ended: [{ name: 'k', kind: 'expire', ended_at: PASSED }],
    });
    expect(await ask({ type: 'secret_set_end', name: 'k', ends_at: null })).toMatchObject({ ok: false, code: 'ended' });
    expect(await ask({ type: 'secret_put', name: 'k', value: VALUE, replace: true })).toMatchObject({ ok: true, replaced: true });
    expect(await ask({ type: 'secret_list' })).toMatchObject({ secrets: [{ name: 'k', expired_at: null, ends_at: null }] });
    closeLogFile();
    const log = readFileSync(logFile, 'utf8');
    expect(log).toMatch(/Machine secret ended.*"name":"k".*"kind":"expire"/);
    expect(log).not.toContain(VALUE);
  });

  it('sweeps on its timer while running, without any frame asking', async () => {
    await connect(true, 50);
    expect(await ask({ type: 'secret_put', name: 'k', value: VALUE, ends_at: soon(1500), end_kind: 'delete' })).toMatchObject({ ok: true });
    const readIndex = () => JSON.parse(readFileSync(join(secretsDir(), 'index.json'), 'utf8')) as { secrets: object; ended?: unknown[] };
    await until(() => readIndex().ended !== undefined, 'the timed sweep');
    const index = readIndex();
    expect(existsSync(join(secretsDir(), 'k'))).toBe(false);
    expect(index.secrets).toEqual({});
    expect(index.ended).toMatchObject([{ name: 'k', kind: 'delete' }]);
  });

  it('a bridge without --machine-secrets refuses secret_set_end too', async () => {
    await connect();
    expect(await ask({ type: 'secret_set_end', name: 'k', ends_at: null })).toMatchObject({ ok: false, code: 'machine_secrets_unsupported' });
  });
});

describe('a store that does not answer in time', () => {
  it('answers timeout, saying the result is unknown', async () => {
    const { MachineSecrets } = await import('../../src/secrets/frames.js');
    const { MachineSecretStore } = await import('../../src/secrets/store.js');
    const slow = new MachineSecretStore(secretsDir());
    slow.listWithEnded = () => new Promise(() => { /* never */ });
    const secrets = new MachineSecrets({ store: slow, timeoutMs: 50 });
    await expect(secrets.list()).rejects.toMatchObject({ code: 'timeout', message: expect.stringMatching(/unknown/) });
  });

  it('a refusal that would carry the value is scrubbed of it', async () => {
    const { MachineSecrets, SecretRefusal } = await import('../../src/secrets/frames.js');
    const { MachineSecretStore } = await import('../../src/secrets/store.js');
    const leaky = new MachineSecretStore(secretsDir());
    leaky.put = (_name, value) => Promise.reject(new SecretRefusal('failed', `boom ${String(value)}`));
    const secrets = new MachineSecrets({ store: leaky });
    const err = await secrets.put('k', VALUE).catch((e: Error) => e);
    expect(String((err as Error).message)).not.toContain(VALUE);
  });
});
