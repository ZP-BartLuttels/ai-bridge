/**
 * A space's files, kept on this machine for the Engram server (PROTOCOL.md,
 * "Space files").
 *
 * Engram keeps no file bytes of its own. A space's files live on ONE machine,
 * its runner's, under `<first allowed folder>/files/<space folder>/`, and the
 * server asks this machine to write, read, move and remove them. What it may
 * name is held to that folder:
 *
 *   - The space folder is one plain name; a path is one or more plain names
 *     below it. No `..`, nothing hidden except the bin (`.bin/` as the first
 *     part), no separators, no control characters. Every folder on the way is
 *     checked to be a real folder, never a symlink, so a link planted inside
 *     cannot lead out.
 *   - Nothing is ever replaced. A write lands as a hidden `.part` and is given
 *     its name with `link`, which fails when the name is taken; a move does
 *     the same and then removes the old name. The server picks a new name for
 *     a new version; a clash is its bug, refused here.
 *   - Removing (`files_purge`) is only ever inside the bin. Deleting a file is
 *     a move into the bin, which the server asks for as `files_move`.
 *   - A write's bytes come from the frame itself (small content), from a file
 *     this bridge recorded (an upload, by the id it minted, never a path), or
 *     from a path INSIDE an allowed folder and outside the files folder. A
 *     server cannot use a write to copy `~/.ssh` into a space and read it back.
 */

import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, createReadStream, lstatSync, mkdirSync, openSync, realpathSync, writeFileSync } from 'node:fs';
import { link, open, rm, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { openRecorded, type ServedFiles } from '../attachments/served.js';

/** The folder, inside the first allowed folder, that holds every space's files. */
export const FILES_DIR = 'files';
/** The bin, inside a space's folder. */
export const BIN_DIR = '.bin';
/** The most a frame may carry either way (base64 adds a third; the server's relay drops frames over 900 KB). */
export const MAX_INLINE_BYTES = 512 * 1024;

export const FILES_NO_FOLDER = 'files_no_folder';
export const FILES_REFUSED = 'files_refused';
export const FILES_EXISTS = 'files_exists';
export const FILES_GONE = 'files_gone';
export const FILES_CHANGED = 'files_changed';
export const FILES_TOO_LARGE = 'files_too_large';
export const FILES_FAILED = 'files_failed';

/** A refusal with a code the server maps and a sentence a person may read. */
export class FilesRefusal extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'FilesRefusal';
  }
}

const SPACE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_DEPTH = 8;

/** One plain name, as a path part. */
function assertPart(part: string, first: boolean): void {
  if (!part || part === '.' || part === '..' || part.includes('/') || part.includes('\\') || CONTROL.test(part)
    || Buffer.byteLength(part) > 255) {
    throw new FilesRefusal(FILES_REFUSED, `"${part}" is not a plain file name.`);
  }
  if (part.startsWith('.') && !(first && part === BIN_DIR)) {
    throw new FilesRefusal(FILES_REFUSED, `"${part}" is hidden; only the bin (${BIN_DIR}) is.`);
  }
}

export interface WriteRequest {
  space: string;
  path: string;
  /** The bytes, base64, at most MAX_INLINE_BYTES decoded. */
  content_base64?: string;
  /** A file this bridge recorded (an upload or a file it handed back), by the id it minted. */
  from_file_id?: string;
  /** An absolute path inside an allowed folder, outside the files folder. */
  from_path?: string;
  /** When given, what was written must hash to this. */
  sha256?: string;
}

export interface ReadRequest {
  space: string;
  path: string;
  /** When given, the file must still hash to this. */
  sha256?: string;
  /** Send the bytes back in the answer when the file is at most this large (capped at MAX_INLINE_BYTES). */
  inline_max?: number;
  /** Record it so the server can fetch it for a person (file_read), and answer with that id. */
  serve?: boolean;
}

export interface Done {
  /** Absolute, for showing to a person. */
  path: string;
  size: number;
  sha256: string;
  content_base64?: string;
  file_id?: string;
}

export class SpaceFiles {
  /** `<first allowed folder>/files`, or null on a machine with no allowed folder. */
  readonly root: string | null;

  constructor(private readonly allowedRoots: string[], private readonly served: ServedFiles) {
    this.root = allowedRoots[0] ? join(allowedRoots[0], FILES_DIR) : null;
  }

  private needRoot(): string {
    if (!this.root) {
      throw new FilesRefusal(FILES_NO_FOLDER,
        'This machine has no folder set up for Engram (the bridge was started without --allow-dir), so there is nowhere to keep files.');
    }
    return this.root;
  }

