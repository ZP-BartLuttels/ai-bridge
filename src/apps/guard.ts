/**
 * The network fence an app backend starts with, as source: written to a file
 * beside the working copies and loaded with `--require` before the app's own
 * code, under Node's permission model (supervisor.ts).
 *
 * WHY IT WORKS AT THE HANDLE LEVEL. Every TCP connection Node makes, whatever
 * started it (fetch, http, https, http2, tls, net, a redirect, a WebSocket),
 * ends in one native call: `connect`/`connect6` on the TCP handle, with the
 * address and port already resolved. So do UDP (`send`, `bind`, `connect` on
 * the UDP handle), local sockets (`connect` on the Pipe handle) and DNS
 * queries (`query*` on c-ares' channel). The fence replaces exactly those
 * methods on their prototypes, before the app runs, with non-writable,
 * non-configurable properties holding the only references to the originals:
 *
 *   - TCP: the connection is made to the bridge's egress listener for the
 *     port asked for (egress.ts), never to the address given. Which host it
 *     is for is read there, outside this process: the TLS server name, or
 *     the Host of each HTTP request. A port with no listener is refused.
 *     Listening is refused, and so is wrapping a descriptor as a socket.
 *   - UDP and local sockets (Unix sockets, Windows named pipes): refused.
 *   - DNS: `dns.lookup` answers only the hosts the app may reach, with a
 *     stand-in address (the egress listener reads the real name from the
 *     connection), and never asks a resolver, so a name cannot carry data out
 *     either. c-ares queries (`dns.resolve*`, `Resolver`) are refused.
 *
 * Patching the public functions instead (net.Socket.prototype.connect,
 * BlockList, the lookup results) would not hold: the app is arbitrary code in
 * the same realm, and async_hooks hands it the very request objects those
 * functions use, so it could swap what they see. At the handle level the
 * address that matters is an argument this fence replaces, and nothing the
 * app can reach still holds the original method.
 *
 * What the permission model already closes, so the fence need not: native
 * bindings (process.binding), addons, WASI, workers, module.register's hooks
 * thread, the inspector and child processes (unless the manifest asks for a
 * shell or programs, where the fence ends: a child runs without it).
 * `v8.setFlagsFromString` is not covered by it and is refused here, because
 * flags such as --allow-natives-syntax are a way under JavaScript's rules.
 *
 * Plain JavaScript with no dependency, written to run on Node 22 and later.
 * It reads its settings from ENGRAM_NETWORK and removes that variable.
 */
