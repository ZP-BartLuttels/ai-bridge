/**
 * The way out for one app backend: the only place its connections can go.
 *
 * An app backend runs with a fence loaded before its own code (guard.ts) that
 * sends every TCP connection it makes to one of the loopback ports opened
 * here, chosen by the port it asked for, and refuses UDP, local sockets and
 * DNS for anything it did not declare. This side, in the bridge's own process
 * where the backend cannot reach, decides where a connection may actually go:
 *
 *   - TLS (the first byte is a handshake record): the name it is FOR is the
 *     server name in the client's hello (SNI). The connection goes to that
 *     name and nowhere else, and from then on the bytes are only copied: TLS
 *     stays end to end, so what is said inside it is not seen here.
 *   - Anything else is read as HTTP/1.1, by Node's own parser, one request at
 *     a time: every request on a kept-alive connection is checked by its own
 *     Host header and forwarded on its own, so a second request cannot ride a
 *     connection the first one opened. CONNECT, a request target that is not a
 *     path, and a request with no host are refused. Something that is not
 *     HTTP is refused.
 *   - A name may be a host the manifest declares (plus those the person
 *     granted later), on port 443 or 80, or exactly Engram's own API host and
 *     port.
 *   - The bridge resolves the name itself, connects to the address it checked,
 *     and refuses a declared host whose addresses are all loopback, private,
 *     link-local or otherwise local: an app may not reach the person's own
 *     machine or network by pointing a name it declared there. Engram's own
 *     host is exempt, because a dev or self-hosted Engram is often exactly such
 *     an address.
 *
 * So a redirect to an undeclared host, an IP address typed into a URL, a
 * declared name whose DNS points at the router, and a raw socket all end here,
 * refused, with a line in the bridge's log: a 403 with `x-engram-refused:
 * network` for HTTP, an `unrecognized_name` alert for TLS.
 *
 * PUBLIC IMAGES. A manifest may also say `"public_images": true` (Engram's
 * Mail does, to show a picture in a mail when the person asks for it). The
 * backend then reaches the bridge's image fetcher at IMAGE_HOST (its address
 * is handed over as ENGRAM_IMAGE_FETCH): GET `?url=<http(s) address>`, and
 * the BRIDGE fetches it: GET only, no body and no headers of the app's, ports
 * 443 and 80, public addresses only, at most four redirects each checked the
 * same way, an image content type, 3 MB at most, 10 seconds. The app never
 * holds the connection, so it cannot send anything but the address itself,
 * which is the one thing loading an image from any host cannot avoid sending.
 *
 * The listeners are on 127.0.0.1, so another program on this machine could
 * connect to them too. That gives it nothing it lacks: it reaches only this
 * app's declared hosts, carrying none of the app's credentials, and a web page
 * that rebinds a name to 127.0.0.1 sends its own name as the Host, which is
 * refused.
 */

import { BlockList, connect as netConnect, createServer, isIP, type Server, type Socket } from 'node:net';
import { lookup as dnsLookup } from 'node:dns';
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type ServerResponse, type ClientRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { checkServerIdentity } from 'node:tls';

/** Where a backend may go. */
export interface EgressPolicy {
  /** Hostnames from the manifest's "network" (and granted "extra"), lowercase. */
  hosts: string[];
  /** Engram's API, which every backend may reach: its host and port exactly. */
  engram: { host: string; port: number };
  /** The manifest says `"public_images": true`: the image fetcher answers at IMAGE_HOST. */
  publicImages?: boolean;
  /** Tests only; never set by the bridge itself. */
  testing?: EgressTesting;
}

/**
 * Stand-ins that let a suite run the real checks against local listeners: the
 * names are resolved by `resolve` instead of DNS, the address checks run on
 * what it answers, and only then `route` says which local listener stands in
 * for that address. With `testing` set, a connection `route` has no answer for
 * is refused rather than made, so a suite never reaches the internet.
 */
export interface EgressTesting {
  resolve: (host: string) => Promise<string[]>;
  route: (address: string, port: number) => { host: string; port: number } | undefined;
  /** Extra trusted certificates for the image fetcher's own TLS. */
  ca?: string;
  /** How long a connection may stay silent before it is dropped (HEAD_MS otherwise). */
  headMs?: number;
}

