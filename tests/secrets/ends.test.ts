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
  ENDED_KEEP_MAX, INDEX_VERSION, MachineSecretStore, SecretRefusal, checkEnd, defaultSecretsDir, formatEnd, type EndedRecord,
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
      // Dates JavaScript cannot read at all: refused as invalid_end, never a raw RangeError.
      ['2026-13-01T00:00:00Z', 'expire'], ['2026-12-01T12:60:00Z', 'expire'], ['2026-12-01T24:00:00Z', 'expire'],
      ['2026-12-32T00:00:00Z', 'expire'], ['2026-12-01T12:00:60Z', 'expire'], ['0000-00-00T00:00:00Z', 'expire'],
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
    expect(err.message).toBe('The secret "k" expired at 2026-11-24T13:00:00Z and can no longer be used. Ask the person to renew it. On this machine: aib secret add k --replace with --ends-in, --ends-at or --no-end.');
  });

  it('says expired, not cannot be opened, when the file goes between the check and the open', async () => {
    await store.put('k', VALUE, { endsAt: later(HOUR), endKind: 'expire' });
    const path = store.path.bind(store);
    let calls = 0;
    // The first check passes; then the end passes and another process sweeps before the open.
    store.path = async (name: unknown) => {
      const p = await path(name);
      if (calls++ === 0) { advance(HOUR); await new MachineSecretStore(dir, { now: () => new Date(clock) }).sweep(); }
      return p;
    };
    expect((await refusal(store.read('k'))).code).toBe('expired');
  });

  it('counts as existing: has is true, a put without replace is refused, a replace renews it with the new end or none', async () => {
    await store.put('k', VALUE, { description: 'kept', endsAt: later(HOUR), endKind: 'expire' });
    advance(HOUR);
    expect(await store.has('k')).toBe(true);
    const taken = await refusal(store.put('k', 'new-value-1'));
    expect(taken.code).toBe('exists');
    expect(taken.message).toBe('"k" expired at 2026-11-24T13:00:00Z; replace it to renew it.');
    expect(await store.put('k', 'new-value-1', { replace: true, endsAt: null })).toEqual({ replaced: true });
    expect(await store.list()).toMatchObject([{ name: 'k', description: 'kept', ends_at: null, end_kind: null, expired_at: null }]);
    expect(readFileSync(await store.path('k'), 'utf8')).toBe('new-value-1');
    expect(await store.put('k', 'new-value-2', { replace: true, endsAt: later(3 * HOUR), endKind: 'delete' })).toEqual({ replaced: true });
    expect((await store.list())[0]).toMatchObject({ ends_at: '2026-11-24T15:00:00Z', end_kind: 'delete' });
  });

  it('a replace must state its end: without ends_at it is refused end_required and nothing changes; null clears the end', async () => {
    await store.put('k', VALUE, { description: 'd', endsAt: later(HOUR), endKind: 'delete' });
    const before = readFileSync(join(dir, 'index.json'), 'utf8');
    for (const options of [{ replace: true }, { replace: true, endKind: 'expire' }, { replace: true, endsAt: undefined }]) {
      const err = await refusal(store.put('k', 'other-value', options));
      expect(err.code).toBe('end_required');
      expect(err.message).toBe('Replacing a secret must state its end: ends_at with a time and end_kind, or ends_at null for no end. Nothing was changed.');
    }
    // Refused for a name that does not exist yet too: the rule is about the request, not the store.
    expect((await refusal(store.put('new', 'other-value', { replace: true }))).code).toBe('end_required');
    expect(existsSync(join(dir, 'new'))).toBe(false);
    expect(readFileSync(join(dir, 'k'), 'utf8')).toBe(VALUE);
    expect(readFileSync(join(dir, 'index.json'), 'utf8')).toBe(before);
    // A first put keeps ends_at optional.
    expect(await store.put('first', VALUE)).toEqual({ replaced: false });
    await store.put('k', 'other-value', { replace: true, endsAt: null });
    expect((await store.list()).find((r) => r.name === 'k')).toMatchObject({ description: 'd', ends_at: null, end_kind: null });
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
      () => store.put('other', VALUE, { replace: true, endsAt: null }),
      () => store.describe('other', 'x'),
      () => store.setEnd('other', null),
      () => store.remove('other').then(() => store.put('other', VALUE)),
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

  it('records the end before the value goes: an interrupted sweep keeps its record, and the next one removes the file', async () => {
    for (const kind of ['expire', 'delete'] as const) {
      await store.put(kind, VALUE, { endsAt: later(HOUR), endKind: kind });
    }
    advance(HOUR);
    // What an interrupted sweep leaves: the index already says ended, the files are still there.
    const file = index();
    for (const name of ['expire', 'delete']) file.secrets[name] = { ...file.secrets[name], expired_at: '2026-11-24T13:00:00Z' };
    writeFileSync(join(dir, 'index.json'), JSON.stringify({ ...file, ended: [
      { name: 'expire', kind: 'expire', ended_at: '2026-11-24T13:00:00Z' }, { name: 'delete', kind: 'delete', ended_at: '2026-11-24T13:00:00Z' },
    ] }));
    expect((await refusal(store.path('expire'))).code).toBe('expired');
    const { secrets, ended: records } = await store.listWithEnded();
    expect(secrets).toMatchObject([{ name: 'expire', expired_at: '2026-11-24T13:00:00Z' }]);
    expect(records.map((r) => r.name)).toEqual(['expire', 'delete']);
    expect(existsSync(join(dir, 'expire'))).toBe(false);
    expect(existsSync(join(dir, 'delete'))).toBe(false);
    expect(Object.keys(index().secrets)).toEqual(['expire']);
  });

  it('never leaves a new value without its end when the index cannot be written', async () => {
    await store.put('other', VALUE, { endsAt: later(HOUR), endKind: 'expire' });
    // The disk fills up between the value and the index.
    (store as unknown as { writeIndex: () => Promise<void> }).writeIndex = () => Promise.reject(new SecretRefusal('failed', 'disk full'));
    expect((await refusal(store.put('other', 'new-value-1', { replace: true, endsAt: null }))).code).toBe('failed');
    expect((await store.list())[0]).toMatchObject({ name: 'other', ends_at: '2026-11-24T13:00:00Z' });
    expect((await refusal(store.put('k', VALUE, { endsAt: later(HOUR), endKind: 'delete' }))).code).toBe('failed');
    expect(existsSync(join(dir, 'k'))).toBe(false);
  });

  it('counts only existing files and expired names as case twins, not a stale entry of a file removed by hand', async () => {
    await store.put('Foo', VALUE, { description: 'old' });
    rmSync(join(dir, 'Foo'));
    expect(await store.put('foo', VALUE)).toEqual({ replaced: false });
    await store.put('Bar', VALUE, { endsAt: later(HOUR), endKind: 'expire' });
    advance(HOUR);
    expect((await refusal(store.put('bar', VALUE))).message).toContain('only in case');
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
    const ended = await refusal(store.setEnd('k', later(5 * HOUR), 'expire'));
    expect(ended.code).toBe('ended');
    expect(ended.message).toContain('aib secret add k --replace');
  });

  it('refuses an end the put would set when it is invalid, before anything is written', async () => {
    expect((await refusal(store.put('k', VALUE, { endsAt: later(HOUR) }))).code).toBe('invalid_end');
    expect((await refusal(store.put('k', VALUE, { endsAt: later(-1000), endKind: 'expire' }))).code).toBe('invalid_end');
    expect(existsSync(join(dir, 'k'))).toBe(false);
  });
});

