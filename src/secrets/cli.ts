/**
 * `aib secret ...`: the machine's own commands for the secret store
 * (src/secrets/store.ts, decision 0020). They work whether or not a bridge
 * runs with --machine-secrets: that flag only decides whether a SERVER may
 * manage the store. No command here prints a value.
 */

import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import {
  MAX_LOCAL_VALUE_BYTES, SecretRefusal, MachineSecretStore, checkEnd, checkValue, formatEnd, isValidName, printable,
  type EndKind, type SecretRow,
} from './store.js';
import { checkEnvName, runWithSecret } from './run.js';
import { listBridges } from '../service/index.js';

/** One line on whether any installed bridge lets its server manage the store. */
function serverAccessLine(): string {
  let names: string[] = [];
  try {
    names = listBridges().filter((b) => b.machineSecrets).map((b) => b.name);
  } catch { /* no installed bridges to ask */ }
  return names.length
    ? `Machine secrets: on for ${names.join(', ')} (that server may list, add, replace, describe, set an end and remove; never read).`
    : 'Machine secrets: off (no installed bridge has --machine-secrets; only this machine manages the store).';
}

/** Exit codes besides 1: a missing secret, and one whose end has passed. */
export const EXIT_NOT_FOUND = 2;
export const EXIT_EXPIRED = 4;

function fail(err: unknown): never {
  console.error(err instanceof Error ? err.message : String(err));
  const code = err instanceof SecretRefusal ? err.code : undefined;
  process.exit(code === 'not_found' ? EXIT_NOT_FOUND : code === 'expired' ? EXIT_EXPIRED : 1);
}

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** `<n>(m|h|d|w)` from `now`, rounded up to the next whole second. */
export function endIn(text: string, now: Date = new Date()): string {
  const match = /^([1-9][0-9]{0,5})([mhdw])$/u.exec(text);
  if (!match) throw new SecretRefusal('invalid_end', `"${text}" is not a duration: a number and m, h, d or w (30m, 8h, 2d, 1w).`);
  return formatEnd(new Date(Math.ceil((now.getTime() + Number(match[1]) * UNIT_MS[match[2]!]!) / 1000) * 1000));
}

/** `YYYY-MM-DDTHH:MM:SS`, optional fraction, then `Z` or `+HH:MM` / `-HH:MM`. */
const TIME_WITH_ZONE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/u;

/**
 * An ISO time with a zone (`Z` or `+01:00`) as the store's UTC form; whole
 * seconds only. A date or time that does not exist (30 February, 24:00,
 * minute 60, a zone of +25:00) is refused, never rolled over.
 */
export function endAt(text: string): string {
  const bad = (): SecretRefusal => new SecretRefusal(
    'invalid_end', `"${text}" is not a time with a zone, like 2026-12-01T15:00:00Z or 2026-12-01T16:00:00+01:00.`,
  );
  const m = TIME_WITH_ZONE.exec(text);
  if (!m) throw bad();
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59) throw bad();
  if (m[8] !== undefined && (Number(m[9]) > 23 || Number(m[10]) > 59)) throw bad();
  if (m[7] !== undefined && !/^\.0+$/u.test(m[7])) throw new SecretRefusal('invalid_end', 'An end is in whole seconds.');
  const offsetMs = m[8] === undefined ? 0 : (m[8] === '-' ? -1 : 1) * (Number(m[9]) * 60 + Number(m[10])) * 60_000;
  return formatEnd(new Date(Date.UTC(year, month - 1, day, hour, minute, second) - offsetMs));
}

/** An end as a put writes it. */
type End = { endsAt: string; endKind: EndKind };

/**
 * A replace must state its end: an end flag, or --no-end for none. Nothing of
 * the old end is kept, so a forgotten flag can neither make a short-lived
 * secret permanent nor leave an old end on a new value. One rule for `add`
 * and `import`, checked before anything is read.
 */
