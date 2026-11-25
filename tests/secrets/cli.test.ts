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

// Every case spawns the CLI a dozen times or more.
describe('aib secret', { timeout: 30_000 }, () => {
  it('add reads stdin (less one trailing newline), refuses a taken name, replaces with --replace; nothing prints the value', async () => {
    const add = aib(['add', 'db', '--description', 'Postgres'], `${VALUE}\n`);
    expect(add.code).toBe(0);
    const file = join(home, '.ai-bridge', 'secrets', 'db');
    expect(readFileSync(file, 'utf8')).toBe(VALUE);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const again = aib(['add', 'db'], 'other-value-123');
    expect(again.code).toBe(1);
    expect(again.err).toMatch(/already exists/);
    const noEnd = aib(['add', 'db', '--replace'], 'other-value-123');
    expect(noEnd.code).toBe(1);
    expect(noEnd.err).toContain('Replacing "db" must state its end');
    expect(readFileSync(file, 'utf8')).toBe(VALUE);
    expect(aib(['add', 'db', '--replace', '--no-end'], 'other-value-123').code).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe('other-value-123');
    const list = aib(['list']);
    expect(list.out).toMatch(/^db\s+\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC\s+Postgres$/m);
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
    expect(aib(['list']).out).toMatch(/^k\s+\S+ \S+ UTC\s+expires \d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC\s+temp$/m);
    const d = aib(['add', 'd', '--ends-at', '2030-01-01T00:00:00+01:00', '--delete-at-end'], VALUE);
    expect(d.out).toMatch(/; it is deleted 2029-12-31 23:00:00 UTC\.$/m);
    expect(aib(['list']).out).toMatch(/^d\s+.*deleted 2029-12-31 23:00:00 UTC$/m);
    expect(aib(['end', 'k', '--at', '2030-06-01T12:00:00Z', '--delete-at-end']).code).toBe(0);
    expect(aib(['list']).out).toMatch(/^k\s+.*deleted 2030-06-01 12:00:00 UTC\s+temp$/m);
    expect(aib(['end', 'k', '--none']).code).toBe(0);
    expect(aib(['list']).out).not.toMatch(/^k .*(expires|deleted) /m);
    const none = aib(['end', 'k']);
    expect(none.code).toBe(1);
    expect(none.err).toContain('Give --in, --at or --none.');
    expect(aib(['end', 'k', '--none', '--expire']).code).toBe(1);
    expect(aib(['end', 'k', '--in', '1h', '--expire', '--delete-at-end']).code).toBe(1);
    expect(aib(['end', 'nope', '--in', '1h']).code).toBe(2);
  });

  it('refuses a bad end before the value is used, saying what is wrong', () => {
    for (const [bad, why] of [
      [['add', 'x', '--ends-in', '2y'], 'is not a duration'],
      [['add', 'x', '--delete-at-end'], 'add --ends-in <duration> or --ends-at <time>'],
      [['add', 'x', '--ends-in', '1h', '--ends-at', '2030-01-01T00:00:00Z'], 'not both'],
      [['add', 'x', '--ends-at', '2030-01-01T00:00:00'], 'is not a time with a zone'],
      [['add', 'x', '--ends-at', '2099-01-01T00:00:00Z'], 'at most 10 years ahead'],
      [['add', 'x', '--ends-at', '2001-01-01T00:00:00Z'], 'must be in the future'],
      [['add', 'x', '--no-end', '--ends-in', '1h'], '--no-end removes the end'],
      [['add', 'x', '--expire', '--delete-at-end', '--ends-in', '1h'], 'not both'],
    ] as const) {
      const r = aib([...bad], VALUE);
      expect(r.code, bad.join(' ')).toBe(1);
      expect(r.err, bad.join(' ')).toContain(why);
    }
    expect(existsSync(join(home, '.ai-bridge', 'secrets', 'x'))).toBe(false);
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
    expect(run.err).toContain(`The secret "k" expired at ${past} and can no longer be used. Ask the person to renew it.`);
    expect(run.out).not.toContain(VALUE);
    expect(existsSync(join(dir, 'k'))).toBe(false);
    expect(aib(['path', 'k']).code).toBe(4);
    const list = aib(['list']);
    expect(list.out).toMatch(new RegExp(`^k\\s+.*expired ${shown} UTC\\s+OpenAI$`, 'm'));
    expect(list.err).toContain(`Ended: k expired at ${shown} UTC.`);
    expect(run.err).toContain('On this machine: aib secret add k --replace with --ends-in, --ends-at or --no-end.');
    const taken = aib(['add', 'k'], 'renewed-value');
    expect(taken.code).toBe(1);
    expect(taken.err).toContain(`"k" expired at ${shown} UTC; add --replace to renew it.`);
    const ended = aib(['end', 'k', '--none']);
    expect(ended.code).toBe(1);
    expect(ended.err).toContain('aib secret add k --replace');
    const noYes = aib(['remove', 'k']);
    expect(noYes.code).toBe(1);
    expect(noYes.err).toContain('run again with --yes');
    // A replace must state its end: refused before the value is read.
    const keep = aib(['add', 'k', '--replace'], 'renewed-value');
    expect(keep.code).toBe(1);
    expect(keep.err).toContain('Replacing "k" must state its end: add --ends-in <duration> or --ends-at <time> (with --delete-at-end to delete it at the end), or --no-end for none. Nothing was changed.');
    expect(existsSync(join(dir, 'k'))).toBe(false);
    const renew = aib(['add', 'k', '--replace', '--no-end'], 'renewed-value');
    expect(renew.code).toBe(0);
    expect(renew.out).toContain('; it has no end.');
    expect(aib(['run', 'k', '--no-mask', '--', 'sh', '-c', 'cat "$SECRET_FILE"']).out).toBe('renewed-value');
  });

  it('end without a kind flag keeps the kind a secret already has, and uses expire when it had no end', () => {
    aib(['add', 'del', '--ends-in', '1h', '--delete-at-end'], VALUE);
    expect(aib(['end', 'del', '--in', '2d']).code).toBe(0);
    expect(aib(['list']).out).toMatch(/^del\s+.*deleted \S+ \S+ UTC$/m);
    expect(aib(['end', 'del', '--at', '2030-06-01T12:00:00Z']).code).toBe(0);
    expect(aib(['list']).out).toMatch(/^del\s+.*deleted 2030-06-01 12:00:00 UTC$/m);
    expect(aib(['end', 'del', '--in', '1d', '--expire']).code).toBe(0);
    expect(aib(['list']).out).toMatch(/^del\s+.*expires \S+ \S+ UTC$/m);
    aib(['add', 'plain'], VALUE);
    expect(aib(['end', 'plain', '--in', '2d']).code).toBe(0);
    expect(aib(['list']).out).toMatch(/^plain\s+.*expires \S+ \S+ UTC$/m);
  });

  it('end takes --ends-in/--ends-at too, and a kind flag alone keeps the time', () => {
    aib(['add', 'k'], VALUE);
    expect(aib(['end', 'k', '--ends-at', '2030-06-01T12:00:00Z']).code).toBe(0);
    const kind = aib(['end', 'k', '--delete-at-end']);
    expect(kind.code).toBe(0);
    expect(kind.out).toBe('"k" is deleted 2030-06-01 12:00:00 UTC.\n');
    expect(aib(['end', 'k', '--ends-in', '2d']).code).toBe(0);
    expect(aib(['list']).out).toMatch(/^k\s+.*deleted \S+ \S+ UTC$/m);
    expect(aib(['end', 'k', '--in', '1d', '--ends-in', '2d']).err).toContain('Give --in or --ends-in once.');
    aib(['add', 'plain'], VALUE);
    const alone = aib(['end', 'plain', '--expire']);
    expect(alone.code).toBe(1);
    expect(alone.err).toContain('"plain" has no end yet: give the time it ends');
  });

  it('add --replace must state its end: an end flag or --no-end; the old end is never kept', () => {
    const file = join(home, '.ai-bridge', 'secrets', 'k');
    aib(['add', 'k', '--ends-at', '2030-06-01T12:00:00Z', '--delete-at-end'], VALUE);
    const bare = aib(['add', 'k', '--replace'], 'other-value-123');
    expect(bare.code).toBe(1);
    expect(bare.err).toContain('Replacing "k" must state its end');
    expect(readFileSync(file, 'utf8')).toBe(VALUE);
    expect(aib(['list']).out).toMatch(/^k\s+.*deleted 2030-06-01 12:00:00 UTC$/m);
    // An end flag without a kind flag expires: the old kind is not carried over either.
    const changed = aib(['add', 'k', '--replace', '--ends-at', '2031-01-01T00:00:00Z'], 'other-value-456');
    expect(changed.code).toBe(0);
    expect(changed.out).toMatch(/^Replaced "k" \(15 bytes\) in .*; it expires 2031-01-01 00:00:00 UTC\.$/m);
    const toDelete = aib(['add', 'k', '--replace', '--ends-at', '2031-01-01T00:00:00Z', '--delete-at-end'], 'other-value-456');
    expect(toDelete.out).toMatch(/; it is deleted 2031-01-01 00:00:00 UTC\.$/m);
    const removed = aib(['add', 'k', '--replace', '--no-end'], 'other-value-789');
    expect(removed.out).toMatch(/; it has no end\.$/m);
    expect(aib(['list']).out).not.toMatch(/^k .*(expires|deleted) /m);
    for (const r of [bare, changed, toDelete, removed]) expect(r.out + r.err).not.toMatch(/other-value/);
  });

  it('--ends-at refuses a date or time that does not exist instead of rolling it over', () => {
    for (const bad of [
      '2027-02-30T12:00:00Z', '2027-02-29T12:00:00Z', '2027-04-31T12:00:00Z', '2027-13-01T00:00:00Z', '2027-00-10T00:00:00Z',
      '2027-01-01T24:00:00Z', '2027-01-01T12:60:00Z', '2027-01-01T12:00:60Z', '2027-01-01T12:00:00+25:00', '2027-01-01T12:00:00+01:60',
    ]) {
      const r = aib(['add', 'x', '--ends-at', bad], VALUE);
      expect(r.code, bad).toBe(1);
      expect(r.err, bad).toContain('is not a time with a zone');
    }
    expect(existsSync(join(home, '.ai-bridge', 'secrets', 'x'))).toBe(false);
    expect(aib(['add', 'leap', '--ends-at', '2028-02-29T23:30:00-01:00'], VALUE).out).toContain('it expires 2028-03-01 00:30:00 UTC.');
    expect(aib(['add', 'frac', '--ends-at', '2028-01-01T00:00:00.000Z'], VALUE).code).toBe(0);
    expect(aib(['add', 'frac2', '--ends-at', '2028-01-01T00:00:00.5Z'], VALUE).err).toContain('whole seconds');
  });

  it('import --replace must state its end like add --replace, and writes the one given or none', () => {
    const src = join(home, 'folder');
    mkdirSync(src);
    writeFileSync(join(src, 'k'), 'other-value-123');
    aib(['add', 'k', '--ends-in', '1w', '--delete-at-end'], VALUE);
    const bare = aib(['import', src, '--replace']);
    expect(bare.code).toBe(1);
    expect(bare.err).toContain('Importing with --replace must state its end');
    expect(readFileSync(join(home, '.ai-bridge', 'secrets', 'k'), 'utf8')).toBe(VALUE);
    expect(aib(['list']).out).toMatch(/^k\s+.*deleted \S+ \S+ UTC$/m);
    const changed = aib(['import', src, '--replace', '--ends-at', '2031-01-01T00:00:00Z']);
    expect(changed.out).toMatch(/^k: it expires 2031-01-01 00:00:00 UTC\.$/m);
    const removed = aib(['import', src, '--replace', '--no-end']);
    expect(removed.out).toMatch(/^k: it has no end\.$/m);
    expect(aib(['list']).out).not.toMatch(/^k .*(expires|deleted) /m);
    expect(aib(['import', src, '--no-end', '--ends-in', '1d']).err).toContain('--no-end removes the end');
    expect(aib(['import', src, '--delete-at-end']).err).toContain('What happens at the end needs an end');
    for (const r of [bare, changed, removed]) expect(r.out + r.err).not.toContain('other-value-123');
  });
});