describe('adjustEnd', () => {
  it('changes the time or the kind and keeps the other as it is under the lock; refuses a kind alone without an end', async () => {
    await store.put('k', VALUE, { endsAt: later(HOUR), endKind: 'delete' });
    expect(await store.adjustEnd('k', { endsAt: later(2 * HOUR) })).toEqual({ ends_at: '2026-11-24T14:00:00Z', end_kind: 'delete' });
    expect(await store.adjustEnd('k', { endKind: 'expire' })).toEqual({ ends_at: '2026-11-24T14:00:00Z', end_kind: 'expire' });
    await store.put('plain', VALUE);
    expect(await store.adjustEnd('plain', { endsAt: later(HOUR) })).toEqual({ ends_at: '2026-11-24T13:00:00Z', end_kind: 'expire' });
    await store.put('none', VALUE);
    expect((await refusal(store.adjustEnd('none', { endKind: 'delete' }))).code).toBe('invalid_end');
    expect((await refusal(store.adjustEnd('nope', { endsAt: later(HOUR) }))).code).toBe('not_found');
  });
});

describe('the index version', () => {
  it(`writes version ${INDEX_VERSION}, reads a version 1 index with its ends, and refuses one it does not know`, async () => {
    await store.put('k', VALUE, { endsAt: later(HOUR), endKind: 'expire' });
    expect(INDEX_VERSION).toBe(2);
    expect((index() as { version?: unknown }).version).toBe(2);
    // An older aib rewrote the index as version 1 and kept this entry's end (as its describe does).
    writeFileSync(join(dir, 'index.json'), JSON.stringify({ ...index(), version: 1 }));
    expect((await store.list())[0]).toMatchObject({ ends_at: '2026-11-24T13:00:00Z' });
    for (const version of [3, 0, 1.5, '2', null]) {
      writeFileSync(join(dir, 'index.json'), JSON.stringify({ ...index(), version }));
      const err = await refusal(store.path('k'));
      expect(err.code, String(version)).toBe('store_unavailable');
      expect(err.message).toContain('has a format this version does not know');
      // Refused, never rewritten: the newer index is left as it is.
      expect(((await refusal(store.put('x', VALUE))).code)).toBe('store_unavailable');
      expect((index() as { version?: unknown }).version).toEqual(version);
      writeFileSync(join(dir, 'index.json'), JSON.stringify({ ...index(), version: 2 }));
    }
  });
});