function requireEndOnReplace(replace: boolean, given: End | null, noEnd: boolean, what: string): void {
  if (replace && !given && !noEnd) {
    throw new SecretRefusal(
      'end_required',
      `${what} must state its end: add --ends-in <duration> or --ends-at <time> (with --delete-at-end to delete it at the end), or --no-end for none. Nothing was changed.`,
    );
  }
}

/** The words `add` and `import` print for the end a put wrote. */
function endPutWords(end: End | null, replaced: boolean): string {
  if (end) return `it ${end.endKind === 'delete' ? 'is deleted' : 'expires'} ${shownTime(end.endsAt)}`;
  return replaced ? 'it has no end' : '';
}

/** The kind from --delete-at-end / --expire, and whether --no-end was given; contradictions refused. */
function endOptions(opts: { endsIn?: string; endsAt?: string; deleteAtEnd?: boolean; expire?: boolean; end: boolean }): { kind: EndKind | undefined; noEnd: boolean } {
  if (opts.deleteAtEnd && opts.expire) throw new SecretRefusal('invalid_end', 'Choose --delete-at-end or --expire, not both.');
  const kind: EndKind | undefined = opts.deleteAtEnd ? 'delete' : opts.expire ? 'expire' : undefined;
  const noEnd = opts.end === false;
  if (noEnd && (opts.endsIn !== undefined || opts.endsAt !== undefined || kind !== undefined)) {
    throw new SecretRefusal('invalid_end', '--no-end removes the end; it takes no time and no kind.');
  }
  return { kind, noEnd };
}

/** The end and kind from `--in`/`--ends-in` or `--at`/`--ends-at` and the kind flags, or null for none. */
function endFromFlags(
  inText: string | undefined, atText: string | undefined, kind: EndKind | undefined,
  flags = '--ends-in <duration> or --ends-at <time>',
): End | null {
  if (inText !== undefined && atText !== undefined) throw new SecretRefusal('invalid_end', 'Give the end once: a duration or a time, not both.');
  if (inText === undefined && atText === undefined) {
    if (kind !== undefined) throw new SecretRefusal('invalid_end', `What happens at the end needs an end: add ${flags}.`);
    return null;
  }
  return { endsAt: inText !== undefined ? endIn(inText) : endAt(atText!), endKind: kind ?? 'expire' };
}

/** A stored UTC time as `aib secret` prints it: `2026-12-01 15:00:00 UTC`. */
function shownTime(iso: string): string {
  return `${iso.slice(0, 19).replace('T', ' ')} UTC`;
}

/** An end in words: `expires <time>` or `deleted <time>`. */
function endWords(endsAt: string, kind: EndKind | null): string {
  return `${kind === 'delete' ? 'deleted' : 'expires'} ${shownTime(endsAt)}`;
}

/** The end column of `aib secret list`: empty, `expires <time>`, `deleted <time>` or `expired <time>`. */
function endColumn(row: SecretRow): string {
  if (row.expired_at) return `expired ${shownTime(row.expired_at)}`;
  if (row.ends_at) return endWords(row.ends_at, row.end_kind);
  return '';
}

/** Whichever of two spellings of one option was given; both is refused. */
function oneOf(a: string | undefined, b: string | undefined, names: string): string | undefined {
  if (a !== undefined && b !== undefined) throw new SecretRefusal('invalid_end', `Give ${names} once.`);
  return a ?? b;
}

/**
 * The value from stdin. Piped: everything, less ONE trailing newline (what
 * `echo` and most editors add). A terminal: one line, not echoed.
 */
async function readValueFromStdin(): Promise<Buffer> {
  const stdin = process.stdin;
  if (stdin.isTTY) return readHiddenLine();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stdin) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > MAX_LOCAL_VALUE_BYTES + 2) throw new SecretRefusal('invalid_request', `A secret value is at most ${MAX_LOCAL_VALUE_BYTES / 1024} KiB.`);
    chunks.push(buf);
  }
  let value = Buffer.concat(chunks);
  if (value.length && value[value.length - 1] === 0x0a) {
    value = value.subarray(0, value.length - (value.length > 1 && value[value.length - 2] === 0x0d ? 2 : 1));
  }
  return value;
}