  /** A real folder, made when missing; never a symlink. */
  private folder(path: string, gitignore = false): void {
    try {
      const st = lstatSync(path);
      if (st.isSymbolicLink() || !st.isDirectory()) throw new FilesRefusal(FILES_REFUSED, `${path} is not a plain folder.`);
      return;
    } catch (err) {
      if (err instanceof FilesRefusal) throw err;
    }
    mkdirSync(path, { mode: 0o700 });
    // Kept out of git when the allowed folder is a repository, as uploads are.
    if (gitignore) writeFileSync(join(path, '.gitignore'), '*\n', { flag: 'wx' });
  }

  /**
   * The absolute path for `rel` in `space`, every folder on the way checked
   * (and made, when `make`). The last part is not checked here: each
   * operation decides what it must or must not be.
   */
  resolve(space: string, rel: string, make = false): string {
    const root = this.needRoot();
    if (typeof space !== 'string' || !SPACE.test(space)) throw new FilesRefusal(FILES_REFUSED, `"${String(space)}" is not a space folder name.`);
    if (typeof rel !== 'string' || !rel || isAbsolute(rel)) throw new FilesRefusal(FILES_REFUSED, 'A file is named by a relative path.');
    const parts = rel.split('/');
    if (parts.length > MAX_DEPTH) throw new FilesRefusal(FILES_REFUSED, `"${rel}" is nested too deep.`);
    parts.forEach((p, i) => assertPart(p, i === 0));
    const dirs = [root, join(root, space), ...parts.slice(0, -1).map((_, i) => join(root, space, ...parts.slice(0, i + 1)))];
    for (const [i, d] of dirs.entries()) {
      if (make) this.folder(d, i === 0);
      else {
        let st;
        try { st = lstatSync(d); } catch { continue; }
        if (st.isSymbolicLink() || !st.isDirectory()) throw new FilesRefusal(FILES_REFUSED, `${d} is not a plain folder.`);
      }
    }
    return join(root, space, ...parts);
  }

  /** Write a new file; never replaces one. */
  async write(req: WriteRequest): Promise<Done> {
    const sources = [req.content_base64 !== undefined, req.from_file_id !== undefined, req.from_path !== undefined].filter(Boolean).length;
    if (sources !== 1) throw new FilesRefusal(FILES_REFUSED, 'A write names exactly one of content_base64, from_file_id or from_path.');
    const target = this.resolve(req.space, req.path, true);
    if (req.path.split('/')[0] === BIN_DIR) throw new FilesRefusal(FILES_REFUSED, 'Nothing is written into the bin; files are moved there.');
    const part = join(target, '..', `.${randomUUID()}.part`);
    const hash = createHash('sha256');
    let size = 0;
    const out = await open(part, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    try {
      try {
        const put = async (chunk: Buffer) => { hash.update(chunk); size += chunk.length; await out.write(chunk); };
        if (req.content_base64 !== undefined) {
          const bytes = Buffer.from(String(req.content_base64), 'base64');
          if (bytes.length > MAX_INLINE_BYTES) throw new FilesRefusal(FILES_TOO_LARGE, `Content sent inline is at most ${MAX_INLINE_BYTES} bytes.`);
          await put(bytes);
        } else if (req.from_file_id !== undefined) {
          let opened;
          try {
            opened = await openRecorded(this.served, String(req.from_file_id));
          } catch (err) {
            throw new FilesRefusal(FILES_GONE, err instanceof Error ? err.message : String(err));
          }
          try {
            for await (const chunk of opened.handle.createReadStream({ autoClose: false })) await put(chunk as Buffer);
          } finally {
            await opened.handle.close().catch(() => undefined);
          }
        } else {
          const from = this.source(String(req.from_path));
          for await (const chunk of createReadStream('', { fd: from })) await put(chunk as Buffer);
        }
      } finally {
        await out.close();
      }
      const sha256 = hash.digest('hex');
      if (req.sha256 && req.sha256 !== sha256) throw new FilesRefusal(FILES_FAILED, 'What was written does not match the digest the server sent.');
      try {
        await link(part, target);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new FilesRefusal(FILES_EXISTS, `${target} already exists; nothing is ever replaced.`);
        }
        throw err;
      }
      return { path: target, size, sha256 };
    } finally {
      await rm(part, { force: true }).catch(() => undefined);
    }
  }

