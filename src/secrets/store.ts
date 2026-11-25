/**
 * Machine secrets: the bridge's own secret store on this machine (decision
 * 0020, README "Machine secrets", PROTOCOL.md "Secrets on the machine").
 *
 * `~/.ai-bridge/secrets/` (0700), one file per secret named exactly like the
 * secret (0600 from the moment it exists), and `index.json` (0600) holding
 * each secret's description, when it was last written and its end, if any.
 * The folder is the truth about which secrets exist; the index adds words
 * and dates, and the ends that stop a secret, and keeps an expired secret's
 * entry after its file is gone. Because it holds the ends, an index that
 * exists but cannot be read is refused (`store_unavailable`), never read as empty.
 *
 * An end (`ends_at`, `end_kind`) is enforced by `sweep()`, which runs before
 * every read: `expire` removes the value file and keeps the entry with
 * `expired_at`, `delete` removes both. Each end handled leaves an ended record
 * (name, kind, time; never a value) for 30 days, at most 100 of them. The
 * index records an end before the value file is removed, so an interrupted
 * sweep leaves an entry marked ended whose file the next sweep removes.
 *
 * What this module promises about a value:
 *   - it is written with mode 0600 from creation: a temp file opened
 *     O_CREAT|O_EXCL with mode 0600 in the same folder, fsynced, renamed over
 *     the name, so a reader sees the old value or the new one, never half;
 *   - it never appears in an error message, a log line, a listing or an
 *     answer: only `read()` returns one, and only `aib secret run` calls it;
 *   - the folder is refused, never repaired, when it is a symlink, not a
 *     directory, not owned by this user, or open to the group or others.
 */

import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rename, rm, rmdir, unlink, type FileHandle } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The revision of the `secret_*` frames this bridge answers
 * (`hello.machine_secrets.revision`). 2: `secret_put` refuses an existing name
 * with `exists` unless it carries `replace: true`, and its answer says whether
 * a secret was `replaced`. 3: a secret may carry an end (`ends_at`,
 * `end_kind`), `secret_set_end`, and `secret_list` answers the ends and the
 * `ended` records.
 */
export const MACHINE_SECRETS_REVISION = 3;

/** 1 to 64 characters, letter or digit first. JavaScript's `$` does not match before a trailing newline. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
/** The one name in the folder that is not a secret. */
export const INDEX_FILE = 'index.json';
const LOCK_DIR = '.lock';
export const MAX_DESCRIPTION = 1000;
/** The largest value the server may send (`secret_put`). */
export const MAX_FRAME_VALUE_BYTES = 64 * 1024;
/** The largest value `aib secret add` or `import` takes from this machine. */
export const MAX_LOCAL_VALUE_BYTES = 1024 * 1024;
/** A lock older than this was left by a process that died; it is taken over. */
const STALE_LOCK_MS = 30_000;
const LOCK_WAIT_MS = 5_000;
/** How long an ended record is kept, and how many at most. */
export const ENDED_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
export const ENDED_KEEP_MAX = 100;
/** How far ahead an end may be set. */
export const MAX_END_YEARS = 10;
/** An end as the store keeps it: UTC, whole seconds, `Z`. */
const END_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;

export type SecretCode =
  | 'machine_secrets_unsupported'
  | 'store_unavailable'
  | 'not_found'
  | 'invalid_name'
  | 'invalid_request'
  | 'exists'
  | 'invalid_end'
  | 'ended'
  | 'expired'
  | 'timeout'
  | 'failed';

/** A refusal with a code the server and the CLI are told. Its message never holds a value. */
export class SecretRefusal extends Error {
  constructor(public readonly code: SecretCode, message: string) {
    super(message);
    this.name = 'SecretRefusal';
  }
}

export type EndKind = 'expire' | 'delete';

export interface SecretRow {
  name: string;
  description: string | null;
  /** When the value was last written, ISO 8601 UTC. */
  updated_at: string | null;
  /** When the secret ends, ISO 8601 UTC, or null for no end. */
  ends_at: string | null;
  end_kind: EndKind | null;
  /** Set once an `expire` end has passed: the value is gone, the name stays. */
  expired_at: string | null;
}