export interface Egress {
  /** The port a backend asked for, to the loopback port that carries it. */
  ports: Record<string, number>;
  close(): Promise<void>;
}

/** Ports a declared host may be reached on. */
export const WEB_PORTS = [443, 80] as const;
/** The name the image fetcher answers to (`.invalid` never resolves anywhere else). */
export const IMAGE_HOST = 'engram-images.invalid';
/** Bytes read while looking for the server name of a TLS hello. */
const MAX_HEAD = 64 * 1024;
/** How long a connection may take to say what it is for. */
const HEAD_MS = 10_000;
const IMAGE_MAX_BYTES = 3 * 1024 * 1024;
const IMAGE_MAX_REDIRECTS = 4;
const IMAGE_MS = 10_000;
/** Hop-by-hop headers, never forwarded (RFC 9110 7.6.1), plus proxy ones. */
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

class Refused extends Error {}

/** A fatal TLS alert, unrecognized_name: what a refused TLS connection is told. */
const UNRECOGNIZED_NAME = Buffer.from([0x15, 0x03, 0x01, 0x00, 0x02, 0x02, 0x70]);

/**
 * Open the listeners for one backend. `onBlocked` is told every refusal, in a
 * sentence, for the bridge's log.
 */
export async function startEgress(policy: EgressPolicy, onBlocked: (why: string) => void): Promise<Egress> {
  const hosts = new Set(policy.hosts.map(normalHost));
  const engram = { host: normalHost(policy.engram.host), port: policy.engram.port };
  const targets = [...new Set<number>([...WEB_PORTS, engram.port])];
  const servers: Server[] = [];
  const sockets = new Set<Socket>();
  const ports: Record<string, number> = {};
  const testing = policy.testing;
  const headMs = testing?.headMs ?? HEAD_MS;
  const track = (s: Socket) => { sockets.add(s); s.on('close', () => sockets.delete(s)); };

  /** 'engram', 'declared', 'images', or why not. */
  const decide = (name: string | null, port: number): string => {
    if (!name) return 'it names no host (raw TCP, or TLS to an IP address)';
    if (name === engram.host && port === engram.port) return 'engram';
    if (policy.publicImages && name === IMAGE_HOST && port === 80) return 'images';
    if (hosts.has(name)) {
      if ((WEB_PORTS as readonly number[]).includes(port)) return 'declared';
      return `${name} is declared, but only on ports ${WEB_PORTS.join(' and ')}`;
    }
    return `${name} is not a host this app declares`;
  };

  /**
   * The address to connect to for a name that was allowed: resolved here,
   * checked, and only then routed (tests). Throws Refused with the reason.
   */
  const destination = async (name: string, port: number, anyAddress: boolean): Promise<{ host: string; port: number }> => {
    let addresses: string[];
    if (isIP(name)) addresses = [name];
    else if (testing) addresses = await testing.resolve(name);
    else addresses = await new Promise<string[]>((res, rej) => dnsLookup(name, { all: true }, (err, list) => err ? rej(err) : res(list.map((a) => a.address))));
    const ok = anyAddress ? addresses : addresses.filter(isPublicAddress);
    if (!ok.length) {
      throw new Refused(`${name} resolves only to local or private addresses (${addresses.join(', ') || 'none'}), which an app may not reach`);
    }
    const address = ok[0]!;
    if (!testing) return { host: address, port };
    const routed = testing.route(address, port);
    if (!routed) throw new Refused(`no test route for ${address}:${port}`);
    return routed;
  };

  for (const target of targets) {
    const http = plainHttp(target);
    const server = createServer((conn) => {
      track(conn);
      conn.on('error', () => conn.destroy());
      let head = Buffer.alloc(0);
      const timer = setTimeout(() => {
        onBlocked(`a connection to port ${target} said nothing it could be checked by within ${headMs / 1000}s`);
        conn.destroy();
      }, headMs);
      const onData = (chunk: Buffer) => {
        head = Buffer.concat([head, chunk]);
        if (head[0] !== 0x16) {
          // Not TLS: HTTP, read by Node's parser, request by request.
          clearTimeout(timer);
          conn.off('data', onData);
          conn.pause();
          conn.unshift(head);
          http.emit('connection', conn);
          conn.resume();
          return;
        }
        const found = sniOf(head);
        if (found === undefined && head.length < MAX_HEAD) return;
        clearTimeout(timer);
        conn.off('data', onData);
        conn.pause();
        const name = found ? normalHost(found) : null;
        const verdict = decide(name, target);
        if (verdict !== 'engram' && verdict !== 'declared') {
          onBlocked(`refused a TLS connection to ${name ?? '(no server name)'}:${target}: ${verdict}`);
          conn.end(UNRECOGNIZED_NAME);
          return;
        }
        destination(name!, target, verdict === 'engram').then((to) => {
          const upstream = netConnect(to);
          track(upstream);
          upstream.on('error', (err) => {
            onBlocked(`could not reach ${name}:${target}: ${err.message}`);
            conn.destroy();
          });
          conn.on('error', () => upstream.destroy());
          conn.on('close', () => upstream.destroy());
          upstream.on('close', () => conn.destroy());
          upstream.once('connect', () => {
            upstream.write(head);
            conn.pipe(upstream);
            upstream.pipe(conn);
            conn.resume();
          });
        }, (err: Error) => {
          onBlocked(`refused a TLS connection to ${name}:${target}: ${err.message}`);
          conn.end(UNRECOGNIZED_NAME);
        });
      };
      conn.on('data', onData);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    servers.push(server);
    ports[String(target)] = (server.address() as { port: number }).port;
  }

  /** Plain HTTP arriving for one port: each request checked and forwarded on its own. */
  function plainHttp(target: number) {
    const server = createHttpServer({ requestTimeout: 0, headersTimeout: HEAD_MS, keepAliveTimeout: 5_000 });

    const refuseHttp = (res: ServerResponse, why: string, status = 403) => {
      onBlocked(`refused an HTTP request on port ${target}: ${why}`);
      const body = `Refused by the Engram bridge: ${why}. An app backend reaches only the hosts its engram.json declares under "network", and Engram.\n`;
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(body), connection: 'close', 'x-engram-refused': 'network' });
      res.end(body);
    };

    /** The name a request is for, or why it names none. */
    const nameOf = (req: IncomingMessage): { name: string } | { why: string } => {
      const raw = req.rawHeaders.filter((_, i) => i % 2 === 0 && /^host$/i.test(req.rawHeaders[i]!));
      if (raw.length !== 1) return { why: 'a request must carry exactly one Host header' };
      const host = hostOfHeader(String(req.headers.host ?? ''));
      if (!host) return { why: 'its Host header is not a host name' };
      if (!(req.url ?? '').startsWith('/') && !(req.method === 'OPTIONS' && req.url === '*')) {
        return { why: 'a request target must be a path (no absolute URL, no proxying)' };
      }
      return { name: normalHost(host) };
    };

    server.on('request', (req: IncomingMessage, res: ServerResponse) => {
      const n = nameOf(req);
      if ('why' in n) { refuseHttp(res, n.why, 400); req.resume(); return; }
      const verdict = decide(n.name, target);
      if (verdict === 'images') { void serveImage(req, res); return; }
      if (verdict !== 'engram' && verdict !== 'declared') { refuseHttp(res, verdict); req.resume(); return; }
      req.pause();
      destination(n.name, target, verdict === 'engram').then((to) => {
        const headers: string[] = [];
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          if (!HOP.has(req.rawHeaders[i]!.toLowerCase())) headers.push(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
        }
        const chunked = req.headers['transfer-encoding'] !== undefined;
        if (chunked) headers.push('Transfer-Encoding', 'chunked');
        headers.push('Connection', 'close');
        const up: ClientRequest = httpRequest({ host: to.host, port: to.port, method: req.method, path: req.url, headers: headers as unknown as Record<string, string>, agent: false, setHost: false });
        up.on('socket', (s: Socket) => track(s));
        // The backend gone (an aborted fetch, a cancelled stream): so is the upstream request.
        res.on('close', () => { if (!res.writableFinished) up.destroy(); });
        up.on('response', (r) => {
          const out: string[] = [];
          for (let i = 0; i < r.rawHeaders.length; i += 2) {
            if (!HOP.has(r.rawHeaders[i]!.toLowerCase())) out.push(r.rawHeaders[i]!, r.rawHeaders[i + 1]!);
          }
          res.writeHead(r.statusCode ?? 502, r.statusMessage, out);
          r.pipe(res);
        });
        up.on('error', (err) => {
          onBlocked(`could not reach ${n.name}:${target}: ${err.message}`);
          if (!res.headersSent) { res.writeHead(502, { 'content-type': 'text/plain', connection: 'close' }); res.end(`The Engram bridge could not reach ${n.name}: ${err.message}\n`); }
          else res.destroy();
        });
        req.pipe(up);
        req.resume();
      }, (err: Error) => { refuseHttp(res, err.message); req.resume(); });
    });

    // A WebSocket (or other upgrade) to an allowed name: checked like a request, then copied.
    server.on('upgrade', (req: IncomingMessage, socket: Socket, rest: Buffer) => {
      const n = nameOf(req);
      const verdict = 'why' in n ? n.why : decide(n.name, target);
      if ('why' in n || (verdict !== 'engram' && verdict !== 'declared')) {
        onBlocked(`refused an upgrade on port ${target}: ${verdict}`);
        socket.end('HTTP/1.1 403 Forbidden\r\nconnection: close\r\nx-engram-refused: network\r\ncontent-length: 0\r\n\r\n');
        return;
      }
      destination(n.name, target, verdict === 'engram').then((to) => {
        const upstream = netConnect(to);
        track(upstream);
        upstream.on('error', () => socket.destroy());
        socket.on('error', () => upstream.destroy());
        upstream.once('connect', () => {
          let head = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
          for (let i = 0; i < req.rawHeaders.length; i += 2) head += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
          upstream.write(head + '\r\n');
          if (rest.length) upstream.write(rest);
          socket.pipe(upstream);
          upstream.pipe(socket);
        });
      }, (err: Error) => {
        onBlocked(`refused an upgrade to ${n.name}:${target}: ${err.message}`);
        socket.destroy();
      });
    });

    server.on('connect', (req: IncomingMessage, socket: Socket) => {
      onBlocked(`refused an HTTP CONNECT to ${req.url} on port ${target}`);
      socket.end('HTTP/1.1 403 Forbidden\r\nconnection: close\r\nx-engram-refused: network\r\ncontent-length: 0\r\n\r\n');
    });
    server.on('clientError', (_err, socket: Socket) => {
      onBlocked(`refused a connection on port ${target}: what it sent is not HTTP or TLS`);
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\nx-engram-refused: network\r\ncontent-length: 0\r\n\r\n');
      else socket.destroy();
    });
    return server;
  }

  /** The image fetcher (see the top of this file). */
  async function serveImage(req: IncomingMessage, res: ServerResponse): Promise<void> {
    req.resume();
    const fail = (status: number, why: string) => {
      onBlocked(`image fetch refused: ${why}`);
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'x-engram-refused': 'images', connection: 'close' });
      res.end(`${why}\n`);
    };
    if (req.method !== 'GET') return fail(405, 'the image fetcher only answers GET');
    const asked = new URL(req.url ?? '/', 'http://x').searchParams.get('url');
    if (!asked) return fail(400, 'say which image as ?url=<http or https address>');
    let url: URL;
    try { url = new URL(asked); } catch { return fail(400, 'that is not an address'); }
    try {
      for (let hop = 0; hop <= IMAGE_MAX_REDIRECTS; hop++) {
        const r = await imageHop(url);
        if ('location' in r) { url = r.location; continue; }
        res.writeHead(200, { 'content-type': r.type, 'content-length': r.bytes.length, 'x-engram-image-url': url.href });
        res.end(r.bytes);
        return;
      }
      fail(502, `more than ${IMAGE_MAX_REDIRECTS} redirects`);
    } catch (err) {
      fail(err instanceof Refused ? 403 : 502, err instanceof Error ? err.message : String(err));
    }
  }

  async function imageHop(url: URL): Promise<{ location: URL } | { type: string; bytes: Buffer }> {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Refused('only http and https images are loaded');
    if (url.username || url.password) throw new Refused('an image address may not carry a user name or password');
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    if (!(WEB_PORTS as readonly number[]).includes(port)) throw new Refused(`images are loaded from ports ${WEB_PORTS.join(' and ')} only`);
    const host = normalHost(url.hostname);
    const to = await destination(host, port, false);
    const tlsHost = isIP(host) ? undefined : host;
    return await new Promise((resolve, reject) => {
      const options = {
        host: to.host, port: to.port, method: 'GET', path: `${url.pathname}${url.search}`, agent: false as const, setHost: false,
        headers: { host: url.host, accept: 'image/*', 'user-agent': 'Engram-bridge-image-fetch', connection: 'close' },
      };
      const req = url.protocol === 'https:'
        ? httpsRequest({ ...options, servername: tlsHost, ...(testing?.ca ? { ca: testing.ca } : {}), checkServerIdentity: (_h: string, cert: Parameters<typeof checkServerIdentity>[1]) => checkServerIdentity(host, cert) })
        : httpRequest(options);
      const timer = setTimeout(() => req.destroy(new Error(`no image within ${IMAGE_MS / 1000}s`)), IMAGE_MS);
      req.on('error', (e) => { clearTimeout(timer); reject(e); });
      req.on('response', (r) => {
        const status = r.statusCode ?? 0;
        if (status >= 300 && status < 400 && r.headers.location) {
          clearTimeout(timer); r.resume();
          try { resolve({ location: new URL(r.headers.location, url) }); } catch { reject(new Error('a redirect to something that is not an address')); }
          return;
        }
        const type = String(r.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
        if (status < 200 || status >= 300) { clearTimeout(timer); r.resume(); reject(new Error(`the image answered ${status}`)); return; }
        if (!type.startsWith('image/')) { clearTimeout(timer); r.resume(); reject(new Refused(`that address is not an image (${type || 'no content type'})`)); return; }
        const chunks: Buffer[] = [];
        let size = 0;
        r.on('data', (c: Buffer) => {
          size += c.length;
          if (size > IMAGE_MAX_BYTES) { clearTimeout(timer); req.destroy(); reject(new Refused('that image is over 3 MB')); return; }
          chunks.push(c);
        });
        r.on('end', () => { clearTimeout(timer); resolve({ type, bytes: Buffer.concat(chunks) }); });
        r.on('error', (e) => { clearTimeout(timer); reject(e); });
      });
      req.end();
    });
  }

  return {
    ports,
    close: async () => {
      for (const s of sockets) s.destroy();
      await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
    },
  };
}