/**
 * A value from a file: a regular file (not a device or a FIFO, which could
 * be read without end), size checked before it is read.
 */
async function readValueFile(path: string): Promise<Buffer> {
  const st = await lstat(path).catch(() => null);
  if (!st) throw new Error(`${path} does not exist`);
  if (!st.isFile()) throw new Error(`${path} is not a regular file`);
  if (st.size > MAX_LOCAL_VALUE_BYTES) throw new SecretRefusal('invalid_request', `A secret value is at most ${MAX_LOCAL_VALUE_BYTES / 1024} KiB.`);
  return readFile(path);
}

/** One line for a terminal: control characters shown escaped, newlines as spaces. */
function oneLine(text: string): string {
  return printable(text).replace(/[\r\n\t]+/g, ' ');
}

function readHiddenLine(): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const stdin = process.stdin;
    process.stderr.write('Value (not shown, Enter to finish): ');
    const bytes: number[] = [];
    stdin.setRawMode(true);
    stdin.resume();
    const finish = (err?: Error): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stderr.write('\n');
      if (err) reject(err);
      else resolvePromise(Buffer.from(bytes));
    };
    const onData = (chunk: Buffer): void => {
      for (const byte of chunk) {
        if (byte === 0x0d || byte === 0x0a) return finish();
        if (byte === 0x03 || byte === 0x04) return finish(new Error('Cancelled; nothing was saved.'));
        if (byte === 0x7f || byte === 0x08) {
          // One character, which in UTF-8 may be several bytes: its continuation bytes, then its lead.
          while (bytes.length && (bytes[bytes.length - 1]! & 0xc0) === 0x80) bytes.pop();
          bytes.pop();
          continue;
        }
        bytes.push(byte);
      }
    };
    stdin.on('data', onData);
  });
}

export interface ImportReport {
  imported: string[];
  skipped: Array<{ name: string; reason: string }>;
  /** The end each imported secret got (or, on a replace, that it has none), as `add` words it. */
  ends: Array<{ name: string; words: string }>;
}

/**
 * Copy a folder of one-file-per-secret into the store, with descriptions from
 * an optional `.desc/<name>` folder beside them. Dot files are skipped, and
 * so is anything that is not a regular file. The folder is only read.
 */
export interface ImportEnd {
  endsIn?: string;
  endsAt?: string;
  kind?: EndKind;
  /** No end. With replace, this or an end is required (`end_required`). */
  noEnd?: boolean;
}

export async function importFolder(
  store: MachineSecretStore, folder: string, options: { replace?: boolean; end?: ImportEnd } = {},
): Promise<ImportReport> {
  const replace = !!options.replace;
  const { endsIn, endsAt, kind, noEnd = false } = options.end ?? {};
  const root = resolve(folder);
  const st = await lstat(root).catch(() => null);
  if (!st || !st.isDirectory()) throw new Error(`${root} is not a folder`);
  const report: ImportReport = { imported: [], skipped: [], ends: [] };
  const given = endFromFlags(endsIn, endsAt, kind);
  requireEndOnReplace(replace, given, noEnd, 'Importing with --replace');
  if (given) checkEnd(given.endsAt, given.endKind, new Date());
  for (const name of (await readdir(root)).sort()) {
    if (name.startsWith('.')) continue;
    const path = join(root, name);
    const entry = await lstat(path);
    if (!entry.isFile()) {
      report.skipped.push({ name, reason: entry.isSymbolicLink() ? 'a symlink' : 'not a regular file' });
      continue;
    }
    if (!isValidName(name)) {
      report.skipped.push({ name, reason: 'not a valid secret name' });
      continue;
    }
    let description: string | undefined;
    const descPath = join(root, '.desc', name);
    const desc = await lstat(descPath).catch(() => null);
    if (desc?.isFile() && desc.size <= 64 * 1024) {
      description = (await readFile(descPath, 'utf8')).trim() || undefined;
    }
    try {
      const value = checkValue(await readValueFile(path), MAX_LOCAL_VALUE_BYTES);
      const { replaced } = await store.put(name, value, {
        replace, description, maxBytes: MAX_LOCAL_VALUE_BYTES,
        // A replace states its end every time: the given one, or null for none.
        endsAt: given?.endsAt ?? (replace ? null : undefined), endKind: given?.endKind,
      });
      report.imported.push(name);
      const said = endPutWords(given, replaced);
      if (said) report.ends.push({ name, words: said });
    } catch (err) {
      if (err instanceof SecretRefusal) {
        report.skipped.push({ name, reason: err.code === 'exists' ? 'exists (use --replace)' : err.message });
      } else {
        report.skipped.push({ name, reason: 'could not be read' });
      }
    }
  }
  return report;
}