/** One end the sweep handled. Never a value. */
export interface EndedRecord {
  name: string;
  kind: EndKind;
  ended_at: string;
}

export interface SecretEnd {
  ends_at: string;
  end_kind: EndKind;
}

interface IndexEntry {
  description?: string | null;
  updated_at?: string | null;
  ends_at?: string | null;
  end_kind?: string | null;
  expired_at?: string | null;
}

interface IndexFile {
  secrets: Record<string, IndexEntry>;
  ended: EndedRecord[];
}

export interface MachineSecretStoreOptions {
  /** The clock; for tests. */
  now?: () => Date;
  /** Told about every end the sweep handled (the bridge logs it). */
  onEnd?: (record: EndedRecord) => void;
}

/** `~/.ai-bridge/secrets`, the folder `aib secret` and the bridge share. */
export function defaultSecretsDir(home: string = homedir()): string {
  return join(home, '.ai-bridge', 'secrets');
}

/**
 * Whether `name` may be a secret's name. `index.json` in any case is refused:
 * on a case-insensitive disk (macOS, Windows) `INDEX.json` is the index.
 */
export function isValidName(name: unknown): name is string {
  return typeof name === 'string' && NAME.test(name) && !name.includes('..') && name.toLowerCase() !== INDEX_FILE;
}