/** Lowercase, no trailing dot, no brackets around an IPv6 address. */
function normalHost(h: string): string {
  let x = h.trim().toLowerCase();
  if (x.endsWith('.')) x = x.slice(0, -1);
  if (x.startsWith('[') && x.endsWith(']')) x = x.slice(1, -1);
  return x;
}

/** The host of a Host header value, without its port: a name or an IP address, else null. */
export function hostOfHeader(value: string): string | null {
  const v = value.trim();
  const m = /^\[([0-9a-f:.]+)\](?::\d{1,5})?$/i.exec(v) ?? /^([a-z0-9.-]{1,253})(?::\d{1,5})?$/i.exec(v);
  return m ? m[1]! : null;
}

/* ------------------------------ public addresses ------------------------------ */

const LOCAL = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) LOCAL.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 128], ['::1', 128], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10],
  ['fec0::', 10], ['ff00::', 8],
] as const) LOCAL.addSubnet(net, prefix, 'ipv6');

/** Eight 16-bit groups of an IPv6 address, or null. */
function groups6(ip: string): number[] | null {
  let s = ip.split('%')[0]!;
  const tail: number[] = [];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const p = dotted[1]!.split('.').map(Number);
    tail.push((p[0]! << 8) | p[1]!, (p[2]! << 8) | p[3]!);
    s = s.slice(0, -dotted[1]!.length);
    if (s.endsWith(':') && !s.endsWith('::')) s = s.slice(0, -1);
  }
  const [a, b] = s.split('::');
  const head = a ? a.split(':').filter(Boolean).map((g) => parseInt(g, 16)) : [];
  const rest = b !== undefined ? (b ? b.split(':').filter(Boolean).map((g) => parseInt(g, 16)) : []) : null;
  const known = head.length + (rest?.length ?? 0) + tail.length;
  const all = rest === null ? [...head, ...tail] : [...head, ...new Array(8 - known).fill(0), ...rest, ...tail];
  return all.length === 8 && all.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? all : null;
}

