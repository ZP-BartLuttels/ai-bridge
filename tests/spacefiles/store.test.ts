/**
 * A space's kept files (spacefiles/store.ts): what the server may name is held
 * to `<first allowed folder>/files/<space>/`, nothing is ever replaced, only
 * the bin is ever emptied, and a write copies only from the frame, a recorded
 * upload, or an allowed folder.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServedFiles, openRecorded } from '../../src/attachments/served.js';
import { FilesRefusal, MAX_INLINE_BYTES, SpaceFiles } from '../../src/spacefiles/store.js';

let base: string;
let outside: string;
let served: ServedFiles;
let files: SpaceFiles;
const b64 = (s: string) => Buffer.from(s).toString('base64');
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'spacefiles-')));
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'spacefiles-out-')));
  served = new ServedFiles(null);
  files = new SpaceFiles([base], served);
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

async function refused(p: Promise<unknown>): Promise<FilesRefusal> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(FilesRefusal);
  return err as FilesRefusal;
}

describe('writing', () => {
  it('writes into <allowed>/files/<space>/, with a .gitignore at the root, and answers size and digest', async () => {
    const done = await files.write({ space: 'personal', path: 'notes.txt', content_base64: b64('hello'), sha256: sha('hello') });
    expect(done).toEqual({ path: join(base, 'files', 'personal', 'notes.txt'), size: 5, sha256: sha('hello') });
    expect(readFileSync(done.path, 'utf8')).toBe('hello');
    expect(readFileSync(join(base, 'files', '.gitignore'), 'utf8')).toBe('*\n');
  });

  it('never replaces a file: the same name twice is refused and the first is untouched', async () => {
    await files.write({ space: 'personal', path: 'a.txt', content_base64: b64('one') });
    expect((await refused(files.write({ space: 'personal', path: 'a.txt', content_base64: b64('two') }))).code).toBe('files_exists');
    expect(readFileSync(join(base, 'files', 'personal', 'a.txt'), 'utf8')).toBe('one');
  });

  it('refuses a digest that does not match, leaving nothing behind', async () => {
    expect((await refused(files.write({ space: 's', path: 'a.txt', content_base64: b64('x'), sha256: sha('y') }))).code).toBe('files_failed');
    expect(existsSync(join(base, 'files', 's', 'a.txt'))).toBe(false);
  });

  it('refuses names that leave the folder, hidden names, and writing into the bin', async () => {
    for (const path of ['../x', 'a/../../x', '/etc/passwd', '.hidden', 'a\\b', 'a\u0000b', '']) {
      expect((await refused(files.write({ space: 's', path, content_base64: b64('x') }))).code).toBe('files_refused');
    }
    for (const space of ['..', '.bin', 'a/b', '']) {
      expect((await refused(files.write({ space, path: 'x', content_base64: b64('x') }))).code).toBe('files_refused');
    }
    expect((await refused(files.write({ space: 's', path: '.bin/x', content_base64: b64('x') }))).code).toBe('files_refused');
  });

  it('refuses a symlinked folder planted on the way', async () => {
    mkdirSync(join(base, 'files', 's'), { recursive: true });
    symlinkSync(outside, join(base, 'files', 's', 'sub'));
    expect((await refused(files.write({ space: 's', path: 'sub/x.txt', content_base64: b64('x') }))).code).toBe('files_refused');
    expect(existsSync(join(outside, 'x.txt'))).toBe(false);
  });

  it('refuses inline content over the cap', async () => {
    const big = Buffer.alloc(MAX_INLINE_BYTES + 1).toString('base64');
    expect((await refused(files.write({ space: 's', path: 'big.bin', content_base64: big }))).code).toBe('files_too_large');
  });

  it('copies a recorded upload by its id, never a path', async () => {
    const up = join(base, 'file-uploads');
    mkdirSync(up);
    writeFileSync(join(up, 'contract.pdf'), 'pdf bytes');
    const id = served.record(join(up, 'contract.pdf'), 9, 'upload');
    const done = await files.write({ space: 's', path: 'contract.pdf', from_file_id: id });
    expect(readFileSync(done.path, 'utf8')).toBe('pdf bytes');
    expect((await refused(files.write({ space: 's', path: 'c2.pdf', from_file_id: join(up, 'contract.pdf') }))).code).toBe('files_gone');
  });

  it('copies from a path inside an allowed folder only, and not from the kept files themselves', async () => {
    writeFileSync(join(base, 'report.md'), '# report');
    expect(readFileSync((await files.write({ space: 's', path: 'report.md', from_path: join(base, 'report.md') })).path, 'utf8')).toBe('# report');
    writeFileSync(join(outside, 'secret'), 'key');
    expect((await refused(files.write({ space: 's', path: 'k', from_path: join(outside, 'secret') }))).code).toBe('files_refused');
    symlinkSync(join(outside, 'secret'), join(base, 'link'));
    expect((await refused(files.write({ space: 's', path: 'k', from_path: join(base, 'link') }))).code).toBe('files_refused');
    expect((await refused(files.write({ space: 's', path: 'k', from_path: join(base, 'files', 's', 'report.md') }))).code).toBe('files_refused');
  });

  it('refuses everything on a machine with no allowed folder', async () => {
    const none = new SpaceFiles([], served);
    expect((await refused(none.write({ space: 's', path: 'a', content_base64: b64('x') }))).code).toBe('files_no_folder');
  });
});

describe('reading, moving and purging', () => {
  it('reads small files inline, checks the digest, and records a file for a person by id', async () => {
    await files.write({ space: 's', path: 'a.txt', content_base64: b64('hello') });
    const r = await files.read({ space: 's', path: 'a.txt', sha256: sha('hello'), inline_max: 100, serve: true });
    expect(Buffer.from(r.content_base64!, 'base64').toString()).toBe('hello');
    const { handle } = await openRecorded(served, r.file_id!);
    await handle.close();
    expect((await files.read({ space: 's', path: 'a.txt', inline_max: 2 })).content_base64).toBeUndefined();
    writeFileSync(join(base, 'files', 's', 'a.txt'), 'HELLO');
    expect((await refused(files.read({ space: 's', path: 'a.txt', sha256: sha('hello') }))).code).toBe('files_changed');
    expect((await refused(files.read({ space: 's', path: 'gone.txt' }))).code).toBe('files_gone');
  });

  it('moves into the bin and back without replacing; purges only from the bin', async () => {
    await files.write({ space: 's', path: 'a.txt', content_base64: b64('hello') });
    await files.move({ space: 's', from: 'a.txt', to: '.bin/a.txt' });
    expect(existsSync(join(base, 'files', 's', 'a.txt'))).toBe(false);
    expect(readFileSync(join(base, 'files', 's', '.bin', 'a.txt'), 'utf8')).toBe('hello');
    await files.write({ space: 's', path: 'a.txt', content_base64: b64('other') });
    expect((await refused(files.move({ space: 's', from: '.bin/a.txt', to: 'a.txt' }))).code).toBe('files_exists');
    expect((await refused(files.purge({ space: 's', path: 'a.txt' }))).code).toBe('files_refused');
    await files.purge({ space: 's', path: '.bin/a.txt' });
    expect(existsSync(join(base, 'files', 's', '.bin', 'a.txt'))).toBe(false);
    expect(readFileSync(join(base, 'files', 's', 'a.txt'), 'utf8')).toBe('other');
  });
});
