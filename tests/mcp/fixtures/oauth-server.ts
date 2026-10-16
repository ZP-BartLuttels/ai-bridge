/**
 * A fake OAuth authorization server + protected MCP server for the upstream
 * sign-in tests, all on one local HTTP server: RFC 9728 protected resource
 * metadata, RFC 8414 metadata, RFC 7591 registration, PKCE S256 code exchange,
 * refresh, and an MCP endpoint that answers 401 without a valid bearer token.
 * Knobs let a test break any step.
 */
import { createServer, type Server as HttpServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

interface Code { client_id: string; redirect_uri: string; challenge: string; resource: string | null; scope: string | null }

export interface FakeOAuth {
  base: string;
  url: string;
  /** Registration bodies received. */
  registrations: Record<string, unknown>[];
  /** Token endpoint bodies received (grant_type and friends). */
  tokenRequests: Record<string, string>[];
  /** Access tokens issued, in order. */
  issued: string[];
  /** Bearer tokens the MCP endpoint saw, in order (null: none). */
  bearers: (string | null)[];
  knobs: {
    expiresIn: number;
    failRefresh: boolean;
    /** The MCP endpoint answers 401 to every token. */
    rejectAll: boolean;
    noRegistration: boolean;
    noMetadata: boolean;
    issParam: boolean;
    failExchange: boolean;
  };
  /** Play the person approving: the code the authorize endpoint would put on the redirect. */
  approve(authorizationUrl: string): { code: string; state: string; redirect_uri: string; params: URLSearchParams };
  /** Invalidate every access token issued so far (refresh tokens stay good). */
  expireAccessTokens(): void;
  close(): Promise<void>;
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function makeMcp(state: { lastToken: string | null }): Server {
  const server = new Server({ name: 'kz', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    { name: 'plain', description: 'No view', inputSchema: { type: 'object', properties: {} } },
    { name: 'echo_token', description: 'Leaks the token it got', inputSchema: { type: 'object', properties: {} } },
  ] }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name === 'plain') return { content: [{ type: 'text', text: 'plain ok' }] };
    if (req.params.name === 'echo_token') return { content: [{ type: 'text', text: `token=${state.lastToken}` }], structuredContent: { t: state.lastToken } };
    throw new Error('no such tool');
  });
  return server;
}

