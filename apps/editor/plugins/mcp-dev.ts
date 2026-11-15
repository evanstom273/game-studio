/**
 * The MCP relay inside the Vite dev server, so `npm run dev` gives a working AI connection
 * at http://localhost:5173/mcp/<key> without Cloudflare. Same RelayCore and tool set as the
 * Durable Object in production (worker/relay-room.ts).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Plugin } from 'vite';
import { WebSocketServer, type WebSocket } from 'ws';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { RelayCore, type RelaySocket } from '../../../packages/mcp/src/relay';
import { buildMcpServer } from '../../../packages/mcp/src/tools';
import { keyFromRequest, roomName } from '../../../packages/mcp/src/keys';
import { BRIDGE_MAX_PAYLOAD, LINK_KEY_RE } from '../../../packages/mcp/src/protocol';

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
    if (size > BRIDGE_MAX_PAYLOAD) throw new Error('Request too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

export function mcpDevRelay(): Plugin {
  const rooms = new Map<string, RelayCore>();
  const room = async (key: string) => {
    const name = await roomName(key);
    let r = rooms.get(name);
    if (!r) rooms.set(name, (r = new RelayCore()));
    return r;
  };
  const wss = new WebSocketServer({ noServer: true, maxPayload: BRIDGE_MAX_PAYLOAD });

  return {
    name: 'gs-mcp-dev-relay',
    configureServer(server) {
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
          void room(m[1]).then((relay) => {
            const sock: RelaySocket = { send: (t) => ws.send(t), close: (c, r) => ws.close(c, r) };
            ws.on('message', (data, isBinary) => {
              if (isBinary) return;
              const text = data.toString();
              if (text === 'ping') ws.send('pong');
              else relay.onMessage(sock, text);
            });
            ws.on('close', () => relay.onClose(sock));
          });
        });
      });

      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const m = /^\/mcp(?:\/([^/?]+))?\/?(\?.*)?$/.exec(req.url ?? '');
        if (!m) return next();
        for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
        if (req.method === 'OPTIONS') {
          res.statusCode = 204;
          res.end();
          return;
        }
        const key = keyFromRequest(m[1], (req.headers.authorization as string | undefined) ?? null);
        if (!key) {
          res.statusCode = 401;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: 'Missing or invalid Game Studio link' }));
          return;
        }
        try {
          const relay = await room(key);
          const body = req.method === 'POST' ? await readBody(req) : undefined;
          const headers = new Headers();
          for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
          const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers, body });
          const mcp = buildMcpServer(relay);
          const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
          await mcp.connect(transport);
          const response = await transport.handleRequest(request);
          res.statusCode = response.status;
          response.headers.forEach((v, k) => res.setHeader(k, v));
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
        }
      });
    },
  };
}
