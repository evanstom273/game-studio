/**
 * Game Studio on Cloudflare Workers (static assets + this script).
 *
 *  - Everything except /mcp* and /bridge/* is the editor, served from static assets (SPA).
 *  - /mcp/<key> (or /mcp with "Authorization: Bearer <key>"): the MCP endpoint for AI apps
 *    (Streamable HTTP, stateless JSON responses).
 *  - /bridge/<key>: the editor tab's WebSocket.
 *
 *  - /sync/<key>/...: the editor's sync API (same origin only).
 *
 * Each key maps to one Durable Object (named by the key's SHA-256) holding the cloud copy of that
 * user's projects: AI assistants edit it with no editor open, and editors sync with it. Without the
 * key there is nothing to reach; the user's permission choices are enforced there too.
 */
import { keyFromRequest, roomName } from '../packages/mcp/src/keys';
import { LINK_KEY_RE } from '../packages/mcp/src/protocol';
import { RelayRoom, type Env } from './relay-room';

export { RelayRoom };

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, accept, authorization, mcp-session-id, mcp-protocol-version, last-event-id',
  'access-control-expose-headers': 'mcp-session-id, mcp-protocol-version',
};

const json = (status: number, body: unknown, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...extra } });

async function room(env: Env, key: string) {
  return env.RELAY.get(env.RELAY.idFromName(await roomName(key)));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const mcp = /^\/mcp(?:\/([^/]+))?\/?$/.exec(url.pathname);
    if (mcp) {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      const key = keyFromRequest(mcp[1], request.headers.get('authorization'));
      if (!key) return json(401, { error: 'Missing or invalid Game Studio link. Copy it from Game Studio → AI connection.' }, CORS);
      const inner = new Request(new URL('/mcp', url), request);
      const res = await (await room(env, key)).fetch(inner);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    }
    const sync = /^\/sync\/([^/]+)(\/.*)$/.exec(url.pathname);
    if (sync) {
      if (!LINK_KEY_RE.test(sync[1])) return json(404, { error: 'Unknown link' });
      // Only the editor served by this site may sync.
      if (request.headers.get('origin') && request.headers.get('origin') !== url.origin) return json(403, { error: 'Origin not allowed' });
      return (await room(env, sync[1])).fetch(new Request(new URL(`/sync${sync[2]}`, url), request));
    }
    const bridge = /^\/bridge\/([^/]+)\/?$/.exec(url.pathname);
    if (bridge) {
      if (!LINK_KEY_RE.test(bridge[1])) return json(404, { error: 'Unknown link' });
      // Only the editor served by this site may open the bridge.
      const origin = request.headers.get('origin');
      if (origin !== url.origin) return json(403, { error: 'Origin not allowed' });
      return (await room(env, bridge[1])).fetch(new Request(new URL('/bridge', url), request));
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
