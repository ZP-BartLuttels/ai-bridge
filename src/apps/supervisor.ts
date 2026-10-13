/**
 * App backends: long-running processes this bridge supervises for the person
 * using an Engram app (Engram docs/22-apps, "Where the backend runs").
 *
 * One `app_call` frame is one HTTP-shaped request for one app version's
 * backend. The first request for a version builds a working copy of that
 * version's files, fetched from Engram by content hash and cached, and starts
 * `node <main>` in it under Node's permission model. Later requests go to the
 * same process. It is stopped after a stretch with no requests, started again
 * by the next one, and when it crashes the next request starts a fresh one.
 * Exactly one per app version on this machine.
 *
 * THE WIRE between this bridge and the process is JSON lines on stdin and
 * stdout: one request object per line in, one response object per line out,
 * matched by id, so requests may overlap. Chosen over a local port or a Unix
 * socket because nothing listens: a port on localhost is reachable by every
 * other program and user on the machine (and by web pages, through DNS
 * rebinding), so it would need its own authentication; a pipe belongs to the
 * one process that was handed it, dies with it, needs no port allocation, and
 * works the same on every platform and under Node's permission model. The
 * cost is that the backend must not print anything else to stdout, so a line
 * that is not a response is logged and ignored rather than fatal, and logs
 * belong on stderr.
 *
 * Behind the same gate as local tools (`--local-tools`): a server can never
 * make this machine run code by sending a frame to a bridge that did not opt
 * in. Whether the PERSON approved this version is Engram's to decide before
 * the frame is sent; the bridge holds to the gate, the origin of every URL it
 * is handed, the content hash of every file, and the vault fill rules shared
 * with local tools.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rename, rm, writeFile, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import type { AppCallMessage, AppResultMessage, ItemFill } from '../protocol/types.js';
import { assertAllowedAttachmentUrl } from '../attachments/origin.js';
import { fillRoles, sealedRefs, type SealedRef, type SecretStore } from '../local/engram.js';
import { localCallRefusal, type LocalExecutionConfig } from '../local/gate.js';
import { scrub, type Redaction } from '../local/scrub.js';
import { defaultDataDir } from '../local/call.js';
import { createLogger } from '../utils/logger.js';
import { IMAGE_HOST, startEgress, type Egress, type EgressTesting } from './egress.js';
import { GUARD_SOURCE } from './guard.js';

const log = createLogger('Apps');

/** Stopped after this long with no request. */
export const DEFAULT_IDLE_MS = 10 * 60 * 1000;
/** Engram waits 60 s for an answer; answering a little sooner says why. */
export const DEFAULT_REQUEST_MS = 55 * 1000;
/** Both ways, as Engram enforces: a relay frame over 900 KB is dropped. */
const MAX_BODY = 256 * 1024;
/** A line longer than this is not a response, it is a backend gone wrong. */
const MAX_LINE = 2 * 1024 * 1024;
/** Three crashes inside a minute stops restarts for half a minute. */
const CRASH_WINDOW_MS = 60_000;
const CRASH_LIMIT = 3;
const CRASH_COOLDOWN_MS = 30_000;
const STDERR_TAIL = 2_000;

/** What a backend inherits from the bridge: never its tokens (see local/executor.ts). */
const INHERITED = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'USER'];
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export interface AppSupervisorOptions {
  config: LocalExecutionConfig;
  /** The origin this bridge's server is on; file and API URLs must be on it. */
  apiOrigin: string;
  /** Sealed values this device holds, as local tools get them. */
  secrets: (refs: SealedRef[]) => Promise<SecretStore>;
  idleMs?: number;
  requestMs?: number;
  /** Tests point this elsewhere; defaults to the local-tools data dir. */
  dataDir?: string;
  /** The Node binary a backend runs on. */
  nodePath?: string;
  /** Tests only: see EgressTesting. */
  egressTesting?: EgressTesting;
}