export async function startFakeOAuth(): Promise<FakeOAuth> {
  const codes = new Map<string, Code>();
  const access = new Map<string, number>(); // token -> expires at ms
  const refresh = new Map<string, string>(); // refresh token -> client_id
  const clients = new Map<string, Record<string, unknown>>();
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const mcpState = { lastToken: null as string | null };
  let base = '';
  const fake: Omit<FakeOAuth, 'base' | 'url' | 'close'> = {
    registrations: [], tokenRequests: [], issued: [], bearers: [],
    knobs: { expiresIn: 3600, failRefresh: false, rejectAll: false, noRegistration: false, noMetadata: false, issParam: false, failExchange: false },
    approve(authorizationUrl) {
      const u = new URL(authorizationUrl);
      const p = u.searchParams;
      if (p.get('response_type') !== 'code') throw new Error('response_type');
      if (p.get('code_challenge_method') !== 'S256') throw new Error('S256');
      const client = clients.get(p.get('client_id') ?? '');
      if (!client) throw new Error('unknown client');
      if (!(client['redirect_uris'] as string[]).includes(p.get('redirect_uri') ?? '')) throw new Error('redirect_uri');
      const code = `code-${randomUUID()}`;
      codes.set(code, { client_id: p.get('client_id')!, redirect_uri: p.get('redirect_uri')!, challenge: p.get('code_challenge')!, resource: p.get('resource'), scope: p.get('scope') });
      return { code, state: p.get('state')!, redirect_uri: p.get('redirect_uri')!, params: p };
    },
    expireAccessTokens() { for (const k of access.keys()) access.set(k, 0); },
  };
  const mint = (clientId: string) => {
    const a = `at-${randomUUID()}`;
    const r = `rt-${randomUUID()}`;
    access.set(a, Date.now() + fake.knobs.expiresIn * 1000);
    refresh.set(r, clientId);
    fake.issued.push(a);
    return { access_token: a, refresh_token: r, token_type: 'Bearer', expires_in: fake.knobs.expiresIn };
  };
  const json = (res: import('node:http').ServerResponse, status: number, v: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(v));
  };

  const http: HttpServer = createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', base);
    try {
      if (u.pathname === '/.well-known/oauth-protected-resource/mcp') {
        return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ['mcp:use'] });
      }
      if (u.pathname === '/.well-known/oauth-authorization-server' || u.pathname === '/.well-known/openid-configuration') {
        if (fake.knobs.noMetadata) return json(res, 404, {});
        return json(res, 200, {
          issuer: base,
          authorization_endpoint: `${base}/oauth/authorize`,
          token_endpoint: `${base}/oauth/token`,
          ...(fake.knobs.noRegistration ? {} : { registration_endpoint: `${base}/oauth/register` }),
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
          ...(fake.knobs.issParam ? { authorization_response_iss_parameter_supported: true } : {}),
        });
      }
      if (u.pathname === '/oauth/register' && req.method === 'POST') {
        const b = JSON.parse(await body(req)) as Record<string, unknown>;
        fake.registrations.push(b);
        const client_id = `client-${randomUUID()}`;
        clients.set(client_id, b);
        return json(res, 201, { ...b, client_id, client_id_issued_at: Math.floor(Date.now() / 1000) });
      }
      if (u.pathname === '/oauth/token' && req.method === 'POST') {
        const p = Object.fromEntries(new URLSearchParams(await body(req)));
        fake.tokenRequests.push(p);
        if (p['grant_type'] === 'authorization_code') {
          const c = codes.get(p['code'] ?? '');
          codes.delete(p['code'] ?? '');
          if (fake.knobs.failExchange || !c || c.client_id !== p['client_id'] || c.redirect_uri !== p['redirect_uri']) {
            return json(res, 400, { error: 'invalid_grant', error_description: 'bad code' });
          }
          const challenge = createHash('sha256').update(p['code_verifier'] ?? '').digest('base64url');
          if (challenge !== c.challenge) return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE' });
          return json(res, 200, mint(c.client_id));
        }
        if (p['grant_type'] === 'refresh_token') {
          if (fake.knobs.failRefresh || !refresh.has(p['refresh_token'] ?? '')) {
            return json(res, 400, { error: 'invalid_grant', error_description: 'refresh token revoked' });
          }
          const owner = refresh.get(p['refresh_token']!)!;
          if (owner !== p['client_id']) return json(res, 400, { error: 'invalid_grant', error_description: 'issued to another client' });
          refresh.delete(p['refresh_token']!);
          return json(res, 200, mint(owner));
        }
        return json(res, 400, { error: 'unsupported_grant_type' });
      }
      if (u.pathname === '/mcp') {
        const h = req.headers['authorization'];
        const tok = typeof h === 'string' && h.startsWith('Bearer ') ? h.slice(7) : null;
        fake.bearers.push(tok);
        const exp = tok ? access.get(tok) : undefined;
        if (!tok || exp === undefined || exp < Date.now() || fake.knobs.rejectAll) {
          res.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` }).end();
          return;
        }
        mcpState.lastToken = tok;
        const sid = req.headers['mcp-session-id'] as string | undefined;
        let transport = sid ? transports.get(sid) : undefined;
        if (!transport) {
          if (sid) { res.writeHead(404).end(); return; }
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => { transports.set(id, transport!); },
          });
          await makeMcp(mcpState).connect(transport);
        }
        await transport.handleRequest(req, res);
        return;
      }
      res.writeHead(404).end();
    } catch (err) {
      if (!res.headersSent) res.writeHead(500).end(String(err));
    }
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  return {
    ...fake,
    base,
    url: `${base}/mcp`,
    close: async () => {
      http.closeAllConnections();
      await new Promise<void>((r) => http.close(() => r()));
    },
  } as FakeOAuth;
}
