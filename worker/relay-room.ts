/**
 * One RelayRoom per link key. Forwards MCP tool calls to the editor tab connected on /bridge.
 * Editor sockets use the hibernation API, so an idle connected tab costs nothing; the owning
 * session is kept in the socket attachment and restored when the object wakes up.
 */
import { DurableObject } from 'cloudflare:workers';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { RelayCore, type RelaySocket } from '../packages/mcp/src/relay';
import { buildMcpServer } from '../packages/mcp/src/tools';
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
  private relay = new RelayCore();
  private wrappers = new WeakMap<WebSocket, RelaySocket>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    for (const ws of ctx.getWebSockets()) {
      const a = (ws.deserializeAttachment() ?? {}) as Attachment;
      if (a.owner && a.session) this.relay.restoreOwner(this.wrap(ws), a.session);
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
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }), { status: 405, headers: { 'content-type': 'application/json', allow: 'POST' } });
    }
    // Stateless MCP: a fresh server and transport per request, JSON responses.
    const server = buildMcpServer(this.relay);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(request);
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string' || message.length > BRIDGE_MAX_PAYLOAD) return;
    const sock = this.wrap(ws);
    this.relay.onMessage(sock, message);
    if (this.relay.isOwner(sock)) {
      for (const other of this.ctx.getWebSockets()) {
        const a = (other.deserializeAttachment() ?? {}) as Attachment;
        const owner = other === ws;
        if (!!a.owner !== owner) other.serializeAttachment({ ...a, owner, session: owner ? (this.relay.ownerSession ?? undefined) : a.session });
      }
    }
  }

  override async webSocketClose(ws: WebSocket, code: number) {
    this.relay.onClose(this.wrap(ws));
    try {
      ws.close(code === 1005 ? 1000 : code, 'closing');
    } catch {
      /* already closed */
    }
  }

  override async webSocketError(ws: WebSocket) {
    this.relay.onClose(this.wrap(ws));
  }
}