interface Pending {
  resolve: (response: BackendResponse) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface BackendResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

interface Running {
  key: string;
  app: string;
  version: number;
  /** Which items filled which roles: a different choice is a different process. */
  fillKey: string;
  child: ChildProcess;
  pending: Map<string, Pending>;
  granted: Redaction[];
  /** The listeners its connections go through (egress.ts), closed when it exits. */
  egress: Egress;
  idle?: NodeJS.Timeout;
  stderr: string;
  stopping: boolean;
  exited: Promise<void>;
}

export class AppSupervisor {
  private readonly running = new Map<string, Running>();
  /** A start in progress, so two first requests start one process. */
  private readonly starting = new Map<string, Promise<Running>>();
  private readonly crashes = new Map<string, number[]>();
  private readonly options: AppSupervisorOptions;

  constructor(options: AppSupervisorOptions) {
    this.options = options;
  }

  private get dataDir(): string {
    return join(this.options.dataDir ?? this.options.config.dataDir ?? defaultDataDir(), 'apps');
  }

  /** What is running now, for tests and logs. */
  list(): { key: string; app: string; version: number; pid: number | undefined }[] {
    return [...this.running.values()].map((r) => ({ key: r.key, app: r.app, version: r.version, pid: r.child.pid }));
  }

  /**
   * Answer one app_call. Never throws: every failure is `ok: false` with a
   * sentence, scrubbed of every sealed value this backend was handed.
   */
  /** App calls being answered right now, including ones still starting their backend. */
  inFlight(): number {
    return this.calls;
  }

  private calls = 0;

  async handle(message: AppCallMessage): Promise<AppResultMessage> {
    this.calls++;
    try {
      return await this.handleOne(message);
    } finally {
      this.calls--;
    }
  }

  private async handleOne(message: AppCallMessage): Promise<AppResultMessage> {
    const id = typeof message.id === 'string' ? message.id : '';
    let granted: Redaction[] = [];
    try {
      const refused = localCallRefusal(this.options.config);
      if (refused) return { type: 'app_result', id, ok: false, error: refused };
      const call = validate(message);
      assertAllowedAttachmentUrl(call.files.base, this.options.apiOrigin);
      assertAllowedAttachmentUrl(call.engram.api, this.options.apiOrigin);

      const running = await this.processFor(call);
      granted = running.granted;
      // Another linked item than a role's default, for this request only:
      // opened like the fill, handed over on the request's own line, and
      // scrubbed from this answer with the process's own.
      let vault: Record<string, string> | undefined;
      if (call.use?.length) {
        const used = fillRoles(await this.options.secrets(sealedRefs(call.use)), call.use);
        vault = { ...used.env, ...Object.fromEntries(used.sealed.map((x) => [x.name, x.value])) };
        granted = [...granted, ...used.sealed];
      }
      const response = await this.send(running, call, vault);
      return {
        type: 'app_result', id, ok: true,
        response: {
          status: response.status,
          headers: Object.fromEntries(Object.entries(response.headers).map(([k, v]) => [k, scrub(v, granted)])),
          body: scrub(response.body, granted),
        },
      };
    } catch (err) {
      const error = scrub(err instanceof Error ? err.message : String(err), granted);
      log.warn('an app_call failed', { id, app: message.app?.name, error });
      return { type: 'app_result', id, ok: false, error };
    }
  }

  /** Stop everything, for shutdown. */
  async stopAll(): Promise<void> {
    await Promise.all([...this.running.values()].map((r) => this.stop(r, 'the bridge is shutting down')));
  }

  /* ------------------------------ processes ------------------------------ */

