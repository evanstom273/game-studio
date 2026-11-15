/**
 * One RelayRoom per link key: the cloud copy of that user's projects (in this Durable Object's
 * storage), the MCP endpoint that edits it — so AI assistants work with no editor open — the
 * editors' sync API, and the editor sockets (live updates, and running games when asked).
 * Editor sockets use the hibernation API, so a connected idle tab costs nothing.
 */
import { DurableObject } from 'cloudflare:workers';
import { CloudRoom } from '../packages/mcp/src/cloud/room';
import type { KvStore } from '../packages/mcp/src/cloud/store';
import type { RelaySocket } from '../packages/mcp/src/relay';
import { BRIDGE_MAX_PAYLOAD } from '../packages/mcp/src/protocol';

export interface Env {
  RELAY: DurableObjectNamespace<RelayRoom>;
  ASSETS: Fetcher;
}

interface Attachment {
  session?: string;
  owner?: boolean;
}

export class RelayRoom extends DurableObject<Env> {
  private room: CloudRoom;
  private wrappers = new WeakMap<WebSocket, RelaySocket>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    const storage = ctx.storage;
    const kv: KvStore = {
      get: (k) => storage.get(k),
      put: (k, v) => storage.put(k, v),
      delete: async (k) => {
        await storage.delete(k);
      },
      keys: async (prefix) => [...(await storage.list({ prefix })).keys()],
    };
    this.room = new CloudRoom(kv, (text) => {
      for (const ws of ctx.getWebSockets()) {
        try {
          ws.send(text);
        } catch {
          /* closing */
        }
      }
    });
    for (const ws of ctx.getWebSockets()) {
      const a = (ws.deserializeAttachment() ?? {}) as Attachment;
      if (a.owner && a.session) this.room.relay.restoreOwner(this.wrap(ws), a.session);
    }
  }

  private wrap(ws: WebSocket): RelaySocket {
    let w = this.wrappers.get(ws);
    if (!w) {
      w = { send: (t) => ws.send(t), close: (c, r) => ws.close(c, r) };
      this.wrappers.set(ws, w);
    }
    return w;
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/bridge') {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (url.pathname === '/mcp') return this.room.mcp(request);
    if (url.pathname.startsWith('/sync/')) return this.room.sync(request, url.pathname.slice('/sync'.length));
    return new Response('Not found', { status: 404 });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string' || message.length > BRIDGE_MAX_PAYLOAD) return;
    const sock = this.wrap(ws);
    this.room.onMessage(sock, message);
    if (this.room.relay.isOwner(sock)) {
      for (const other of this.ctx.getWebSockets()) {
        const a = (other.deserializeAttachment() ?? {}) as Attachment;
        const owner = other === ws;
        if (!!a.owner !== owner) other.serializeAttachment({ ...a, owner, session: owner ? (this.room.relay.ownerSession ?? undefined) : a.session });
      }
    }
  }

  override async webSocketClose(ws: WebSocket, code: number) {
    this.room.onClose(this.wrap(ws));
    try {
      ws.close(code === 1005 ? 1000 : code, 'closing');
    } catch {
      /* already closed */
    }
  }

  override async webSocketError(ws: WebSocket) {
    this.room.onClose(this.wrap(ws));
  }
}