/**
 * Whether an address is somewhere on the internet rather than this machine,
 * its network, or a range that is never routed. An IPv6 address carrying an
 * IPv4 one (mapped, NAT64, 6to4) is judged by the IPv4 address inside.
 */
export function isPublicAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return !LOCAL.check(ip, 'ipv4');
  if (v !== 6) return false;
  const g = groups6(ip);
  if (!g) return false;
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zero(0, 5) && g[5] === 0xffff) return isPublicAddress(v4(g[6]!, g[7]!)); // ::ffff:a.b.c.d
  if (zero(0, 6) && (g[6] || g[7]) && !(g[6] === 0 && g[7] === 1)) return isPublicAddress(v4(g[6]!, g[7]!)); // ::a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return isPublicAddress(v4(g[6]!, g[7]!)); // NAT64
  if (g[0] === 0x2002) return isPublicAddress(v4(g[1]!, g[2]!)); // 6to4
  return !LOCAL.check(g.map((x) => x.toString(16)).join(':'), 'ipv6');
}

/* ------------------------------ what a TLS connection is for ------------------------------ */

/**
 * The server name in a TLS ClientHello: a string, null when the hello names
 * none or is not one, undefined while more bytes are needed. The hello may
 * span several records; their handshake bytes are joined.
 */