  private async processFor(call: AppCallMessage): Promise<Running> {
    const key = `${call.app.space_id}:${call.app.hash}`;
    // The hosts it may reach are part of what the process was started with,
    // so a host granted or taken back starts a fresh one, as an item does.
    const fillKey = `${fillFingerprint(call.fill)}|${JSON.stringify(hostsOf(call.backend))}|${call.backend.public_images === true}`;
    const current = this.running.get(key);
    if (current && current.fillKey === fillKey && !current.stopping) return current;
    if (current) await this.stop(current, 'its vault items or the hosts it may reach changed');

    const inFlight = this.starting.get(key);
    if (inFlight) {
      const started = await inFlight;
      if (started.fillKey === fillKey) return started;
      await this.stop(started, 'its vault items or the hosts it may reach changed');
    }

    const recent = (this.crashes.get(key) ?? []).filter((t) => Date.now() - t < CRASH_WINDOW_MS);
    if (recent.length >= CRASH_LIMIT && Date.now() - recent[recent.length - 1]! < CRASH_COOLDOWN_MS) {
      throw new Error(
        `the backend of "${call.app.name}" crashed ${recent.length} times in the last minute, so it is not ` +
        `started again for ${CRASH_COOLDOWN_MS / 1000} seconds. Its last words are in the bridge's log.`);
    }

    const start = this.start(key, fillKey, call).finally(() => this.starting.delete(key));
    this.starting.set(key, start);
    return start;
  }

