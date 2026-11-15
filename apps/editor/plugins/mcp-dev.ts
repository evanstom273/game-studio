/**
 * The cloud side of the AI connection inside the Vite dev server, so `npm run dev` behaves like the
 * Cloudflare deployment: /mcp/<key> (AI apps), /sync/<key>/... (editor sync), /github/<key>/...
 * (the editor's GitHub connection) and /bridge/<key>
 * (editor sockets), backed by the same CloudRoom as the Durable Object (worker/relay-room.ts).
 * The dev "cloud copy" lives in memory and is lost when the dev server stops.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { Plugin, ViteDevServer } from 'vite';
import { WebSocketServer, type WebSocket } from 'ws';

type RoomModule = typeof import('../../../packages/mcp/src/cloud/room.ts');
type StoreModule = typeof import('../../../packages/mcp/src/cloud/store.ts');
type Room = InstanceType<RoomModule['CloudRoom']>;

const LINK_KEY_RE = /^[A-Za-z0-9_-]{32,128}$/;
const MAX_BODY = 80 * 1024 * 1024;
const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, accept, authorization, mcp-session-id, mcp-protocol-version, last-event-id',
  'access-control-expose-headers': 'mcp-session-id, mcp-protocol-version',
};

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error('Request too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

async function sendResponse(res: ServerResponse, response: Response, extra: Record<string, string> = {}) {
  res.statusCode = response.status;
  response.headers.forEach((v, k) => res.setHeader(k, v));
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  res.end(Buffer.from(await response.arrayBuffer()));
}

export function mcpDevRelay(): Plugin {
  return {
    name: 'gs-mcp-dev-cloud',
    configureServer(server: ViteDevServer) {
      const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
      let modules: Promise<{ room: RoomModule; store: StoreModule }> | null = null;
      const load = () => (modules ??= Promise.all([server.ssrLoadModule(here('../../../packages/mcp/src/cloud/room.ts')), server.ssrLoadModule(here('../../../packages/mcp/src/cloud/store.ts'))]).then(([room, store]) => ({ room: room as RoomModule, store: store as StoreModule })));
      const keyMod = () => server.ssrLoadModule(here('../../../packages/mcp/src/keys.ts')) as Promise<typeof import('../../../packages/mcp/src/keys.ts')>;
      const rooms = new Map<string, { room: Room; sockets: Set<WebSocket> }>();
      const room = async (key: string) => {
        const { roomName } = await keyMod();
        const name = await roomName(key);
        let r = rooms.get(name);
        if (!r) {
          const { room: R, store: S } = await load();
          const sockets = new Set<WebSocket>();
          r = { room: new R.CloudRoom(new S.MemoryKv(), (text) => sockets.forEach((ws) => ws.send(text))), sockets };
          rooms.set(name, r);
        }
        return r;
      };
      const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });

      server.httpServer?.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        const m = /^\/bridge\/([^/?]+)/.exec(req.url ?? '');
        if (!m) return; // Vite's HMR socket and others
        const host = req.headers.host;
        const origin = req.headers.origin;
        if (!LINK_KEY_RE.test(m[1]) || !origin || !host || new URL(origin).host !== host) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
          void room(m[1]).then(({ room: r, sockets }) => {
            sockets.add(ws);
            const sock = { send: (t: string) => ws.send(t), close: (c: number, why: string) => ws.close(c, why) };
            ws.on('message', (data, isBinary) => {
              if (isBinary) return;
              const text = data.toString();
              if (text === 'ping') ws.send('pong');
              else r.onMessage(sock, text);
            });
            ws.on('close', () => {
              sockets.delete(ws);
              r.onClose(sock);
            });
          });
        });
      });

      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const url = req.url ?? '';
        const mcp = /^\/mcp(?:\/([^/?]+))?\/?(\?.*)?$/.exec(url);
        const sync = /^\/sync\/([^/]+)(\/[^?]*)/.exec(url);
        const github = /^\/github\/([^/]+)(\/[^?]*)/.exec(url);
        if (!mcp && !sync && !github) return next();
        try {
          if (mcp) {
            for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.end();
              return;
            }
          }
          const { keyFromRequest } = await keyMod();
          const pathKey = sync?.[1] ?? github?.[1] ?? '';
          const key = mcp ? keyFromRequest(mcp[1], (req.headers.authorization as string | undefined) ?? null) : LINK_KEY_RE.test(pathKey) ? pathKey : null;
          if (!key) {
            res.statusCode = 401;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ error: 'Missing or invalid Game Studio link' }));
            return;
          }
          if ((sync || github) && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) {
            res.statusCode = 403;
            res.end('Origin not allowed');
            return;
          }
          const { room: r } = await room(key);
          const body = req.method === 'GET' || req.method === 'HEAD' || req.method === 'DELETE' ? undefined : await readBody(req);
          const headers = new Headers();
          for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
          const request = new Request(`http://${req.headers.host}${url}`, { method: req.method, headers, body });
          const response = mcp ? await r.mcp(request) : sync ? await r.sync(request, sync[2]) : await r.github(request, github![2]);
          await sendResponse(res, response);
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
        }
      });
    },
  };
}
