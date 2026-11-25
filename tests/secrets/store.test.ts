/**
 * The built-in machine secret store (src/secrets/store.ts, decision 0020):
 * file modes from creation, exists/replace, describe, remove, the folder
 * checks, and an import from a one-file-per-secret folder.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MachineSecretStore, SecretRefusal, checkName, defaultSecretsDir } from '../../src/secrets/store.js';
import { importFolder } from '../../src/secrets/cli.js';

const VALUE = 'sk-test-0123456789-very-secret';

let home: string;
let dir: string;
let store: MachineSecretStore;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'secret-store-'));
  dir = defaultSecretsDir(home);
  store = new MachineSecretStore(dir);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

async function refusal(promise: Promise<unknown>): Promise<SecretRefusal> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(SecretRefusal);
    return err as SecretRefusal;
  }
  throw new Error('expected a refusal');
}

describe('the store', () => {
  it('lives in ~/.ai-bridge/secrets', () => {
    expect(defaultSecretsDir('/home/someone')).toBe('/home/someone/.ai-bridge/secrets');
  });

  it('is empty and creates nothing until the first put', async () => {
    expect(await store.list()).toEqual([]);
    expect(existsSync(dir)).toBe(false);
  });

  it('creates the folder 0700 and each secret 0600, the index 0600, and leaves no temp file', async () => {
    expect(await store.put('db_password', VALUE, { description: 'Postgres' })).toEqual({ replaced: false });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'db_password')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'index.json')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, 'db_password'), 'utf8')).toBe(VALUE);
    expect(readdirSync(dir).sort()).toEqual(['db_password', 'index.json']);
    const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as { secrets: Record<string, { description: string }> };
    expect(index.secrets['db_password']!.description).toBe('Postgres');
    expect(readFileSync(join(dir, 'index.json'), 'utf8')).not.toContain(VALUE);
  });

  it('keeps 0600 even under a permissive umask', async () => {
    const before = process.umask(0o000);
    try {
      await store.put('a1', VALUE);
    } finally {
      process.umask(before);
    }
    expect(statSync(join(dir, 'a1')).mode & 0o777).toBe(0o600);
  });

  it('lists names, descriptions and dates, never values', async () => {
    await store.put('b-two', 'second-value-here');
    await store.put('a.one', VALUE, { description: 'first' });
    const rows = await store.list();
    expect(rows.map((r) => [r.name, r.description])).toEqual([['a.one', 'first'], ['b-two', null]]);
    expect(rows.every((r) => typeof r.updated_at === 'string')).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(VALUE);
  });

  it('refuses an existing name unless replace, and keeps the description on a replace', async () => {
    await store.put('k1', VALUE, { description: 'kept' });
    const err = await refusal(store.put('k1', 'another-value'));
    expect(err.code).toBe('exists');
    expect(readFileSync(join(dir, 'k1'), 'utf8')).toBe(VALUE);
    expect(await store.put('k1', 'another-value', { replace: true, endsAt: null })).toEqual({ replaced: true });
    expect(readFileSync(join(dir, 'k1'), 'utf8')).toBe('another-value');
    expect((await store.list())[0]!.description).toBe('kept');
  });

  it('describes and removes; both say not_found for a missing name', async () => {
    await store.put('k1', VALUE);
    await store.describe('k1', 'what it is');
    expect((await store.list())[0]!.description).toBe('what it is');
    await store.describe('k1', '');
    expect((await store.list())[0]!.description).toBeNull();
    await store.remove('k1');
    expect(existsSync(join(dir, 'k1'))).toBe(false);
    expect(await store.list()).toEqual([]);
    expect((await refusal(store.remove('k1'))).code).toBe('not_found');
    expect((await refusal(store.describe('k1', 'x'))).code).toBe('not_found');
    expect((await refusal(store.path('k1'))).code).toBe('not_found');
  });

  it('checks names: letter or digit first, no "..", no path, no trailing newline, not index.json', async () => {
    for (const ok of ['a', 'A9', '9a', 'db_password', 'x.y-z', 'a'.repeat(64)]) expect(checkName(ok)).toBe(ok);
    for (const bad of ['', '.hidden', '-x', '_x', 'a/b', '../etc', 'a..b', 'a\n', 'a b', 'index.json', 'a'.repeat(65), 'é']) {
      expect(() => checkName(bad)).toThrow(SecretRefusal);
    }
    expect((await refusal(store.put('a\n', VALUE))).code).toBe('invalid_name');
  });

  it('refuses an empty value, an oversized one, and a description over 1000 characters', async () => {
    expect((await refusal(store.put('k', ''))).code).toBe('invalid_request');
    expect((await refusal(store.put('k', 'x'.repeat(64 * 1024 + 1)))).code).toBe('invalid_request');
    expect((await refusal(store.put('k', VALUE, { description: 'd'.repeat(1001) }))).code).toBe('invalid_request');
    await store.put('k', VALUE, { description: 'é'.repeat(1000) });
  });

  it('refuses control characters in a description (an escape sequence would reach the terminal), keeps tab and newline', async () => {
    expect((await refusal(store.put('k', VALUE, { description: '\u001b[2Jclear' }))).code).toBe('invalid_request');
    expect((await refusal(store.put('k', VALUE, { description: 'bell\u0007' }))).code).toBe('invalid_request');
    expect((await refusal(store.put('k', VALUE, { description: 'c1\u009b' }))).code).toBe('invalid_request');
    await store.put('k', VALUE, { description: 'two\tparts\nand a line' });
  });

  it('refuses index.json in any case, and a name that differs from an existing one only in case', async () => {
    expect((await refusal(store.put('INDEX.json', VALUE))).code).toBe('invalid_name');
    await store.put('Token', VALUE);
    const twin = await refusal(store.put('token', VALUE));
    expect(twin.code).toBe('exists');
    expect(twin.message).toMatch(/only in case/);
  });

  it('refuses a replace whose name matches an existing one only in case', async () => {
    await store.put('Token', VALUE);
    expect((await refusal(store.put('token', 'other-value-1', { replace: true, endsAt: null }))).message).toMatch(/only in case/);
    expect(readFileSync(join(dir, 'Token'), 'utf8')).toBe(VALUE);
  });

  it('takes over a lock left by a process that died, and leaves no lock behind', async () => {
    await store.put('a1', VALUE);
    mkdirSync(join(dir, '.lock'));
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(dir, '.lock'), old, old);
    await store.put('a2', VALUE);
    expect(readdirSync(dir).sort()).toEqual(['a1', 'a2', 'index.json']);
  });

  it('keeps a secret called constructor', async () => {
    await store.put('constructor', VALUE, { description: 'odd name' });
    expect(await store.list()).toMatchObject([{ name: 'constructor', description: 'odd name' }]);
    await store.remove('constructor');
  });

  it('refuses a folder that is a symlink, or open to others', async () => {
    const real = join(home, 'elsewhere');
    mkdirSync(real, { mode: 0o700 });
    mkdirSync(join(home, '.ai-bridge'), { mode: 0o700 });
    symlinkSync(real, dir);
    expect((await refusal(store.put('k', VALUE))).code).toBe('store_unavailable');
    expect((await refusal(store.list())).message).toMatch(/symlink/);
    rmSync(dir);
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o755);
    expect((await refusal(store.list())).message).toMatch(/chmod 700/);
  });

  it('does not follow a symlinked secret file', async () => {
    await store.put('k', VALUE);
    writeFileSync(join(home, 'target'), 'outside');
    symlinkSync(join(home, 'target'), join(dir, 'link1'));
    expect((await store.list()).map((r) => r.name)).toEqual(['k']);
    expect((await refusal(store.read('link1'))).code).toBe('store_unavailable');
  });

  it('refuses a damaged index instead of reading it as empty, and leaves it as it is', async () => {
    await store.put('k', VALUE, { description: 'd' });
    for (const text of ['{not json', '[]', '{"secrets": []}', 'null']) {
      writeFileSync(join(dir, 'index.json'), text);
      for (const op of [() => store.list(), () => store.path('k'), () => store.put('x', VALUE), () => store.setEnd('k', null)]) {
        expect((await refusal(op())).code, text).toBe('store_unavailable');
      }
      expect(readFileSync(join(dir, 'index.json'), 'utf8')).toBe(text);
    }
    expect(existsSync(join(dir, 'x'))).toBe(false);
  });
});

describe('import', () => {
  it('copies one file per secret with .desc descriptions, skips dot files, refuses existing names unless --replace, and leaves the folder alone', async () => {
    const src = join(home, 'old-secrets');
    mkdirSync(join(src, '.desc'), { recursive: true });
    writeFileSync(join(src, 'ci-token'), VALUE);
    writeFileSync(join(src, 'app.env'), 'API_KEY=abcdefghijkl\n');
    writeFileSync(join(src, '.hidden'), 'skip me');
    writeFileSync(join(src, 'bad name'), 'skip me too');
    mkdirSync(join(src, 'folder'));
    writeFileSync(join(src, '.desc', 'ci-token'), 'CI, read-only\n');
    await store.put('app.env', 'older-value-here');

    const report = await importFolder(store, src);
    expect(report.imported).toEqual(['ci-token']);
    expect(report.skipped).toEqual([
      { name: 'app.env', reason: 'exists (use --replace)' },
      { name: 'bad name', reason: 'not a valid secret name' },
      { name: 'folder', reason: 'not a regular file' },
    ]);
    expect(JSON.stringify(report)).not.toContain(VALUE);
    expect(readFileSync(join(dir, 'ci-token'), 'utf8')).toBe(VALUE);
    expect(statSync(join(dir, 'ci-token')).mode & 0o777).toBe(0o600);
    expect((await store.list()).find((r) => r.name === 'ci-token')!.description).toBe('CI, read-only');
    expect(readFileSync(join(dir, 'app.env'), 'utf8')).toBe('older-value-here');

    const again = await importFolder(store, src, { replace: true, end: { noEnd: true } });
    expect(again.imported).toEqual(['app.env', 'ci-token']);
    expect(readFileSync(join(dir, 'app.env'), 'utf8')).toBe('API_KEY=abcdefghijkl\n');
    expect(readdirSync(src).sort()).toEqual(['.desc', '.hidden', 'app.env', 'bad name', 'ci-token', 'folder']);
    expect(readFileSync(join(src, 'ci-token'), 'utf8')).toBe(VALUE);
  });

  it('--replace must state its end (end_required before anything is read), and writes the given end or none, never the old one', async () => {
    const src = join(home, 'old-secrets');
    mkdirSync(src);
    writeFileSync(join(src, 'api-key'), VALUE);
    await store.put('api-key', 'older-value-here', { endsAt: '2030-06-01T12:00:00Z', endKind: 'delete' });

    await expect(importFolder(store, src, { replace: true })).rejects.toMatchObject({ code: 'end_required' });
    expect(readFileSync(join(dir, 'api-key'), 'utf8')).toBe('older-value-here');
    expect((await store.list())[0]).toMatchObject({ ends_at: '2030-06-01T12:00:00Z', end_kind: 'delete' });

    const changed = await importFolder(store, src, { replace: true, end: { endsAt: '2031-01-01T00:00:00Z' } });
    expect(changed.imported).toEqual(['api-key']);
    expect(changed.ends).toEqual([{ name: 'api-key', words: 'it expires 2031-01-01 00:00:00 UTC' }]);
    expect(readFileSync(join(dir, 'api-key'), 'utf8')).toBe(VALUE);

    const removed = await importFolder(store, src, { replace: true, end: { noEnd: true } });
    expect(removed.ends).toEqual([{ name: 'api-key', words: 'it has no end' }]);
    expect((await store.list())[0]).toMatchObject({ ends_at: null, end_kind: null });
    expect(JSON.stringify([changed, removed])).not.toContain(VALUE);
  });
});