  private async start(key: string, fillKey: string, call: AppCallMessage): Promise<Running> {
    const dir = await this.workingCopy(call);
    const store = await this.options.secrets(sealedRefs(call.fill));
    const filled = fillRoles(store, call.fill);

    const env: NodeJS.ProcessEnv = {};
    for (const k of INHERITED) if (process.env[k] !== undefined) env[k] = process.env[k];
    const publicImages = call.backend.public_images === true;
    const own: Record<string, string> = { ENGRAM_APP_DIR: dir, ENGRAM_APP_NAME: call.app.name, ENGRAM_APP_VERSION: String(call.app.version) };
    if (publicImages) own.ENGRAM_IMAGE_FETCH = `http://${IMAGE_HOST}/`;
    const reserved = new Set([...Object.keys(own), 'ENGRAM_NETWORK', 'ENGRAM_IMAGE_FETCH']);
    for (const [k, v] of [...Object.entries(filled.env), ...filled.sealed.map((s) => [s.name, s.value] as const)]) {
      if (reserved.has(k)) throw new Error(`the vault role and field that become ${k} collide with a name the bridge sets; rename the role`);
      env[k] = v;
    }
    Object.assign(env, own);

    // The way out (egress.ts), opened before the process exists and closed
    // when it exits, and the fence that sends every connection there (guard.ts).
    const api = new URL(this.options.apiOrigin);
    const egress = await startEgress({
      hosts: hostsOf(call.backend),
      engram: { host: api.hostname, port: Number(api.port || (api.protocol === 'https:' ? 443 : 80)) },
      publicImages,
      ...(this.options.egressTesting ? { testing: this.options.egressTesting } : {}),
    }, (why) => log.warn('an app backend was kept to its declared hosts', { app: call.app.name, version: call.app.version, why }));
    env.ENGRAM_NETWORK = JSON.stringify({
      ports: egress.ports,
      hosts: [...hostsOf(call.backend), api.hostname.replace(/^\[|\]$/g, ''), ...(publicImages ? [IMAGE_HOST] : [])],
    });

    let child: ChildProcess;
    try {
      const guard = await this.guardFile();
      const args = permissionFlags(dir, call.backend, guard);
      args.push(join(dir, ...call.backend.main.split('/')));
      child = spawn(this.options.nodePath ?? process.execPath, args, {
        cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      });
    } catch (err) {
      await egress.close();
      throw err;
    }

    let exitedResolve!: () => void;
    const running: Running = {
      key, app: call.app.name, version: call.app.version, fillKey, child,
      pending: new Map(), granted: filled.sealed, egress, stderr: '', stopping: false,
      exited: new Promise<void>((r) => { exitedResolve = r; }),
    };

    let buffer = '';
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE && !buffer.includes('\n')) {
        log.warn('an app backend wrote a line too long to be a response; stopping it', { app: running.app });
        buffer = '';
        void this.stop(running, 'it wrote a line longer than 2 MB');
        return;
      }
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) this.onLine(running, line);
      }
    });
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      running.stderr = (running.stderr + chunk).slice(-STDERR_TAIL);
    });
    child.stdin!.on('error', () => { /* a dead process: the exit handler says so */ });
    child.on('error', (err) => {
      running.stderr = (running.stderr + `\n${err.message}`).slice(-STDERR_TAIL);
    });
    child.on('exit', (code, signal) => {
      void egress.close();
      exitedResolve();
      if (this.running.get(key) === running) this.running.delete(key);
      if (running.idle) clearTimeout(running.idle);
      const tail = scrub(running.stderr.trim(), running.granted);
      const why = running.stopping
        ? 'it was stopped'
        : `it exited ${code ?? signal ?? 'without a status'}${tail ? `. Its stderr ended: ${tail.slice(-400)}` : ''}`;
      if (!running.stopping) {
        this.crashes.set(key, [...(this.crashes.get(key) ?? []).filter((t) => Date.now() - t < CRASH_WINDOW_MS), Date.now()]);
        log.warn('an app backend exited', { app: running.app, version: running.version, code, signal });
      }
      for (const [, p] of running.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`the backend of "${running.app}" stopped before answering: ${why}. The next request starts it again.`));
      }
      running.pending.clear();
    });

    this.running.set(key, running);
    log.info('app backend started', { app: call.app.name, version: call.app.version, pid: child.pid });
    return running;
  }

  private onLine(running: Running, line: string): void {
    let msg: { id?: unknown; status?: unknown; headers?: unknown; body?: unknown };
    try {
      msg = JSON.parse(line);
    } catch {
      log.debug('an app backend printed a line that is not a response; logs belong on stderr', { app: running.app });
      return;
    }
    const p = typeof msg.id === 'string' ? running.pending.get(msg.id) : undefined;
    if (!p) return;
    running.pending.delete(msg.id as string);
    clearTimeout(p.timer);
    const status = typeof msg.status === 'number' && Number.isInteger(msg.status) && msg.status >= 100 && msg.status <= 599 ? msg.status : 200;
    const headers: Record<string, string> = {};
    if (msg.headers && typeof msg.headers === 'object' && !Array.isArray(msg.headers)) {
      for (const [k, v] of Object.entries(msg.headers as Record<string, unknown>)) if (typeof v === 'string') headers[k.toLowerCase()] = v;
    }
    const body = typeof msg.body === 'string' ? msg.body : msg.body === undefined ? '' : JSON.stringify(msg.body);
    if (Buffer.byteLength(body) > MAX_BODY) {
      p.reject(new Error(`the backend answered with more than ${MAX_BODY} bytes; page the answer`));
    } else {
      p.resolve({ status, headers, body });
    }
    // Either way the request is over, so the idle clock starts: returning early
    // here left a process whose last answer was too large running until the
    // bridge stopped.
    this.idleLater(running);
  }

  private send(running: Running, call: AppCallMessage, vault?: Record<string, string>): Promise<BackendResponse> {
    if (running.idle) { clearTimeout(running.idle); running.idle = undefined; }
    const rid = randomBytes(8).toString('hex');
    return new Promise<BackendResponse>((resolveResponse, reject) => {
      const timer = setTimeout(() => {
        running.pending.delete(rid);
        this.idleLater(running);
        reject(new Error(`the backend of "${running.app}" did not answer ${call.request.method} ${call.request.path} within ${Math.round((this.options.requestMs ?? DEFAULT_REQUEST_MS) / 1000)}s`));
      }, this.options.requestMs ?? DEFAULT_REQUEST_MS);
      running.pending.set(rid, { resolve: resolveResponse, reject, timer });
      const line = JSON.stringify({
        id: rid, method: call.request.method, path: call.request.path,
        headers: call.request.headers ?? {}, body: call.request.body ?? '',
        engram: { api: call.engram.api, token: call.engram.token },
        ...(vault ? { vault } : {}),
      });
      running.child.stdin!.write(line + '\n');
    });
  }

  /** Arm the idle stop once nothing is waiting. */
  private idleLater(running: Running): void {
    if (running.pending.size || running.stopping) return;
    if (running.idle) clearTimeout(running.idle);
    running.idle = setTimeout(() => void this.stop(running, 'idle'), this.options.idleMs ?? DEFAULT_IDLE_MS);
    running.idle.unref();
  }

  private async stop(running: Running, why: string): Promise<void> {
    if (running.stopping) return running.exited;
    running.stopping = true;
    if (running.idle) clearTimeout(running.idle);
    if (this.running.get(running.key) === running) this.running.delete(running.key);
    log.info('stopping an app backend', { app: running.app, version: running.version, why });
    if (running.child.exitCode !== null || running.child.signalCode !== null) return;
    running.child.stdin!.end();
    running.child.kill('SIGTERM');
    const hard = setTimeout(() => running.child.kill('SIGKILL'), 5_000);
    hard.unref();
    await running.exited;
    clearTimeout(hard);
  }

  /** The fence's file, content-addressed beside the working copies, written once. */
  private async guardFile(): Promise<string> {
    const path = join(this.dataDir, 'runtime', `network-fence-${sha256(Buffer.from(GUARD_SOURCE)).slice(0, 16)}.cjs`);
    if (existsSync(path) && (await readFile(path, 'utf8')) === GUARD_SOURCE) return path;
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, GUARD_SOURCE);
    await rename(tmp, path);
    return path;
  }

  /* ------------------------------ working copy ------------------------------ */

  /**
   * The version's files in a folder of their own, built once per version hash.
   * Each file is fetched by the sha256 of its bytes, checked against it, and
   * kept in a shared cache, so a file unchanged across versions is fetched
   * once. The folder is built beside its final name and renamed into place, so
   * a half-built copy is never run.
   */
  private async workingCopy(call: AppCallMessage): Promise<string> {
    const final = join(this.dataDir, 'versions', call.app.hash);
    if (existsSync(join(final, '.engram-complete'))) return final;
    const blobs = join(this.dataDir, 'blobs');
    await mkdir(blobs, { recursive: true });
    const building = `${final}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      for (const [path, hash] of Object.entries(call.files.tree)) {
        const bytes = await this.blob(blobs, call.files.base, hash);
        const target = resolve(building, ...path.split('/'));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, bytes);
      }
      await writeFile(join(building, '.engram-complete'), call.app.hash);
      await mkdir(dirname(final), { recursive: true });
      await rm(final, { recursive: true, force: true });
      await rename(building, final);
    } catch (err) {
      await rm(building, { recursive: true, force: true });
      throw err;
    }
    return final;
  }

  private async blob(dir: string, base: string, hash: string): Promise<Buffer> {
    const cached = join(dir, hash);
    if (existsSync(cached)) {
      const bytes = await readFile(cached);
      if (sha256(bytes) === hash) return bytes;
    }
    const res = await fetch(base + hash);
    if (!res.ok) throw new Error(`could not fetch a file of this app from Engram (${res.status}); open the app again`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (sha256(bytes) !== hash) throw new Error('a file fetched from Engram does not match its content hash; nothing was run');
    const tmp = `${cached}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, cached);
    return bytes;
  }
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Which items filled which roles, as one string: the process holds their values in its environment. */
function fillFingerprint(fill: ItemFill[] | undefined): string {
  return JSON.stringify((fill ?? []).map((f) => [f.role, f.item_id, Object.entries(f.fields ?? {}).sort(),
    (f.sealed ?? []).map((s) => [s.field, s.secret_id, s.space_id]).sort()]).sort());
}

