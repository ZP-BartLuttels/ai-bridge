// An app backend that tries to get out, used by network-fence.test.ts.
// Each request's body is one attempt, {op, ...}. The answer is {result}:
// "reached:<id>" when a marker from one of the suite's listeners came back
// (each listener answers "REACHED:<its id>"), or "stopped: <why>" when
// something refused it. Some ops answer a list, one result per step.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const dgram = require('dgram');
const dns = require('dns');

const ca = fs.readFileSync(path.join(__dirname, 'ca.pem'), 'utf8');
if (typeof tls.setDefaultCACertificates === 'function') {
  tls.setDefaultCACertificates([...tls.getCACertificates('default'), ca]);
}

const MARK = /REACHED:([a-z0-9-]+)/;
const reached = (text) => { const m = MARK.exec(String(text)); return m ? `reached:${m[1]}` : null; };
const stopped = (e) => `stopped: ${(e && (e.code || e.name)) || ''} ${String((e && ((e.cause && (e.cause.code || e.cause.message)) || e.message)) || e).slice(0, 200)}`.trim();
const within = (ms, p) => Promise.race([p, new Promise((r) => setTimeout(() => r('stopped: timeout'), ms))]);
const status = (code, refusedBy, text) => `stopped: HTTP ${code}${refusedBy ? ` (refused by the bridge: ${refusedBy})` : ''} ${String(text).slice(0, 120)}`.trim();

async function viaFetch(url, init = {}) {
  try {
    const res = await fetch(url, init);
    const text = await res.text();
    return reached(text) ?? status(res.status, res.headers.get('x-engram-refused'), text);
  } catch (e) { return stopped(e); }
}

function viaModule(mod, url, opts = {}) {
  return new Promise((resolve) => {
    try {
      const req = mod.get(url, { ca, ...opts }, (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => resolve(reached(text) ?? status(res.statusCode, res.headers['x-engram-refused'], text)));
      });
      req.on('error', (e) => resolve(stopped(e)));
    } catch (e) { resolve(stopped(e)); }
  });
}

/** Write `data` on a raw socket (plain or TLS), read until it closes, report every marker or the first status line. */
function raw(connect, data) {
  return new Promise((resolve) => {
    let text = '';
    let s;
    try { s = connect(); } catch (e) { resolve(stopped(e)); return; }
    s.on('error', (e) => resolve(text ? summarize(text) : stopped(e)));
    s.on('data', (c) => { text += c; });
    s.on('close', () => resolve(summarize(text)));
    const send = () => { if (data) s.write(data); };
    if (s instanceof tls.TLSSocket) s.once('secureConnect', send); else s.once('connect', send);
    setTimeout(() => s.destroy(), 3000);
  });
}
function summarize(text) {
  const marks = [...String(text).matchAll(/REACHED:([a-z0-9-]+)/g)].map((m) => `reached:${m[1]}`);
  const statuses = [...String(text).matchAll(/HTTP\/1\.1 (\d{3})/g)].map((m) => m[1]);
  if (marks.length) return [...marks, ...statuses.filter((s) => s !== '200').map((s) => `stopped: HTTP ${s}`)].join(' + ');
  return statuses.length ? `stopped: HTTP ${statuses.join(',')}` : 'stopped: closed with no answer';
}

