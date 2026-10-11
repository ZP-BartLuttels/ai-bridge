/**
 * Files this machine will hand back to the server, and the only way it will.
 *
 * The rule is the whole design: the bridge serves a file ONLY if it recorded
 * that file itself — one it received into `file-uploads/`, or one the
 * assistant handed back — and it finds it by an id it minted, never by a path
 * the server sends. A server can name an id; it cannot name a file. So a
 * compromised server that asks for `~/.ssh/id_ed25519` has nothing to ask with.
 *
 * (The older `attachment_read` frame took a path from the server and resolved
 * it against the working directory. It is refused now; see bridge.ts.)
 *
 * The record is checked again every time it is served: the path must still be
 * a regular file (lstat, so a symlink put there since is refused), opened
 * without following links, the same inode that was checked, and the size that
 * was recorded. A file edited or replaced since it was sent is reported as
 * such rather than served as if it were the one in the chat.
 */

import { randomUUID } from 'node:crypto';
import { constants as fsConstants, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Served');

/** Codes a refused `file_read` carries. */
export const FILE_UNKNOWN = 'file_unknown';
export const FILE_GONE = 'file_gone';
export const FILE_CHANGED = 'file_changed';

/** How many records are kept; oldest go first. A record is ~200 bytes. */
const DEFAULT_CAPACITY = 20_000;

export interface ServedFile {
  path: string;
  size: number;
  /** `upload`: a person sent it here. `handed_back`: the assistant offered it. `space_file`: one of a space's kept files, opened for a person (spacefiles/store.ts). */
  source: 'upload' | 'handed_back' | 'space_file';
  recorded_at: string;
}

/** A refusal with the sentence a person reads. */
export class FileReadRefusal extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'FileReadRefusal';
  }
}

/**
 * The record, persisted so a file sent last week can still be fetched after a
 * restart. `null` store path keeps it in memory only (tests, and a bridge with
 * no writable cache).
 */
export class ServedFiles {
  private readonly map = new Map<string, ServedFile>();

  constructor(private readonly storePath: string | null = null, private readonly capacity = DEFAULT_CAPACITY) {
    this.load();
  }

  /** Remember a file this bridge put in place or handed back. Returns its id. */
  record(path: string, size: number, source: ServedFile['source']): string {
    const id = randomUUID();
    this.map.set(id, { path, size, source, recorded_at: new Date().toISOString() });
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
    this.save();
    return id;
  }

  get(id: string): ServedFile | undefined {
    return typeof id === 'string' ? this.map.get(id) : undefined;
  }

  get size(): number {
    return this.map.size;
  }

  private load(): void {
    if (this.storePath === null) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.storePath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
        const r = v as Partial<ServedFile>;
        if (typeof r?.path === 'string' && typeof r.size === 'number'
          && (r.source === 'upload' || r.source === 'handed_back' || r.source === 'space_file')) {
          this.map.set(id, { path: r.path, size: r.size, source: r.source, recorded_at: String(r.recorded_at ?? '') });
        }
      }
    } catch {
      // Missing or corrupt: an empty record, which only means older files
      // cannot be fetched. Never a reason not to start.
    }
  }

  private save(): void {
    if (this.storePath === null) return;
    try {
      mkdirSync(dirname(this.storePath), { recursive: true, mode: 0o700 });
      const tmp = `${this.storePath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.map)), { mode: 0o600 });
      renameSync(tmp, this.storePath);
    } catch (err) {
      log.warn('Could not persist the served-files record', { error: err instanceof Error ? err.message : String(err) });
    }
  }
}

/** A byte range, resolved against the file's real size. */
export interface Resolved {
  status: 200 | 206 | 416;
  start: number;
  /** Inclusive. -1 for an empty file. */
  end: number;
}

/**
 * One `Range` header, as a browser sends it for seeking or resuming.
 *
 * A single range is honoured. Anything else — several ranges, a unit other
 * than bytes, nonsense — gets the whole file, which the HTTP spec allows. A
 * range starting at or past the end is 416.
 */
export function resolveRange(header: string | undefined | null, size: number): Resolved {
  const whole: Resolved = { status: 200, start: 0, end: size - 1 };
  if (!header) return whole;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return whole;
  if (m[1] === '') {
    const n = Number(m[2]);
    // An empty file has no last N bytes to give, and a 206 with nothing in it
    // is not a valid answer: RFC 9110 says 416 when no range can be satisfied.
    if (n === 0 || size === 0) return { status: 416, start: 0, end: -1 };
    return { status: 206, start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  if (start >= size) return { status: 416, start: 0, end: -1 };
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (end < start) return whole;
  return { status: 206, start, end };
}

/**
 * Open a recorded file for serving, after checking it is still what was
 * recorded. The handle is the caller's to close.
 */
export async function openRecorded(files: ServedFiles, fileId: string): Promise<{ handle: FileHandle; file: ServedFile }> {
  const file = files.get(fileId);
  if (!file) {
    throw new FileReadRefusal(FILE_UNKNOWN,
      'This machine has no record of sending or receiving that file, so it will not hand it over. '
      + 'It may have been sent before this bridge kept records, or by another installation.');
  }
  let before;
  try {
    before = lstatSync(file.path);
  } catch {
    throw new FileReadRefusal(FILE_GONE, `The file is no longer on this machine (${file.path} is gone).`);
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new FileReadRefusal(FILE_CHANGED,
      `${file.path} has been replaced by something that is not a plain file since it was sent, so it is not handed over.`);
  }
  let handle: FileHandle;
  try {
    // O_NOFOLLOW: a symlink swapped in between the lstat and here is refused
    // by the open itself.
    handle = await open(file.path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch {
    throw new FileReadRefusal(FILE_GONE, `The file could not be opened on this machine (${file.path}).`);
  }
  try {
    const now = await handle.stat();
    if (!now.isFile() || now.ino !== before.ino || now.dev !== before.dev) {
      throw new FileReadRefusal(FILE_CHANGED, `${file.path} was replaced while it was being opened.`);
    }
    if (now.size !== file.size) {
      throw new FileReadRefusal(FILE_CHANGED,
        `${file.path} has changed since it was sent: it is ${now.size} bytes now and was ${file.size}. `
        + 'Open it on the machine itself.');
    }
  } catch (err) {
    await handle.close().catch(() => undefined);
    throw err;
  }
  return { handle, file };
}