/** `~/x` is the person's home; everything else must already be absolute. */
export function expandFolder(path: string): string {
  const full = path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
  if (!full.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(full)) throw new Error(`folder "${path}" is not absolute`);
  const resolved = resolve(full);
  if (resolved === resolve('/') || resolved === homedir()) throw new Error(`folder "${path}" is the whole disk or home`);
  return resolved;
}

/** The hosts a backend may reach, lowercase and sorted: the manifest's "network" with what was granted. */
export function hostsOf(backend: AppCallMessage['backend']): string[] {
  const list = Array.isArray(backend.network) ? backend.network : [];
  return [...new Set(list.filter((h): h is string => typeof h === 'string').map((h) => h.trim().toLowerCase().replace(/\.$/, '')))].sort();
}

/** Whether this Node has a network permission (25 and later), which `--permission` then denies unless granted. */
const NODE_NET_PERMISSION = process.allowedNodeEnvironmentFlags.has('--allow-net');

/**
 * Node's permission model, following the manifest: read the working copy,
 * read (or read and write) each declared folder, and start other programs only
 * when the manifest says it runs a shell or programs. A child process runs
 * WITHOUT the permission model and without the network fence, so `shell` or
 * `programs` is where both end, and the approval prompt says so.
 *
 * The network is fenced by `guard`, loaded before the app (guard.ts), which
 * sends every connection through the bridge (egress.ts). On a Node with a
 * network permission of its own, `--allow-net` lets the process open those
 * connections at all; the fence still decides where they go.
 */
