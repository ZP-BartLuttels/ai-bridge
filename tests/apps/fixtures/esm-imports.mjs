// An app backend written as ES modules, with named imports from every module
// the network fence patches (src/apps/guard.ts), used by network-fence.test.ts.
// A named import that does not link stops the process before any line of it
// runs, so merely answering proves they all linked. Each request answers what
// the imported functions do: they must be the fenced ones.
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { lookup, lookupService, promises as dnsPromisesNs, Resolver } from 'node:dns';
import { lookup as lookupP, lookupService as lookupServiceP, Resolver as ResolverP } from 'node:dns/promises';
import { connect, createConnection, isIP, Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { get as httpGet, request as httpRequest } from 'node:http';
import { get as httpsGet, request as httpsRequest } from 'node:https';
import { createSocket } from 'node:dgram';
import { setFlagsFromString } from 'node:v8';
import dnsDefault from 'node:dns';

const require = createRequire(import.meta.url);
const imported = { lookup, lookupService, lookupP, lookupServiceP, setFlagsFromString };
const fromRequire = {
  lookup: require('dns').lookup,
  lookupService: require('dns').lookupService,
  lookupP: require('dns/promises').lookup,
  lookupServiceP: require('dns/promises').lookupService,
  setFlagsFromString: require('v8').setFlagsFromString,
};
const linked = [Resolver, ResolverP, connect, createConnection, isIP, Socket, tlsConnect, httpGet, httpRequest, httpsGet, httpsRequest, createSocket, dnsPromisesNs]
  .every((f) => f !== undefined);

async function attempt(b) {
  switch (b.op) {
    case 'linked': return linked && dnsDefault.lookup === lookup ? 'linked' : 'missing';
    case 'same': return Object.entries(imported).filter(([k, f]) => f !== fromRequire[k]).map(([k]) => k).join(',') || 'same';
    case 'lookup': try { return `resolved:${(await lookupP(b.name)).address}`; } catch (e) { return `stopped: ${e.code}`; }
    case 'v8flags': try { setFlagsFromString('--allow-natives-syntax'); return 'changed'; } catch (e) { return `stopped: ${e.message}`; }
    default: return `unknown op ${b.op}`;
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line);
  attempt(JSON.parse(req.body || '{}')).then((result) => {
    process.stdout.write(JSON.stringify({ id: req.id, status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ result }) }) + '\n');
  });
});
