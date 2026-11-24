/**
 * `aib secret ...` as a person runs it: the built CLI (dist/cli.js, built by
 * `npm ci`/`npm run build`) with HOME pointing at a scratch folder. The value
 * only ever comes in on stdin or --from-file, and no command prints it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve('dist/cli.js');
const VALUE = 'sk-test-0123456789-very-secret';
let home: string;

function aib(args: string[], input?: string) {
  const r = spawnSync(process.execPath, [CLI, 'secret', ...args], {
    env: { PATH: process.env['PATH'], HOME: home }, input: input ?? '', encoding: 'utf8', timeout: 15_000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

beforeEach(() => {
  if (!existsSync(CLI)) throw new Error('dist/cli.js is missing: run `npm run build` first');
  home = mkdtempSync(join(tmpdir(), 'aib-secret-cli-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('aib secret', () => {
  it('add reads stdin (less one trailing newline), refuses a taken name, replaces with --replace; nothing prints the value', async () => {
    const add = aib(['add', 'db', '--description', 'Postgres'], `${VALUE}\n`);
    expect(add.code).toBe(0);
    const file = join(home, '.ai-bridge', 'secrets', 'db');
    expect(readFileSync(file, 'utf8')).toBe(VALUE);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const again = aib(['add', 'db'], 'other-value-123');
    expect(again.code).toBe(1);
    expect(again.err).toMatch(/already exists/);
    expect(aib(['add', 'db', '--replace'], 'other-value-123').code).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe('other-value-123');
    const list = aib(['list']);
    expect(list.out).toMatch(/^db\s+\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\s+Postgres$/m);
    for (const r of [add, again, list, aib(['path', 'db']), aib(['describe', 'db', 'new words'])]) {
      expect(r.out + r.err).not.toContain(VALUE);
      expect(r.out + r.err).not.toContain('other-value-123');
    }
  });

  it('add takes no value argument, and refuses an empty value', () => {
    const extra = aib(['add', 'db', VALUE], '');
    expect(extra.code).not.toBe(0);
    expect(existsSync(join(home, '.ai-bridge', 'secrets', 'db'))).toBe(false);
    expect(aib(['add', 'db'], '').code).toBe(1);
  });

  it('add --from-file stores the file as it is', () => {
    const src = join(home, 'key.pem');
    writeFileSync(src, 'line one\nline two\n');
    expect(aib(['add', 'pem', '--from-file', src]).code).toBe(0);
    expect(readFileSync(join(home, '.ai-bridge', 'secrets', 'pem'), 'utf8')).toBe('line one\nline two\n');
  });

  it('path, describe, remove (only with --yes); a missing name exits 2', () => {
    aib(['add', 'k'], VALUE);
    expect(aib(['path', 'k']).out.trim()).toBe(join(home, '.ai-bridge', 'secrets', 'k'));
    expect(aib(['describe', 'k', 'words']).code).toBe(0);
    expect(aib(['list']).out).toMatch(/words/);
    const noYes = aib(['remove', 'k']);
    expect(noYes.code).toBe(1);
    expect(noYes.err).toMatch(/--yes/);
    expect(aib(['remove', 'k', '--yes']).code).toBe(0);
    expect(aib(['path', 'k']).code).toBe(2);
  });

  it('run masks, passes the exit code, and takes options for itself only before --', () => {
    aib(['add', 'k'], VALUE);
    const r = aib(['run', 'k', '--env', 'TOKEN', '--', 'sh', '-c', 'echo "$TOKEN"; cat "$SECRET_FILE"; echo; exit 3']);
    expect(r.code).toBe(3);
    expect(r.out).toBe('***SECRET***\n***SECRET***\n');
    const literal = aib(['run', 'k', '--', 'sh', '-c', 'echo "$0"', '--env']);
    expect(literal.out).toBe('--env\n');
    expect(aib(['run', 'k', '--', 'no-such-command-xyz']).code).toBe(127);
  });

  it('run --no-mask lets the output through untouched', () => {
    aib(['add', 'k'], VALUE);
    expect(aib(['run', 'k', '--no-mask', '--', 'sh', '-c', 'cat "$SECRET_FILE"']).out).toBe(VALUE);
  });

  it('run into a closed pipe ends quietly, as the command would', () => {
    aib(['add', 'k'], VALUE);
    const r = spawnSync('sh', ['-c', `"${process.execPath}" "${CLI}" secret run k -- yes | head -2`], {
      env: { PATH: process.env['PATH'], HOME: home }, encoding: 'utf8', timeout: 15_000,
    });
    expect(r.stdout).toBe('y\ny\n');
    expect(r.stderr).not.toMatch(/EPIPE|Unhandled/);
  });

  it('list shows a description with control characters escaped', () => {
    const dir = join(home, '.ai-bridge', 'secrets');
    aib(['add', 'k'], VALUE);
    writeFileSync(join(dir, 'index.json'), JSON.stringify({ version: 1, secrets: { k: { description: 'x\u001b[2Jy' } } }));
    const out = aib(['list']).out;
    expect(out).not.toContain('\u001b');
    expect(out).toContain('x\\u{1b}[2Jy');
  });

  it('import copies a folder with .desc and reports what it skipped', () => {
    const src = join(home, 'old');
    mkdirSync(join(src, '.desc'), { recursive: true });
    writeFileSync(join(src, 'gh'), VALUE);
    writeFileSync(join(src, '.desc', 'gh'), 'GitHub');
    writeFileSync(join(src, 'bad name'), 'x');
    const r = aib(['import', src]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Imported 1 .*: gh\./);
    expect(r.out).toMatch(/Skipped bad name: not a valid secret name/);
    expect(r.out).not.toContain(VALUE);
    expect(aib(['list']).out).toMatch(/^gh .*GitHub$/m);
  });

  it('add --ends-in/--ends-at/--delete-at-end sets an end, list shows it, end changes and removes it', () => {
    expect(aib(['add', 'k', '--ends-in', '2d', '--description', 'temp'], VALUE).code).toBe(0);
    expect(aib(['list']).out).toMatch(/^k\s+\S+ \S+\s+ends \d{4}-\d\d-\d\d \d\d:\d\d:\d\d \(expires then\)\s+temp$/m);
    expect(aib(['add', 'd', '--ends-at', '2030-01-01T00:00:00+01:00', '--delete-at-end'], VALUE).code).toBe(0);
    expect(aib(['list']).out).toMatch(/^d\s+.*ends 2029-12-31 23:00:00 \(deleted then\)$/m);
    expect(aib(['end', 'k', '--at', '2030-06-01T12:00:00Z', '--delete-at-end']).code).toBe(0);
    expect(aib(['list']).out).toMatch(/^k\s+.*ends 2030-06-01 12:00:00 \(deleted then\)\s+temp$/m);
    expect(aib(['end', 'k', '--none']).code).toBe(0);
    expect(aib(['list']).out).not.toMatch(/^k .*ends/m);
    for (const bad of [
      ['add', 'x', '--ends-in', '2y'], ['add', 'x', '--delete-at-end'], ['add', 'x', '--ends-in', '1h', '--ends-at', '2030-01-01T00:00:00Z'],
      ['add', 'x', '--ends-at', '2030-01-01T00:00:00'], ['add', 'x', '--ends-at', '2099-01-01T00:00:00Z'], ['add', 'x', '--ends-at', '2001-01-01T00:00:00Z'],
    ]) {
      const r = aib(bad, VALUE);
      expect(r.code, bad.join(' ')).toBe(1);
    }
    expect(existsSync(join(home, '.ai-bridge', 'secrets', 'x'))).toBe(false);
    expect(aib(['end', 'k']).code).toBe(1);
    expect(aib(['end', 'k', '--none', '--expire']).code).toBe(1);
    expect(aib(['end', 'k', '--in', '1h', '--expire', '--delete-at-end']).code).toBe(1);
    expect(aib(['end', 'nope', '--in', '1h']).code).toBe(2);
  });

  it('run and path refuse an expired secret with their own exit code; list shows it as expired; --replace renews it', () => {
    const dir = join(home, '.ai-bridge', 'secrets');
    aib(['add', 'k', '--description', 'OpenAI'], VALUE);
    const past = `${new Date(Date.now() - 3_600_000).toISOString().slice(0, 19)}Z`;
    const shown = past.slice(0, 19).replace('T', ' ');
    const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as { secrets: Record<string, Record<string, unknown>> };
    index.secrets['k'] = { ...index.secrets['k'], ends_at: past, end_kind: 'expire' };
    writeFileSync(join(dir, 'index.json'), JSON.stringify(index));
    const run = aib(['run', 'k', '--', 'sh', '-c', 'cat "$SECRET_FILE"']);
    expect(run.code).toBe(4);
    expect(run.err).toContain(`The secret "k" expired at ${past} and can no longer be used. Ask the person to renew it with the secret card.`);
    expect(run.out).not.toContain(VALUE);
    expect(existsSync(join(dir, 'k'))).toBe(false);
    expect(aib(['path', 'k']).code).toBe(4);
    const list = aib(['list']);
    expect(list.out).toMatch(new RegExp(`^k\\s+.*expired ${shown}\\s+OpenAI$`, 'm'));
    expect(list.err).toContain(`Ended: k expired at ${shown}.`);
    expect(aib(['add', 'k'], 'renewed-value').code).toBe(1);
    expect(aib(['end', 'k', '--none']).code).toBe(1);
    expect(aib(['add', 'k', '--replace'], 'renewed-value').code).toBe(0);
    expect(aib(['run', 'k', '--no-mask', '--', 'sh', '-c', 'cat "$SECRET_FILE"']).out).toBe('renewed-value');
  });

  it('end without a kind flag keeps the kind a secret already has, and uses expire when it had no end', () => {
    aib(['add', 'del', '--ends-in', '1h', '--delete-at-end'], VALUE);
    expect(aib(['end', 'del', '--in', '2d']).code).toBe(0);
    expect(aib(['list']).out).toMatch(/^del\s+.*\(deleted then\)$/m);
    expect(aib(['end', 'del', '--at', '2030-06-01T12:00:00Z']).code).toBe(0);
    expect(aib(['list']).out).toMatch(/^del\s+.*ends 2030-06-01 12:00:00 \(deleted then\)$/m);
    expect(aib(['end', 'del', '--in', '1d', '--expire']).code).toBe(0);
    expect(aib(['list']).out).toMatch(/^del\s+.*\(expires then\)$/m);
    aib(['add', 'plain'], VALUE);
    expect(aib(['end', 'plain', '--in', '2d']).code).toBe(0);
    expect(aib(['list']).out).toMatch(/^plain\s+.*\(expires then\)$/m);
  });
});