export function permissionFlags(dir: string, backend: AppCallMessage['backend'], guard?: string): string[] {
  const flags = ['--permission', `--allow-fs-read=${dir}`];
  // The network only with the fence in front of it: without one, a Node that
  // has a network permission keeps it denied.
  if (guard) {
    flags.push(`--allow-fs-read=${guard}`, '--require', guard);
    if (NODE_NET_PERMISSION) flags.push('--allow-net');
  }
  for (const f of backend.folders ?? []) {
    const path = expandFolder(f.path);
    flags.push(`--allow-fs-read=${path}`);
    if (f.write) flags.push(`--allow-fs-write=${path}`);
  }
  if (backend.shell || (backend.programs ?? []).length) flags.push('--allow-child-process');
  return flags;
}

function validate(m: AppCallMessage): AppCallMessage {
  if (typeof m.id !== 'string' || !m.id) throw new Error('this app_call has no id');
  const a = m.app;
  if (!a || typeof a.space_id !== 'string' || typeof a.name !== 'string' || !SHA256.test(String(a.hash)) || !Number.isInteger(a.version)) {
    throw new Error('this app_call does not name an app version (space_id, name, version, hash)');
  }
  if (!m.files || typeof m.files.base !== 'string' || !m.files.tree || typeof m.files.tree !== 'object') {
    throw new Error('this app_call carries no files');
  }
  for (const [path, hash] of Object.entries(m.files.tree)) {
    if (!path.split('/').every((s) => SEGMENT.test(s)) || !SHA256.test(String(hash))) {
      throw new Error(`this app_call names a file "${path}" that cannot be written safely`);
    }
    if (resolve('/x', ...path.split('/')).split(sep).includes('..')) throw new Error(`bad path "${path}"`);
  }
  if (!m.backend || typeof m.backend.main !== 'string' || !(m.backend.main in m.files.tree)) {
    throw new Error('this app_call names no backend file among its files');
  }
  if (!m.request || typeof m.request.method !== 'string' || typeof m.request.path !== 'string') {
    throw new Error('this app_call carries no request');
  }
  if (typeof m.request.body === 'string' && Buffer.byteLength(m.request.body) > MAX_BODY) {
    throw new Error(`a request body is at most ${MAX_BODY} bytes`);
  }
  if (!m.engram || typeof m.engram.api !== 'string' || typeof m.engram.token !== 'string') {
    throw new Error('this app_call carries no Engram API token');
  }
  if (m.use !== undefined && !Array.isArray(m.use)) throw new Error('this app_call\'s "use" is a list of filled roles, as "fill" is');
  // A role named in `use` must be one the process was filled for: a request
  // handing over a role the backend was never given would be a second fill.
  const filled = new Set((m.fill ?? []).map((f) => f.role));
  for (const u of m.use ?? []) {
    if (!filled.has(u.role)) throw new Error(`this app_call uses an item for "${u.role}", a role it does not fill`);
  }
  return m;
}