async function attempt(req) {
  const b = JSON.parse(req.body || '{}');
  switch (b.op) {
    case 'fetch': return viaFetch(b.url, { headers: b.headers || {}, redirect: b.redirect || 'follow' });
    case 'http': return viaModule(http, b.url, { headers: b.headers || {} });
    case 'https': return viaModule(https, b.url, { headers: b.headers || {}, servername: b.servername });
    case 'engram': return viaFetch(`${req.engram.api}/ping`, { headers: { authorization: `Bearer ${req.engram.token}` } });
    case 'net': return raw(() => net.connect({ host: b.host, port: b.port }), b.data);
    case 'tls': return raw(() => tls.connect({ host: b.host, port: b.port, servername: b.servername, ca }), b.data);
    case 'unix': return raw(() => net.connect({ path: b.path }), 'GET / HTTP/1.1\r\nHost: x\r\n\r\n');
    case 'keepalive': {
      // One socket for every request: a reused connection asked for another Host.
      const mod = b.url.startsWith('https:') ? https : http;
      const agent = new mod.Agent({ keepAlive: true, maxSockets: 1 });
      const out = [];
      for (const host of b.hosts) out.push(await viaModule(mod, b.url, { agent, headers: { host } }));
      agent.destroy();
      return out;
    }
    case 'connect_method': return new Promise((resolve) => {
      const r = http.request({ host: b.host, port: b.port, method: 'CONNECT', path: b.target, headers: { host: b.host } });
      r.on('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode === 200 ? 'reached:tunnel' : status(res.statusCode, res.headers['x-engram-refused'], '')); });
      r.on('response', (res) => { res.resume(); resolve(status(res.statusCode, res.headers['x-engram-refused'], '')); });
      r.on('error', (e) => resolve(stopped(e)));
      r.end();
    });
    case 'dgram': return new Promise((resolve) => {
      try {
        const s = dgram.createSocket(b.family === 6 ? 'udp6' : 'udp4');
        s.on('error', (e) => { s.close(); resolve(stopped(e)); });
        s.send(Buffer.from('REACHED?'), b.port, b.host, (e) => { if (e) { s.close(); resolve(stopped(e)); } else { s.close(); resolve('sent'); } });
      } catch (e) { resolve(stopped(e)); }
    });
    case 'dns_lookup': return new Promise((resolve) => {
      try { dns.lookup(b.name, (e, a) => resolve(e ? stopped(e) : `resolved:${a}`)); } catch (e) { resolve(stopped(e)); }
    });
    case 'dns_resolve': return new Promise((resolve) => {
      try { dns.resolve4(b.name, (e, a) => resolve(e ? stopped(e) : `resolved:${a}`)); } catch (e) { resolve(stopped(e)); }
    });
    case 'listen': return new Promise((resolve) => {
      try {
        const s = net.createServer();
        s.on('error', (e) => resolve(stopped(e)));
        s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(); resolve(`listening:${p}`); });
      } catch (e) { resolve(stopped(e)); }
    });
    case 'binding': try { return `got:${typeof process.binding('tcp_wrap').TCP}`; } catch (e) { return stopped(e); }
    case 'v8flags': try { require('v8').setFlagsFromString('--allow-natives-syntax'); return 'changed'; } catch (e) { return stopped(e); }
    case 'undo_fence': {
      // Put the real lookup back, or the real connect, then go for the undeclared host.
      const out = [];
      try { dns.lookup = (h, o, cb) => (typeof o === 'function' ? o : cb)(null, '127.0.0.1', 4); out.push(dns.lookup === undefined ? 'replaced' : 'lookup still fenced'); } catch (e) { out.push(stopped(e)); }
      try { Object.defineProperty(dns, 'lookup', { value: () => {} }); out.push('redefined lookup'); } catch (e) { out.push(stopped(e)); }
      try {
        const probe = new net.Socket();
        probe.on('error', () => {});
        probe.connect({ host: 'x.invalid', port: 9, lookup() {} });
        const TCP = probe._handle.constructor;
        probe.destroy();
        Object.defineProperty(TCP.prototype, 'connect', { value: function () { return 0; } });
        out.push('redefined TCP connect');
      } catch (e) { out.push(stopped(e)); }
      out.push(await viaFetch(b.url));
      return out;
    }
    case 'loadcode': {
      // Fetch code from a host and run it: the fetch is refused, so nothing runs.
      let code;
      try {
        const res = await fetch(b.url);
        if (res.headers.get('x-engram-refused')) return `${status(res.status, res.headers.get('x-engram-refused'), '')}; evaluated: no`;
        code = await res.text();
      } catch (e) { return `${stopped(e)}; evaluated: no`; }
      try { return `evaluated: ${String(eval(code))}`; } catch (e) { return `fetched but did not run: ${e.message}`; }
    }
    case 'image': {
      const base = process.env.ENGRAM_IMAGE_FETCH;
      if (!base) return 'stopped: no image fetcher';
      try {
        const res = await fetch(`${base}?url=${encodeURIComponent(b.url)}`, b.method ? { method: b.method } : {});
        const bytes = Buffer.from(await res.arrayBuffer());
        return res.ok ? `image:${res.headers.get('content-type')}:${bytes.length}` : status(res.status, res.headers.get('x-engram-refused'), bytes.toString());
      } catch (e) { return stopped(e); }
    }
    case 'env': return Object.keys(process.env).sort().join(',');
    default: return `unknown op ${b.op}`;
  }
}

const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const req = JSON.parse(line);
  within(8000, attempt(req)).then((result) => {
    process.stdout.write(JSON.stringify({ id: req.id, status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ result }) }) + '\n');
  });
});
