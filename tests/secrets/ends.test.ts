/**
 * Secrets with an end (machine_secrets revision 3): `expire` removes the value
 * and keeps the name, `delete` removes both, enforced by a sweep before every
 * read; ended records kept 30 days, at most 100.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ENDED_KEEP_MAX, MachineSecretStore, SecretRefusal, checkEnd, defaultSecretsDir, formatEnd, type EndedRecord,
} from '../../src/secrets/store.js';

const VALUE = 'sk-test-0123456789-very-secret';
const START = new Date('2026-11-24T12:00:00Z');

let home: string;
let dir: string;
let clock: Date;
let ended: EndedRecord[];
let store: MachineSecretStore;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'secret-ends-'));
  dir = defaultSecretsDir(home);
  clock = new Date(START);
  ended = [];
  store = new MachineSecretStore(dir, { now: () => new Date(clock), onEnd: (r) => ended.push(r) });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const later = (ms: number): string => formatEnd(new Date(START.getTime() + ms));
const HOUR = 3_600_000;

function advance(ms: number): void {
  clock = new Date(clock.getTime() + ms);
}

function index(): { secrets: Record<string, Record<string, unknown>>; ended?: EndedRecord[] } {
  return JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as never;
}

async function refusal(promise: Promise<unknown>): Promise<SecretRefusal> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(SecretRefusal);
    return err as SecretRefusal;
  }
  throw new Error('expected a refusal');
}

describe('checkEnd', () => {
  it('takes both fields or neither, a future UTC time in whole seconds, at most 10 years ahead', () => {
    expect(checkEnd(undefined, undefined, START)).toBeNull();
    expect(checkEnd(null, null, START)).toBeNull();
    expect(checkEnd(later(HOUR), 'delete', START)).toEqual({ ends_at: '2026-11-24T13:00:00Z', end_kind: 'delete' });
    expect(checkEnd('2036-11-24T12:00:00Z', 'expire', START)).not.toBeNull();
    for (const [at, kind] of [
      [later(HOUR), undefined], [undefined, 'expire'], [later(HOUR), 'forget'],
      ['2026-11-24T13:00:00.000Z', 'expire'], ['2026-11-24T13:00:00+01:00', 'expire'], ['2027-02-30T00:00:00Z', 'expire'],
      ['2026-11-24T12:00:00Z', 'expire'], ['2026-11-24T11:00:00Z', 'expire'], ['2036-11-24T12:00:01Z', 'expire'], [42, 'expire'],
    ] as const) {
      expect(() => checkEnd(at, kind, START), `${String(at)} ${String(kind)}`).toThrow(SecretRefusal);
      try { checkEnd(at, kind, START); } catch (err) { expect((err as SecretRefusal).code).toBe('invalid_end'); }
    }
  });
});

describe('an end that expires', () => {
  it('removes the value at the end and keeps the name, listed with expired_at equal to ends_at', async () => {
    await store.put('openai-key', VALUE, { description: 'OpenAI', endsAt: later(HOUR), endKind: 'expire' });
    expect(await store.list()).toEqual([{
      name: 'openai-key', description: 'OpenAI', updated_at: expect.any(String),
      ends_at: '2026-11-24T13:00:00Z', end_kind: 'expire', expired_at: null,
    }]);
    advance(2 * HOUR);
    const { secrets, ended: records } = await store.listWithEnded();
    expect(secrets).toMatchObject([{ name: 'openai-key', description: 'OpenAI', expired_at: '2026-11-24T13:00:00Z' }]);
    expect(records).toEqual([{ name: 'openai-key', kind: 'expire', ended_at: '2026-11-24T13:00:00Z' }]);
    expect(existsSync(join(dir, 'openai-key'))).toBe(false);
    expect(ended).toEqual(records);
    expect(readFileSync(join(dir, 'index.json'), 'utf8')).not.toContain(VALUE);
  });

  it('ends exactly at the moment, not a second before', async () => {
    await store.put('k', VALUE, { endsAt: later(HOUR), endKind: 'expire' });
    advance(HOUR - 1000);
    expect(await store.path('k')).toBe(join(dir, 'k'));
    advance(1000);
    expect((await refusal(store.path('k'))).code).toBe('expired');
  });

  it('refuses path and read after the end with code expired and the message for the person', async () => {
    await store.put('k', VALUE, { endsAt: later(HOUR), endKind: 'expire' });
    advance(HOUR);
    const err = await refusal(store.read('k'));
    expect(err.code).toBe('expired');
    expect(err.message).toBe('The secret "k" expired at 2026-11-24T13:00:00Z and can no longer be used. Ask the person to renew it with the secret card.');
  });

  it('counts as existing: has is true, a put without replace is refused, a replace renews it with the new end or none', async () => {
    await store.put('k', VALUE, { description: 'kept', endsAt: later(HOUR), endKind: 'expire' });
    advance(HOUR);
    expect(await store.has('k')).toBe(true);
    expect((await refusal(store.put('k', 'new-value-1'))).code).toBe('exists');
    expect(await store.put('k', 'new-value-1', { replace: true })).toEqual({ replaced: true });
    expect(await store.list()).toMatchObject([{ name: 'k', description: 'kept', ends_at: null, end_kind: null, expired_at: null }]);
    expect(readFileSync(await store.path('k'), 'utf8')).toBe('new-value-1');
    expect(await store.put('k', 'new-value-2', { replace: true, endsAt: later(3 * HOUR), endKind: 'delete' })).toEqual({ replaced: true });
    expect((await store.list())[0]).toMatchObject({ ends_at: '2026-11-24T15:00:00Z', end_kind: 'delete' });
  });

  it('a replace without an end clears the old end', async () => {
    await store.put('k', VALUE, { endsAt: later(HOUR), endKind: 'expire' });
    await store.put('k', 'other-value', { replace: true });
    advance(2 * HOUR);
    expect(await store.path('k')).toBe(join(dir, 'k'));
  });

  it('can still be described and removed', async () => {
    await store.put('k', VALUE, { endsAt: later(HOUR), endKind: 'expire' });
    advance(HOUR);
    await store.describe('k', 'renew me');
    expect((await store.list())[0]).toMatchObject({ description: 'renew me', expired_at: '2026-11-24T13:00:00Z' });
    await store.remove('k');
    expect(await store.list()).toEqual([]);
    expect(index().secrets).toEqual({});
  });
});

describe('an end that deletes', () => {
  it('removes the file and the entry, leaving only the ended record', async () => {
    await store.put('rpa-pass', VALUE, { endsAt: later(HOUR), endKind: 'delete' });
    advance(HOUR);
    expect(await store.has('rpa-pass')).toBe(false);
    expect(existsSync(join(dir, 'rpa-pass'))).toBe(false);
    expect(index().secrets).toEqual({});
    expect(await store.listWithEnded()).toEqual({ secrets: [], ended: [{ name: 'rpa-pass', kind: 'delete', ended_at: '2026-11-24T13:00:00Z' }] });
    expect((await refusal(store.path('rpa-pass'))).code).toBe('not_found');
  });
});

describe('the sweep', () => {
  it('runs before each read: list, has, path (and so run), and before every write', async () => {
    for (const read of [
      () => store.list(),
      () => store.has('k'),
      () => store.path('k').catch(() => undefined),
      () => store.put('other', VALUE, { replace: true }),
      () => store.describe('other', 'x'),
    ]) {
      await store.put('k', VALUE, { replace: true, endsAt: formatEnd(new Date(clock.getTime() + HOUR)), endKind: 'delete' });
      advance(HOUR);
      await read();
      expect(existsSync(join(dir, 'k')), String(read)).toBe(false);
    }
  });

  it('handles an end that passed while nothing ran, once', async () => {
    await store.put('k', VALUE, { endsAt: later(HOUR), endKind: 'expire' });
    advance(24 * HOUR);
    // A new process: the bridge starting, or `aib secret` run the next day.
    const fresh = new MachineSecretStore(dir, { now: () => new Date(clock) });
    expect(await fresh.sweep()).toEqual([{ name: 'k', kind: 'expire', ended_at: '2026-11-24T13:00:00Z' }]);
    expect(await fresh.sweep()).toEqual([]);
    expect(index().ended).toHaveLength(1);
  });

  it('drops the entry of a file removed by hand instead of reporting an end', async () => {
    await store.put('k', VALUE, { endsAt: later(HOUR), endKind: 'expire' });
    rmSync(join(dir, 'k'));
    advance(HOUR);
    expect(await store.listWithEnded()).toEqual({ secrets: [], ended: [] });
    expect(index().secrets).toEqual({});
  });

  it('keeps ended records 30 days and at most 100', async () => {
    const old = Array.from({ length: 120 }, (_, i) => ({ name: `s${i}`, kind: 'delete', ended_at: formatEnd(new Date(START.getTime() - i * 60_000)) }));
    await store.put('k', VALUE, { endsAt: later(HOUR), endKind: 'delete' });
    const file = index();
    writeFileSync(join(dir, 'index.json'), JSON.stringify({ ...file, ended: [
      { name: 'ancient', kind: 'expire', ended_at: '2026-10-01T00:00:00Z' }, ...old,
    ] }));
    advance(HOUR);
    const { ended: records } = await store.listWithEnded();
    expect(records).toHaveLength(ENDED_KEEP_MAX);
    expect(records.at(-1)).toEqual({ name: 'k', kind: 'delete', ended_at: '2026-11-24T13:00:00Z' });
    expect(records.map((r) => r.name)).not.toContain('ancient');
    expect(index().ended).toHaveLength(ENDED_KEEP_MAX);
    advance(31 * 24 * HOUR);
    expect((await store.listWithEnded()).ended).toEqual([]);
  });
});

describe('setEnd', () => {
  it('sets, changes and removes an end without touching the value or the description', async () => {
    await store.put('k', VALUE, { description: 'd' });
    await store.setEnd('k', later(HOUR), 'delete');
    expect((await store.list())[0]).toMatchObject({ description: 'd', ends_at: '2026-11-24T13:00:00Z', end_kind: 'delete' });
    await store.setEnd('k', later(2 * HOUR), 'expire');
    expect((await store.list())[0]).toMatchObject({ ends_at: '2026-11-24T14:00:00Z', end_kind: 'expire' });
    await store.setEnd('k', null);
    expect((await store.list())[0]).toMatchObject({ description: 'd', ends_at: null, end_kind: null });
    advance(3 * HOUR);
    expect(readFileSync(await store.path('k'), 'utf8')).toBe(VALUE);
  });

  it('refuses not_found, ended, an invalid end and a missing ends_at', async () => {
    expect((await refusal(store.setEnd('nope', later(HOUR), 'expire'))).code).toBe('not_found');
    await store.put('k', VALUE, { endsAt: later(HOUR), endKind: 'expire' });
    expect((await refusal(store.setEnd('nope', later(HOUR), 'expire'))).code).toBe('not_found');
    expect((await refusal(store.setEnd('k', later(-HOUR), 'expire'))).code).toBe('invalid_end');
    expect((await refusal(store.setEnd('k', later(HOUR), undefined))).code).toBe('invalid_end');
    expect((await refusal(store.setEnd('k', undefined))).code).toBe('invalid_end');
    advance(HOUR);
    expect((await refusal(store.setEnd('k', null))).code).toBe('ended');
    expect((await refusal(store.setEnd('k', later(5 * HOUR), 'expire'))).code).toBe('ended');
  });

  it('refuses an end the put would set when it is invalid, before anything is written', async () => {
    expect((await refusal(store.put('k', VALUE, { endsAt: later(HOUR) }))).code).toBe('invalid_end');
    expect((await refusal(store.put('k', VALUE, { endsAt: later(-1000), endKind: 'expire' }))).code).toBe('invalid_end');
    expect(existsSync(join(dir, 'k'))).toBe(false);
  });
});