export function sniOf(buf: Buffer): string | null | undefined {
  let hs = Buffer.alloc(0);
  let off = 0;
  for (;;) {
    if (buf.length < off + 5) return undefined;
    if (buf[off] !== 0x16) return null;
    const len = buf.readUInt16BE(off + 3);
    if (buf.length < off + 5 + len) return undefined;
    hs = Buffer.concat([hs, buf.subarray(off + 5, off + 5 + len)]);
    off += 5 + len;
    if (hs.length >= 4) {
      if (hs[0] !== 0x01) return null;
      const hsLen = (hs[1]! << 16) | (hs[2]! << 8) | hs[3]!;
      if (hs.length >= 4 + hsLen) return sniInHello(hs.subarray(4, 4 + hsLen));
    }
  }
}

/** The one host_name in the hello's server_name extension; null when absent, repeated or malformed. */
function sniInHello(h: Buffer): string | null {
  try {
    let p = 2 + 32; // version, random
    p += 1 + h[p]!; // session id
    p += 2 + h.readUInt16BE(p); // cipher suites
    p += 1 + h[p]!; // compression
    if (p + 2 > h.length) return null;
    const end = p + 2 + h.readUInt16BE(p);
    p += 2;
    let found: string | null = null;
    let seen = false;
    while (p + 4 <= end) {
      const type = h.readUInt16BE(p);
      const len = h.readUInt16BE(p + 2);
      p += 4;
      if (type === 0) {
        // A second server_name extension, or a second name in it, is refused:
        // which one the far side honours is not ours to guess.
        if (seen) return null;
        seen = true;
        let q = p + 2;
        const listEnd = p + 2 + h.readUInt16BE(p);
        while (q + 3 <= listEnd) {
          const kind = h[q]!;
          const n = h.readUInt16BE(q + 1);
          if (kind === 0) {
            if (found !== null) return null;
            const name = h.subarray(q + 3, q + 3 + n).toString('latin1');
            if (!/^[a-z0-9.-]{1,253}$/i.test(name)) return null;
            found = name;
          }
          q += 3 + n;
        }
      }
      p += len;
    }
    return found;
  } catch {
    return null;
  }
}

/** `hello.app_network`: the revision of this fence, raised when what it holds changes. */
export const APP_NETWORK_REVISION = 1;