export function registerSecretCommands(program: Command, storeFor: () => MachineSecretStore = () => new MachineSecretStore()): void {
  const secret = program
    .command('secret')
    .description('The secret store on this machine (~/.ai-bridge/secrets): add, describe, set when one ends, remove, run a command with one. Never prints a value.');

  secret
    .command('list')
    .description('Names, descriptions, when each was written and when each ends (never a value)')
    .action(async () => {
      try {
        const store = storeFor();
        const { secrets: rows, ended } = await store.listWithEnded();
        if (!rows.length) {
          console.log(`No secrets in ${store.dir}. \`aib secret add <name>\` adds one (the value from stdin).`);
        } else {
          const width = Math.max(...rows.map((r) => r.name.length), 4);
          const ends = rows.map(endColumn);
          const endWidth = Math.max(...ends.map((e) => e.length));
          rows.forEach((r, i) => {
            const end = endWidth ? `  ${ends[i]!.padEnd(endWidth)}` : '';
            console.log(`${r.name.padEnd(width)}  ${r.updated_at ? shownTime(r.updated_at) : ''}${end}  ${oneLine(r.description ?? '')}`.trimEnd());
          });
        }
        for (const r of ended) {
          console.error(`Ended: ${r.name} ${r.kind === 'delete' ? 'deleted' : 'expired'} at ${shownTime(r.ended_at)}.`);
        }
        console.error(serverAccessLine());
      } catch (err) { fail(err); }
    });

  secret
    .command('add')
    .description('Add a secret; the value is read from stdin (or --from-file), never from an argument')
    .argument('<name>', 'Letters, digits, ".", "_" and "-", starting with a letter or digit')
    .option('--description <text>', 'What it is for')
    .option('--replace', 'Overwrite a secret of the same name; needs an end flag or --no-end (the old end is not kept)')
    .option('--from-file <path>', 'Read the value from this file, as it is')
    .option('--ends-in <n>', 'End it after a while: a number and m, h, d or w (30m, 8h, 2d, 1w)')
    .option('--ends-at <time>', 'End it at this time, with a zone (2026-12-01T15:00:00Z)')
    .option('--delete-at-end', 'At the end delete it altogether (without this it expires: the value goes, the name stays)')
    .option('--expire', 'At the end only remove the value (the default)')
    .option('--no-end', 'No end (with --replace: say so deliberately; any end it had is removed)')
    .action(async (name: string, opts: {
      description?: string; replace?: boolean; fromFile?: string; endsIn?: string; endsAt?: string;
      deleteAtEnd?: boolean; expire?: boolean; end: boolean;
    }) => {
      try {
        const store = storeFor();
        const { kind, noEnd } = endOptions(opts);
        // Refuse a bad end, a missing one and a taken name before asking for the value.
        const given = endFromFlags(opts.endsIn, opts.endsAt, kind);
        requireEndOnReplace(!!opts.replace, given, noEnd, `Replacing "${name}"`);
        if (given) checkEnd(given.endsAt, given.endKind, new Date());
        if (!opts.replace) {
          const current = (await store.list()).find((r) => r.name === name);
          if (current?.expired_at) {
            throw new SecretRefusal('exists', `"${name}" expired at ${shownTime(current.expired_at)}; add --replace to renew it.`);
          }
          if (await store.has(name)) throw new SecretRefusal('exists', `A secret called "${name}" already exists; add --replace to overwrite it.`);
        }
        const value = opts.fromFile !== undefined ? await readValueFile(resolve(opts.fromFile)) : await readValueFromStdin();
        // A duration counts from when the value was entered, not from when the command started.
        const end = given && opts.endsIn !== undefined ? { ...given, endsAt: endIn(opts.endsIn) } : given;
        const { replaced } = await store.put(name, value, {
          replace: !!opts.replace, description: opts.description, maxBytes: MAX_LOCAL_VALUE_BYTES,
          // A replace states its end every time: the given one, or null for none.
          endsAt: end?.endsAt ?? (opts.replace ? null : undefined), endKind: end?.endKind,
        });
        const said = endPutWords(end, replaced);
        console.log(`${replaced ? 'Replaced' : 'Added'} "${name}" (${value.length} bytes) in ${store.dir}${said ? `; ${said}` : ''}.`);
      } catch (err) { fail(err); }
    });

  secret
    .command('end')
    .description('Set when a secret ends, or remove its end')
    .argument('<name>')
    .option('--in <n>', 'After a while: a number and m, h, d or w (30m, 8h, 2d, 1w); also --ends-in')
    .option('--ends-in <n>')
    .option('--at <time>', 'At this time, with a zone (2026-12-01T15:00:00Z); also --ends-at')
    .option('--ends-at <time>')
    .option('--none', 'Remove the end')
    .option('--delete-at-end', 'At the end delete it altogether (alone: keeps the time it ends)')
    .option('--expire', 'At the end only remove the value; the name stays, listed as expired (without a kind flag: the kind it has, else this)')
    .action(async (name: string, opts: {
      in?: string; endsIn?: string; at?: string; endsAt?: string; none?: boolean; deleteAtEnd?: boolean; expire?: boolean;
    }) => {
      try {
        if (opts.deleteAtEnd && opts.expire) throw new SecretRefusal('invalid_end', 'Choose --delete-at-end or --expire, not both.');
        const inText = oneOf(opts.in, opts.endsIn, '--in or --ends-in');
        const atText = oneOf(opts.at, opts.endsAt, '--at or --ends-at');
        const kind: EndKind | undefined = opts.deleteAtEnd ? 'delete' : opts.expire ? 'expire' : undefined;
        if (opts.none) {
          if (inText !== undefined || atText !== undefined || kind !== undefined) {
            throw new SecretRefusal('invalid_end', '--none removes the end; it takes no time and no kind.');
          }
          await storeFor().setEnd(name, null);
          console.log(`"${name}" no longer ends.`);
          return;
        }
        if (inText !== undefined && atText !== undefined) throw new SecretRefusal('invalid_end', 'Give the end once: a duration or a time, not both.');
        if (inText === undefined && atText === undefined && kind === undefined) throw new SecretRefusal('invalid_end', 'Give --in, --at or --none.');
        // Without a kind flag a secret that already ends keeps its kind; a kind flag alone keeps its time.
        // Both are read and written under the store's lock (adjustEnd), never read here and written back.
        const endsAt = inText !== undefined ? endIn(inText) : atText !== undefined ? endAt(atText) : undefined;
        const end = await storeFor().adjustEnd(name, { endsAt, endKind: kind });
        console.log(`"${name}" ${end.end_kind === 'delete' ? 'is deleted' : 'expires'} ${shownTime(end.ends_at)}.`);
      } catch (err) { fail(err); }
    });

  secret
    .command('describe')
    .description('Set what a secret is for ("" clears it)')
    .argument('<name>')
    .argument('<text>')
    .action(async (name: string, text: string) => {
      try {
        await storeFor().describe(name, text);
        console.log(`Described "${name}".`);
      } catch (err) { fail(err); }
    });

  secret
    .command('remove')
    .description('Delete a secret for good (needs --yes)')
    .argument('<name>')
    .option('--yes', 'Really delete it')
    .action(async (name: string, opts: { yes?: boolean }) => {
      try {
        const store = storeFor();
        if (!opts.yes) {
          if (!(await store.has(name))) await store.path(name); // not_found first, if it is
          throw new Error(`Removing "${name}" cannot be undone; run again with --yes.`);
        }
        await store.remove(name);
        console.log(`Removed "${name}".`);
      } catch (err) { fail(err); }
    });

  secret
    .command('path')
    .description("Print a secret's file path (for a program that reads a file)")
    .argument('<name>')
    .action(async (name: string) => {
      try {
        console.log(await storeFor().path(name));
      } catch (err) { fail(err); }
    });

  secret
    .command('run')
    .description('Run a command with a secret: SECRET_FILE and SECRET_NAME set, "{SECRET_FILE}" in arguments replaced, its values masked in the output')
    .argument('<name>')
    // Everything after `--` is the command, word for word: an option there is
    // the command's, never ours.
    .argument('<command...>', 'The command and its arguments, after --')
    .option('--env <VAR>', 'Also put the content (trimmed) in this environment variable')
    .option('--dotenv', 'Also set every KEY=VALUE line of the secret as a variable')
    .option('--no-mask', 'Let the output through unfiltered (and keep the terminal)')
    .action(async (name: string, command: string[], opts: { env?: string; dotenv?: boolean; mask: boolean }) => {
      try {
        if (opts.env !== undefined) checkEnvName(opts.env);
        const store = storeFor();
        const path = await store.path(name);
        // Not process.exit(): on macOS a write to a pipe is asynchronous, and
        // exiting at once could cut off the end of the command's output.
        process.exitCode = await runWithSecret({
          name, path, content: await store.read(name), envVar: opts.env, dotenv: !!opts.dotenv, mask: opts.mask, command,
        });
      } catch (err) { fail(err); }
    });

  secret
    .command('import')
    .description('Copy a folder of one file per secret (and .desc/<name> descriptions) into the store; the folder is left as it is')
    .argument('<folder>')
    .option('--replace', 'Overwrite secrets that already exist; needs an end flag or --no-end (old ends are not kept)')
    .option('--ends-in <n>', 'End every imported secret after a while: a number and m, h, d or w (30m, 8h, 2d, 1w)')
    .option('--ends-at <time>', 'End every imported secret at this time, with a zone (2026-12-01T15:00:00Z)')
    .option('--delete-at-end', 'At the end delete them altogether (without this they expire)')
    .option('--expire', 'At the end only remove the value (the default)')
    .option('--no-end', 'No end (with --replace: say so deliberately; any end they had is removed)')
    .action(async (folder: string, opts: {
      replace?: boolean; endsIn?: string; endsAt?: string; deleteAtEnd?: boolean; expire?: boolean; end: boolean;
    }) => {
      try {
        const store = storeFor();
        const { kind, noEnd } = endOptions(opts);
        const report = await importFolder(store, folder, {
          replace: !!opts.replace, end: { endsIn: opts.endsIn, endsAt: opts.endsAt, kind, noEnd },
        });
        console.log(`Imported ${report.imported.length} into ${store.dir}${report.imported.length ? `: ${report.imported.join(', ')}` : ''}.`);
        for (const e of report.ends) console.log(`${e.name}: ${e.words}.`);
        for (const s of report.skipped) console.log(`Skipped ${oneLine(s.name)}: ${s.reason}`);
      } catch (err) { fail(err); }
    });
}