export const GUARD_SOURCE = String.raw`'use strict';
(function engramNetworkFence() {
  const ReflectApply = Reflect.apply;
  const defineProperty = Object.defineProperty;
  const hasOwn = Object.hasOwn;
  const create = Object.create;
  const ownSymbols = Object.getOwnPropertySymbols;
  const freeze = Object.freeze;
  const ErrorCtor = Error;
  const TypeErrorCtor = TypeError;
  const PromiseCtor = Promise;
  const call = Function.prototype.call;
  const uncurry = (fn) => call.bind(fn);
  const toLower = uncurry(String.prototype.toLowerCase);
  const endsWith = uncurry(String.prototype.endsWith);
  const slice = uncurry(String.prototype.slice);
  const rawDebug = process._rawDebug;
  const nextTick = process.nextTick;

  let config = null;
  try { config = JSON.parse(process.env.ENGRAM_NETWORK || 'null'); } catch {}
  delete process.env.ENGRAM_NETWORK;
  // No settings: nothing is allowed, rather than everything.
  const ports = create(null);
  const names = create(null);
  if (config && config.ports && typeof config.ports === 'object') {
    for (const k of Object.keys(config.ports)) if (typeof config.ports[k] === 'number') ports[k] = config.ports[k];
  }
  if (config && Array.isArray(config.hosts)) {
    for (const h of config.hosts) if (typeof h === 'string') names[toLower(h)] = true;
  }
  freeze(ports);
  freeze(names);

  const say = (what) => { try { rawDebug('[engram network] ' + what); } catch {} };
  const EACCES = (() => {
    try {
      for (const [code, info] of require('util').getSystemErrorMap()) if (info[0] === 'EACCES') return code;
    } catch {}
    return -13;
  })();
  const lock = (target, key, value) => defineProperty(target, key, { value, writable: false, configurable: false, enumerable: false });
  const refuse = (what) => function refused() { say('refused: ' + what); return EACCES; };
  const isIP = require('net').isIP;

  /* ---------- DNS: only the app's own hosts, and never a real query ---------- */
  const dns = require('dns');
  const dnsPromises = dns.promises;
  const notFound = (hostname) => {
    const e = new ErrorCtor('getaddrinfo ENOTFOUND ' + hostname + ' (Engram: not a host this app declares under "network")');
    e.code = 'ENOTFOUND';
    e.syscall = 'getaddrinfo';
    e.hostname = hostname;
    return e;
  };
  const answer = (hostname, options) => {
    let family = 0;
    let all = false;
    if (typeof options === 'number') family = options;
    else if (options !== null && typeof options === 'object') {
      const f = options.family;
      family = f === 6 || f === 'IPv6' ? 6 : f === 4 || f === 'IPv4' ? 4 : 0;
      all = options.all === true;
    }
    const name = typeof hostname === 'string' ? hostname : '';
    const v = isIP(name);
    let address;
    let fam;
    if (v) { address = name; fam = v; }
    else {
      let key = toLower(name);
      if (endsWith(key, '.')) key = slice(key, 0, -1);
      if (!hasOwn(names, key)) { say('refused a DNS lookup of ' + name); return { err: notFound(name) }; }
      // A stand-in: the egress listener reads the real name from the connection.
      fam = family === 6 ? 6 : 4;
      address = fam === 6 ? '::1' : '127.0.0.1';
    }
    return { all, address, family: fam };
  };
  function lookup(hostname, options, callback) {
    if (typeof options === 'function') { callback = options; options = 0; }
    if (typeof callback !== 'function') throw new TypeErrorCtor('The "callback" argument must be of type function');
    const r = answer(hostname, options);
    nextTick(() => {
      if (r.err) callback(r.err);
      else if (r.all) callback(null, [{ address: r.address, family: r.family }]);
      else callback(null, r.address, r.family);
    });
    return {};
  }
  function lookupPromise(hostname, options) {
    const r = answer(hostname, options);
    return new PromiseCtor((resolve, reject) => {
      if (r.err) reject(r.err);
      else resolve(r.all ? [{ address: r.address, family: r.family }] : { address: r.address, family: r.family });
    });
  }
  function lookupService() { throw new ErrorCtor('Engram: an app backend may not look up names for addresses'); }
  lock(dns, 'lookup', lookup);
  lock(dns, 'lookupService', lookupService);
  lock(dnsPromises, 'lookup', lookupPromise);
  lock(dnsPromises, 'lookupService', function lookupServicePromise() { return PromiseCtor.reject(new ErrorCtor('Engram: an app backend may not look up names for addresses')); });

  const ChannelWrap = new dns.Resolver()._handle.constructor;
  for (const key of Object.getOwnPropertyNames(ChannelWrap.prototype)) {
    if (key === 'getHostByAddr' || slice(key, 0, 5) === 'query') {
      lock(ChannelWrap.prototype, key, function refusedQuery() {
        say('refused a DNS query (' + key + ')');
        throw new ErrorCtor('Engram: an app backend may not send DNS queries; it reaches its declared hosts by name');
      });
    }
  }

  /* ---------- TCP: every connection goes to the egress listener ---------- */
  const net = require('net');
  const probe = new net.Socket();
  probe.on('error', () => {});
  probe.connect({ host: 'engram-network-fence.invalid', port: 9, lookup() {} });
  const TCP = probe._handle && probe._handle.constructor;
  probe.destroy();
  if (typeof TCP !== 'function' || typeof TCP.prototype.connect !== 'function') {
    throw new ErrorCtor('Engram network fence: could not find the TCP handle on this Node version; refusing to start');
  }
  const tcpConnect = TCP.prototype.connect;
  function connect(req, address, port) {
    if (typeof port !== 'number' || !hasOwn(ports, port)) {
      say('refused a connection to ' + address + ':' + port + ' (no egress on that port)');
      return EACCES;
    }
    return ReflectApply(tcpConnect, this, [req, '127.0.0.1', ports[port]]);
  }
  lock(TCP.prototype, 'connect', connect);
  lock(TCP.prototype, 'connect6', connect);
  lock(TCP.prototype, 'listen', refuse('listening on a TCP port'));
  // Wrapping a descriptor the process already holds as a socket is how a
  // socket made elsewhere would be used; stdio here is pipes, never TCP.
  lock(TCP.prototype, 'open', refuse('opening a descriptor as a TCP socket'));

  /* ---------- local sockets and UDP: none ---------- */
  let Pipe = null;
  for (const s of ['stdout', 'stderr', 'stdin']) {
    try {
      const h = process[s] && process[s]._handle;
      if (h && h.constructor && h.constructor.name === 'Pipe') { Pipe = h.constructor; break; }
    } catch {}
  }
  if (!Pipe) {
    const p = new net.Socket();
    p.on('error', () => {});
    try { p.connect({ path: process.platform === 'win32' ? '\\\\.\\pipe\\engram-network-fence-none' : '/engram-network-fence-none' }); } catch {}
    Pipe = p._handle && p._handle.constructor;
    p.destroy();
  }
  if (typeof Pipe !== 'function') throw new ErrorCtor('Engram network fence: could not find the Pipe handle; refusing to start');
  lock(Pipe.prototype, 'connect', refuse('connecting to a local socket or pipe'));
  lock(Pipe.prototype, 'listen', refuse('listening on a local socket or pipe'));
  lock(Pipe.prototype, 'bind', refuse('binding a local socket or pipe'));

  const dgram = require('dgram');
  const u = dgram.createSocket('udp4');
  let UDP = null;
  for (const sym of ownSymbols(u)) {
    const state = u[sym];
    if (state && typeof state === 'object' && state.handle && state.handle.constructor) { UDP = state.handle.constructor; break; }
  }
  u.close();
  if (typeof UDP !== 'function') throw new ErrorCtor('Engram network fence: could not find the UDP handle; refusing to start');
  for (const key of ['bind', 'bind6', 'send', 'send6', 'connect', 'connect6', 'open']) {
    if (typeof UDP.prototype[key] === 'function') lock(UDP.prototype, key, refuse('UDP (' + key + ')'));
  }

  /* ---------- engine flags ---------- */
  lock(require('v8'), 'setFlagsFromString', function setFlagsFromString() {
    throw new ErrorCtor('Engram: an app backend may not change V8 flags');
  });
})();
`;