/** Control characters a description may not hold: C0 other than tab and newline, DEL, C1. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u;

/** `text` with every control character but tab and newline shown as \u{..}, for a terminal. */
export function printable(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`);
}

/** A name the store may use, or the refusal. */
export function checkName(name: unknown): string {
  if (!isValidName(name)) {
    throw new SecretRefusal(
      'invalid_name',
      'A secret name is 1 to 64 characters: letters, digits, ".", "_" and "-", starting with a letter or digit, without ".." (and not "index.json").',
    );
  }
  return name;
}

/** A description the store may keep, or the refusal. */
export function checkDescription(description: unknown): string {
  if (typeof description !== 'string') throw new SecretRefusal('invalid_request', 'The description must be text.');
  if ([...description].length > MAX_DESCRIPTION) {
    throw new SecretRefusal('invalid_request', `A description is at most ${MAX_DESCRIPTION} characters.`);
  }
  if (CONTROL.test(description)) {
    // A description is printed by `aib secret list`: an escape sequence in it
    // would reach the terminal.
    throw new SecretRefusal('invalid_request', 'A description may not contain control characters (tab and newline are fine).');
  }
  return description;
}

/** A value the store may write, as bytes, or the refusal. Never echoes the value. */
export function checkValue(value: unknown, maxBytes: number): Buffer {
  let bytes: Buffer;
  if (typeof value === 'string') bytes = Buffer.from(value, 'utf8');
  else if (Buffer.isBuffer(value)) bytes = value;
  else throw new SecretRefusal('invalid_request', 'A secret needs a value.');
  if (bytes.length === 0) throw new SecretRefusal('invalid_request', 'A secret needs a value; it is empty.');
  if (bytes.length > maxBytes) {
    throw new SecretRefusal('invalid_request', `A secret value is at most ${Math.floor(maxBytes / 1024)} KiB.`);
  }
  return bytes;
}

/** `date` as the store writes an end: UTC, whole seconds. */
export function formatEnd(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

/**
 * An end the store may set, null for none, or the refusal: both fields or
 * neither, a UTC time in the future and at most MAX_END_YEARS ahead.
 */
export function checkEnd(endsAt: unknown, endKind: unknown, now: Date): SecretEnd | null {
  const noTime = endsAt === undefined || endsAt === null;
  const noKind = endKind === undefined || endKind === null;
  if (noTime && noKind) return null;
  if (noTime || noKind) {
    throw new SecretRefusal('invalid_end', 'An end needs both ends_at and end_kind ("expire" or "delete"), or neither.');
  }
  if (endKind !== 'expire' && endKind !== 'delete') {
    throw new SecretRefusal('invalid_end', 'end_kind must be "expire" or "delete".');
  }
  // The round trip refuses a date that does not exist, such as 30 February.
  if (typeof endsAt !== 'string' || !END_TIME.test(endsAt) || formatEnd(new Date(endsAt)) !== endsAt) {
    throw new SecretRefusal('invalid_end', 'ends_at must be a UTC time in whole seconds, like 2026-12-01T15:00:00Z.');
  }
  const at = Date.parse(endsAt);
  if (at <= now.getTime()) throw new SecretRefusal('invalid_end', 'The end must be in the future.');
  const latest = new Date(now.getTime());
  latest.setUTCFullYear(latest.getUTCFullYear() + MAX_END_YEARS);
  if (at > latest.getTime()) throw new SecretRefusal('invalid_end', `The end may be at most ${MAX_END_YEARS} years ahead.`);
  return { ends_at: endsAt, end_kind: endKind };
}

function endKindOf(entry: IndexEntry): EndKind {
  // An unknown kind in a hand-edited index stops the value rather than deleting the entry.
  return entry.end_kind === 'delete' ? 'delete' : 'expire';
}

function isDue(entry: IndexEntry, now: Date): boolean {
  if (typeof entry.ends_at !== 'string' || typeof entry.expired_at === 'string') return false;
  const at = Date.parse(entry.ends_at);
  return Number.isFinite(at) && at <= now.getTime();
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** The ended records still kept at `now`: the last 30 days, newest 100, oldest first. */
function keptEnded(ended: EndedRecord[], now: Date): EndedRecord[] {
  const since = now.getTime() - ENDED_KEEP_MS;
  return ended
    .filter((r) => Date.parse(r.ended_at) >= since)
    .sort((a, b) => Date.parse(a.ended_at) - Date.parse(b.ended_at))
    .slice(-ENDED_KEEP_MAX);
}

function errno(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

export class MachineSecretStore {
  readonly dir: string;
  private readonly now: () => Date;
  private readonly onEnd: ((record: EndedRecord) => void) | undefined;

  constructor(dir: string = defaultSecretsDir(), options: MachineSecretStoreOptions = {}) {
    this.dir = dir;
    this.now = options.now ?? (() => new Date());
    this.onEnd = options.onEnd;
  }

  /**
   * Handle every end that has passed by `now` and is not handled yet: `expire`
   * removes the value file and keeps the entry with `expired_at`, `delete`
   * removes both. Takes the lock only when something is due. Returns what it ended.
   */
  async sweep(now: Date = this.now()): Promise<EndedRecord[]> {
    if (!(await this.checkDir(false))) return [];
    const { secrets } = await this.readIndex();
    if (!Object.values(secrets).some((entry) => isDue(entry, now)) && !(await this.leftovers(secrets)).length) return [];
    return this.locked(() => this.sweepLocked(now));
  }

  /** The names, descriptions, dates and ends; never a value. Sorted by name. */
  async list(): Promise<SecretRow[]> {
    return (await this.listWithEnded()).secrets;
  }

  /** `list()`, plus the ended records still kept. */
  async listWithEnded(): Promise<{ secrets: SecretRow[]; ended: EndedRecord[] }> {
    const now = this.now();
    await this.sweep(now);
    if (!(await this.checkDir(false))) return { secrets: [], ended: [] };
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      throw new SecretRefusal('store_unavailable', `The secret folder ${this.dir} cannot be read.`);
    }
    const index = await this.readIndex();
    const rows: SecretRow[] = [];
    const seen = new Set<string>();
    for (const name of entries) {
      if (!isValidName(name)) continue; // index.json, dot files, temp files
      let st: Stats;
      try { st = await lstat(join(this.dir, name)); } catch { continue; }
      if (!st.isFile()) continue;
      seen.add(name);
      rows.push(this.row(name, index.secrets[name] ?? {}, st.mtime.toISOString()));
    }
    for (const [name, entry] of Object.entries(index.secrets)) {
      if (!seen.has(name) && typeof entry.expired_at === 'string') rows.push(this.row(name, entry, null));
    }
    rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { secrets: rows, ended: keptEnded(index.ended, now) };
  }

  /** Whether a secret by this name exists (an expired one too: its name is taken). */
  async has(name: unknown): Promise<boolean> {
    const checkedName = checkName(name);
    await this.sweep();
    if (!(await this.checkDir(false))) return false;
    if (await this.existingFile(join(this.dir, checkedName))) return true;
    return typeof (await this.readIndex()).secrets[checkedName]?.expired_at === 'string';
  }

  /**
   * Add a secret, or replace one when `replace` is true. An existing name is
   * refused with `exists` before anything is written; an expired one counts
   * as existing, and replacing it renews it. The end is the one given, or
   * none: a replace without one clears the old end.
   */
  async put(
    name: unknown,
    value: unknown,
    options: {
      replace?: boolean;
      description?: string | null | undefined;
      maxBytes?: number;
      endsAt?: unknown;
      endKind?: unknown;
    } = {},
  ): Promise<{ replaced: boolean }> {
    const checkedName = checkName(name);
    const bytes = checkValue(value, options.maxBytes ?? MAX_FRAME_VALUE_BYTES);
    const description = options.description === undefined || options.description === null || options.description === ''
      ? undefined
      : checkDescription(options.description);
    const end = checkEnd(options.endsAt, options.endKind, this.now());
    await this.checkDir(true);
    return this.locked(async () => {
      await this.sweepLocked(this.now());
      const target = join(this.dir, checkedName);
      const index = await this.readIndex();
      const before = index.secrets[checkedName] ?? {};
      const hadFile = await this.existingFile(target);
      const existed = hadFile || typeof before.expired_at === 'string';
      if (existed && options.replace !== true) {
        throw typeof before.expired_at === 'string'
          ? new SecretRefusal('exists', `"${checkedName}" expired at ${before.expired_at}; replace it to renew it.`)
          : new SecretRefusal('exists', `A secret called "${checkedName}" already exists; replace it deliberately.`);
      }
      // `Foo` beside `foo` is one file on a case-insensitive disk, where a
      // replace of `Foo` would overwrite `foo`: refused either way.
      const expiredNames = Object.entries(index.secrets).filter(([, e]) => typeof e.expired_at === 'string').map(([n]) => n);
      const names = [...await readdir(this.dir), ...expiredNames];
      if (!names.includes(checkedName)) {
        const twin = names.find((n) => n.toLowerCase() === checkedName.toLowerCase());
        if (twin) throw new SecretRefusal('exists', `"${checkedName}" differs from the existing "${twin}" only in case; pick another name.`);
      }
      await this.writeAtomic(target, bytes);
      index.secrets[checkedName] = {
        // A replace without a description keeps the one it had.
        description: description ?? (existed ? before.description ?? null : null),
        updated_at: this.now().toISOString(),
        ...(end ?? {}),
      };
      try {
        await this.writeIndex(index);
      } catch (err) {
        // A new value must not stay behind without its end; a replace keeps its old index entry.
        if (!hadFile) await unlink(target).catch(() => undefined);
        throw err;
      }
      return { replaced: existed };
    });
  }

  /**
   * Set or clear a secret's end (`endsAt` null clears it). Refused with
   * `not_found` when there is no such secret and `ended` when it already
   * expired. The value and the description are left as they are.
   */
  async setEnd(name: unknown, endsAt: unknown, endKind?: unknown): Promise<void> {
    const checkedName = checkName(name);
    if (endsAt === undefined) {
      throw new SecretRefusal('invalid_end', 'Setting an end needs ends_at: a time, or null to remove the end.');
    }
    const end = endsAt === null ? null : checkEnd(endsAt, endKind, this.now());
    if (!(await this.checkDir(false))) throw this.notFound(checkedName);
    await this.locked(async () => {
      await this.sweepLocked(this.now());
      const index = await this.readIndex();
      const entry = index.secrets[checkedName];
      if (typeof entry?.expired_at === 'string') throw this.alreadyExpired(checkedName);
      if (!(await this.existingFile(join(this.dir, checkedName)))) throw this.notFound(checkedName);
      const next: IndexEntry = { ...(entry ?? {}) };
      delete next.ends_at;
      delete next.end_kind;
      index.secrets[checkedName] = { ...next, ...(end ?? {}) };
      await this.writeIndex(index);
    });
  }

  /** Change a secret's description; an empty text clears it. */
  async describe(name: unknown, description: unknown): Promise<void> {
    const checkedName = checkName(name);
    const text = checkDescription(description);
    if (!(await this.checkDir(false))) throw this.notFound(checkedName);
    await this.locked(async () => {
      await this.sweepLocked(this.now());
      const index = await this.readIndex();
      const expired = typeof index.secrets[checkedName]?.expired_at === 'string';
      if (!expired && !(await this.existingFile(join(this.dir, checkedName)))) throw this.notFound(checkedName);
      index.secrets[checkedName] = { ...(index.secrets[checkedName] ?? {}), description: text === '' ? null : text };
      await this.writeIndex(index);
    });
  }

  /** Remove a secret and its index entry (an expired one too). */
  async remove(name: unknown): Promise<void> {
    const checkedName = checkName(name);
    if (!(await this.checkDir(false))) throw this.notFound(checkedName);
    await this.locked(async () => {
      await this.sweepLocked(this.now());
      const target = join(this.dir, checkedName);
      const index = await this.readIndex();
      const expired = typeof index.secrets[checkedName]?.expired_at === 'string';
      const file = await this.existingFile(target);
      if (!file && !expired) throw this.notFound(checkedName);
      if (file) await unlink(target);
      if (checkedName in index.secrets) {
        delete index.secrets[checkedName];
        await this.writeIndex(index);
      }
    });
  }

  /** The path of a secret's file, after checking it exists and has not expired. */
  async path(name: unknown): Promise<string> {
    const checkedName = checkName(name);
    await this.sweep();
    if (!(await this.checkDir(false))) throw this.notFound(checkedName);
    const expiredAt = (await this.readIndex()).secrets[checkedName]?.expired_at;
    if (typeof expiredAt === 'string') {
      throw new SecretRefusal(
        'expired',
        `The secret "${checkedName}" expired at ${expiredAt} and can no longer be used. Ask the person to renew it with the secret card. On this machine: aib secret add ${checkedName} --replace.`,
      );
    }
    const target = join(this.dir, checkedName);
    if (!(await this.existingFile(target))) throw this.notFound(checkedName);
    return target;
  }

  /**
   * A secret's value. For `aib secret run` only: nothing that answers the
   * server reads a value. Opened without following a symlink.
   */
  async read(name: unknown): Promise<Buffer> {
    const target = await this.path(name);
    let fh: FileHandle;
    try {
      fh = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (err) {
      // An end that passed between the check and the open: say expired or not found, as path() does.
      if (errno(err) === 'ENOENT') await this.path(name);
      throw new SecretRefusal('store_unavailable', `The secret "${String(name)}" cannot be opened.`);
    }
    try {
      return await fh.readFile();
    } finally {
      await fh.close();
    }
  }

  /**
   * Refuse a folder that is not safe to keep secrets in. With `create`, make
   * `~/.ai-bridge` and the folder (0700) when they are missing. Returns
   * whether the folder exists.
   */
  private async checkDir(create: boolean): Promise<boolean> {
    let st: Stats;
    try {
      st = await lstat(this.dir);
    } catch (err) {
      if (errno(err) !== 'ENOENT') throw new SecretRefusal('store_unavailable', `The secret folder ${this.dir} cannot be read.`);
      if (!create) return false;
      try {
        await mkdir(this.dir, { recursive: true, mode: 0o700 });
        st = await lstat(this.dir);
      } catch {
        throw new SecretRefusal('store_unavailable', `The secret folder ${this.dir} cannot be created.`);
      }
    }
    if (st.isSymbolicLink()) {
      throw new SecretRefusal('store_unavailable', `The secret folder ${this.dir} is a symlink; refusing to use it.`);
    }
    if (!st.isDirectory()) throw new SecretRefusal('store_unavailable', `The secret folder ${this.dir} is not a directory.`);
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (uid !== undefined && st.uid !== uid) {
      throw new SecretRefusal('store_unavailable', `The secret folder ${this.dir} is not owned by this user; refusing to use it.`);
    }
    if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
      throw new SecretRefusal(
        'store_unavailable',
        `The secret folder ${this.dir} is open to other users (mode ${(st.mode & 0o777).toString(8)}); run chmod 700 on it.`,
      );
    }
    return true;
  }

  private async existingFile(target: string): Promise<boolean> {
    let st: Stats;
    try {
      st = await lstat(target);
    } catch {
      return false;
    }
    if (!st.isFile()) throw new SecretRefusal('store_unavailable', `${target} is not a regular file; remove it by hand.`);
    return true;
  }

  private notFound(name: string): SecretRefusal {
    return new SecretRefusal('not_found', `No secret called "${name}".`);
  }

  private alreadyExpired(name: string): SecretRefusal {
    return new SecretRefusal(
      'ended',
      `The secret "${name}" has already expired; replace it to renew it (on this machine: aib secret add ${name} --replace).`,
    );
  }

  private row(name: string, entry: IndexEntry, mtime: string | null): SecretRow {
    const endsAt = stringOrNull(entry.ends_at);
    return {
      name,
      description: stringOrNull(entry.description),
      updated_at: typeof entry.updated_at === 'string' ? entry.updated_at : mtime,
      ends_at: endsAt,
      end_kind: endsAt === null ? null : endKindOf(entry),
      expired_at: stringOrNull(entry.expired_at),
    };
  }

  /**
   * The entries already marked ended (`expired_at`) that still need work: a
   * value file left by an interrupted sweep, or a `delete` entry not yet removed.
   */
  private async leftovers(secrets: Record<string, IndexEntry>): Promise<string[]> {
    const names: string[] = [];
    for (const [name, entry] of Object.entries(secrets)) {
      if (typeof entry.expired_at !== 'string') continue;
      if (endKindOf(entry) === 'delete') { names.push(name); continue; }
      const st = await lstat(join(this.dir, name)).catch(() => null);
      if (st?.isFile()) names.push(name);
    }
    return names;
  }

  /**
   * The sweep, with the lock held. First the index records every end that
   * passed (marked `expired_at`, plus its ended record), then the value files
   * go and `delete` entries are removed. Writes the index only when it changed.
   */
  private async sweepLocked(now: Date): Promise<EndedRecord[]> {
    const index = await this.readIndex();
    const done: EndedRecord[] = [];
    let changed = false;
    for (const [name, entry] of Object.entries(index.secrets)) {
      if (!isDue(entry, now)) continue;
      let st: Stats | null = null;
      try { st = await lstat(join(this.dir, name)); } catch { /* no file */ }
      if (st && !st.isFile()) continue; // path() refuses it as store_unavailable
      changed = true;
      if (!st) {
        // The file was removed by hand: the folder says the secret is gone, so is its entry.
        delete index.secrets[name];
        continue;
      }
      const endedAt = entry.ends_at as string;
      index.secrets[name] = { ...entry, expired_at: endedAt };
      done.push({ name, kind: endKindOf(entry), ended_at: endedAt });
    }
    if (done.length) index.ended = keptEnded([...index.ended, ...done], now);
    if (changed) await this.writeIndex(index);
    let removed = false;
    for (const name of await this.leftovers(index.secrets)) {
      const target = join(this.dir, name);
      const st = await lstat(target).catch(() => null);
      if (st?.isFile()) await unlink(target);
      if (endKindOf(index.secrets[name]!) === 'delete') {
        delete index.secrets[name];
        removed = true;
      }
    }
    if (removed) await this.writeIndex(index);
    for (const record of done) this.onEnd?.(record);
    return done;
  }

  /** Temp file 0600 with O_EXCL in the same folder, fsync, rename. */
  private async writeAtomic(target: string, bytes: Buffer): Promise<void> {
    const tmp = join(this.dir, `.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
    let fh: FileHandle | undefined;
    try {
      fh = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await fh.writeFile(bytes);
      await fh.sync();
      await fh.close();
      fh = undefined;
      await rename(tmp, target);
    } catch (err) {
      if (fh !== undefined) { try { await fh.close(); } catch { /* already closed */ } }
      try { await unlink(tmp); } catch { /* never created, or renamed */ }
      throw new SecretRefusal('failed', `Could not write to the secret folder ${this.dir} (${errno(err) ?? 'error'}).`);
    }
    try {
      const dir = await open(this.dir, constants.O_RDONLY);
      try { await dir.sync(); } finally { await dir.close(); }
    } catch { /* not every platform fsyncs a directory */ }
  }

  private async readIndex(): Promise<IndexFile> {
    // No prototype: a secret may be called "constructor".
    const out: IndexFile = { secrets: Object.create(null) as Record<string, IndexEntry>, ended: [] };
    let text: string;
    try {
      text = await readFile(join(this.dir, INDEX_FILE), 'utf8');
    } catch (err) {
      if (errno(err) === 'ENOENT') return out;
      throw this.damagedIndex();
    }
    let parsed: { secrets?: unknown; ended?: unknown };
    try {
      parsed = JSON.parse(text) as { secrets?: unknown; ended?: unknown };
    } catch {
      throw this.damagedIndex();
    }
    // The index holds the ends: one that cannot be read must not let every secret go endless.
    const isObject = (v: unknown): boolean => typeof v === 'object' && v !== null && !Array.isArray(v);
    if (!isObject(parsed) || (parsed.secrets !== undefined && !isObject(parsed.secrets))) throw this.damagedIndex();
    for (const [name, entry] of Object.entries((parsed.secrets ?? {}) as Record<string, unknown>)) {
      if (isValidName(name) && typeof entry === 'object' && entry !== null) out.secrets[name] = entry as IndexEntry;
    }
    if (Array.isArray(parsed.ended)) {
      for (const r of parsed.ended as Array<Partial<EndedRecord> | null>) {
        if (r && isValidName(r.name) && (r.kind === 'expire' || r.kind === 'delete')
          && typeof r.ended_at === 'string' && Number.isFinite(Date.parse(r.ended_at))) {
          out.ended.push({ name: r.name, kind: r.kind, ended_at: r.ended_at });
        }
      }
    }
    return out;
  }

  private damagedIndex(): SecretRefusal {
    return new SecretRefusal(
      'store_unavailable',
      `The index ${join(this.dir, INDEX_FILE)} cannot be read; no secret is used until it is fixed or removed by hand (removing it drops every description and end).`,
    );
  }

  private async writeIndex(index: IndexFile): Promise<void> {
    const sorted = Object.create(null) as Record<string, IndexEntry>;
    for (const name of Object.keys(index.secrets).sort()) sorted[name] = index.secrets[name]!;
    const body = { version: 1, secrets: sorted, ...(index.ended.length ? { ended: index.ended } : {}) };
    await this.writeAtomic(join(this.dir, INDEX_FILE), Buffer.from(`${JSON.stringify(body, null, 2)}\n`));
  }

  /**
   * One writer at a time across processes (the bridge and `aib secret`): a
   * lock directory, taken over when it is older than STALE_LOCK_MS. A takeover
   * renames the stale lock away first and checks it moved the lock it found
   * stale (by inode), putting back one that another process made in between.
   * Release removes the lock only while it is still this process's own.
   * Holding a lock takes milliseconds; the stale case is a process that died
   * holding it.
   */
  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    const lock = join(this.dir, LOCK_DIR);
    const deadline = Date.now() + LOCK_WAIT_MS;
    let mine: number;
    for (;;) {
      try {
        await mkdir(lock, { mode: 0o700 });
        mine = (await lstat(lock)).ino;
        break;
      } catch (err) {
        if (errno(err) !== 'EEXIST') throw new SecretRefusal('failed', `Could not lock the secret folder ${this.dir}.`);
        try {
          const held = await lstat(lock);
          if (Date.now() - held.mtimeMs > STALE_LOCK_MS) {
            const away = `${lock}-stale-${randomBytes(6).toString('hex')}`;
            await rename(lock, away);
            if ((await lstat(away)).ino !== held.ino) {
              // Another process took the stale lock over first: give its lock back.
              await rename(away, lock).catch(() => undefined);
            } else {
              await rm(away, { recursive: true, force: true });
            }
            continue;
          }
        } catch { continue; }
        if (Date.now() > deadline) {
          throw new SecretRefusal('failed', `The secret folder ${this.dir} is busy (${lock} is held); try again.`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      return await fn();
    } finally {
      try {
        if ((await lstat(lock)).ino === mine) await rmdir(lock);
      } catch { /* taken over as stale */ }
    }
  }
}