  /**
   * A file to copy from, opened: inside an allowed folder, outside the files
   * folder, a plain file and not a link. Returns the descriptor.
   */
  private source(path: string): number {
    if (!isAbsolute(path)) throw new FilesRefusal(FILES_REFUSED, 'from_path is an absolute path on this machine.');
    let real: string;
    try { real = realpathSync(path); } catch { throw new FilesRefusal(FILES_GONE, `${path} does not exist on this machine.`); }
    const within = (p: string, root: string) => { const r = relative(root, p); return r !== '' && !r.startsWith('..') && !isAbsolute(r); };
    const roots = this.allowedRoots.map((r) => { try { return realpathSync(r); } catch { return r; } });
    if (!roots.some((r) => within(real, r))) {
      throw new FilesRefusal(FILES_REFUSED, `${path} is outside the folders this bridge allows (--allow-dir), so it is not copied.`);
    }
    const filesRoot = this.root ? (() => { try { return realpathSync(this.root!); } catch { return this.root!; } })() : null;
    if (filesRoot && (real === filesRoot || within(real, filesRoot))) {
      throw new FilesRefusal(FILES_REFUSED, `${path} is already among the kept files; save from the original instead.`);
    }
    const st = lstatSync(real);
    if (!st.isFile()) throw new FilesRefusal(FILES_REFUSED, `${path} is not a plain file.`);
    // O_NOFOLLOW on the resolved path; the descriptor is handed to the stream, which closes it.
    return openSync(real, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  }

  /** Read (and check) a file; the bytes only when small enough. */
  async read(req: ReadRequest): Promise<Done> {
    const path = this.resolve(req.space, req.path);
    const { handle, size } = await this.openPlain(path);
    try {
      const hash = createHash('sha256');
      const limit = Math.min(Math.max(0, Number(req.inline_max ?? 0)), MAX_INLINE_BYTES);
      const keep = size <= limit;
      const chunks: Buffer[] = [];
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        hash.update(chunk as Buffer);
        if (keep) chunks.push(chunk as Buffer);
      }
      const sha256 = hash.digest('hex');
      if (req.sha256 && req.sha256 !== sha256) {
        throw new FilesRefusal(FILES_CHANGED, `${path} has changed on this machine since it was saved (its contents differ).`);
      }
      const out: Done = { path, size, sha256 };
      if (keep) out.content_base64 = Buffer.concat(chunks).toString('base64');
      if (req.serve) out.file_id = this.served.record(path, size, 'space_file');
      return out;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  /** Move a file within the space, never replacing: into the bin, or back. */
  async move(req: { space: string; from: string; to: string; sha256?: string }): Promise<Done> {
    const from = this.resolve(req.space, req.from);
    const to = this.resolve(req.space, req.to, true);
    const { handle, size } = await this.openPlain(from);
    await handle.close().catch(() => undefined);
    try {
      await link(from, to);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') throw new FilesRefusal(FILES_EXISTS, `${to} already exists; nothing is ever replaced.`);
      if (code === 'ENOENT') throw new FilesRefusal(FILES_GONE, `${from} is no longer on this machine.`);
      throw err;
    }
    await unlink(from);
    return { path: to, size, sha256: req.sha256 ?? '' };
  }

  /** Remove a file for good: only ever one in the bin. */
  async purge(req: { space: string; path: string; sha256?: string }): Promise<Done> {
    if (req.path.split('/')[0] !== BIN_DIR || req.path.split('/').length < 2) {
      throw new FilesRefusal(FILES_REFUSED, 'Only a file in the bin is ever removed; move it there first.');
    }
    const path = this.resolve(req.space, req.path);
    const { handle, size } = await this.openPlain(path);
    await handle.close().catch(() => undefined);
    await unlink(path);
    return { path, size, sha256: req.sha256 ?? '' };
  }

  private async openPlain(path: string) {
    let before;
    try { before = lstatSync(path); } catch { throw new FilesRefusal(FILES_GONE, `${path} is no longer on this machine.`); }
    if (before.isSymbolicLink() || !before.isFile()) throw new FilesRefusal(FILES_CHANGED, `${path} is not a plain file any more.`);
    const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const now = await handle.stat();
    if (now.ino !== before.ino || now.dev !== before.dev) {
      await handle.close().catch(() => undefined);
      throw new FilesRefusal(FILES_CHANGED, `${path} was replaced while it was being opened.`);
    }
    return { handle, size: now.size };
  }
}

/** The revision of the space-files frames this bridge speaks, sent as `hello.space_files`. */
export const SPACE_FILES_REVISION = 1;
