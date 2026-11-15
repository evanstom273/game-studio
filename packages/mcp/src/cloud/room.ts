/**
 * One "room" per connector key: the cloud copy of that user's projects, the MCP endpoint that edits
 * it, the sync API editors use, and the editor sockets (live updates + browser-only requests).
 * Transport-agnostic: the Cloudflare Durable Object and the Vite dev server both delegate to it.
 *
 *   POST /mcp                                 MCP (Streamable HTTP, stateless JSON)
 *   GET  /sync/projects                       headers of all projects, tombstones, permissions
 *   GET  /sync/projects/<id>                  a project document
 *   PUT  /sync/projects/<id>  {doc, base}     store it unless the cloud copy moved on (409)
 *   DEL  /sync/projects/<id>                  delete everywhere
 *   POST /sync/blobs/<id>/missing {hashes}    which asset bytes the cloud lacks
 *   PUT  /sync/blobs/<id>/<hash>              upload asset bytes (verified against the hash)
 *   GET  /sync/blobs/<id>/<hash>              download asset bytes
 *   PUT  /sync/settings {permissions, active} the editor's AI-connection choices
 *   *    /github/...                          GitHub token, REST proxy, Cloudflare credentials (github-routes.ts)
 */
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { sha256Hex, toErrorPayload } from '@gs/shared';
import { loadProjectDoc, projectRevision, type ProjectDoc } from '@gs/project';
import { RelayCore, type RelaySocket } from '../relay.ts';
import { buildMcpServer } from '../tools.ts';
import { CloudStore, type KvStore, type Permissions } from './store.ts';
import { CloudService, type CloudNotice } from './service.ts';
import { handleGithubRoute } from './github-routes.ts';

const MAX_DOC = 20 * 1024 * 1024;
const MAX_BLOB = 50 * 1024 * 1024;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export class CloudRoom {
  readonly relay = new RelayCore();
  readonly store: CloudStore;
  readonly service: CloudService;

  constructor(
    kv: KvStore,
    /** Sends a notice to every connected editor. */
    private readonly broadcast: (text: string) => void,
  ) {
    this.store = new CloudStore(kv);
    this.service = new CloudService(
      this.store,
      { connected: () => this.relay.connected, ask: (method, params, timeout) => this.relay.request(method, params, timeout) },
      (n) => this.notify(n),
    );
  }

  notify(n: CloudNotice | { type: 'project-updated'; id: string; revision: string; label: string; by: 'editor' }) {
    this.broadcast(JSON.stringify(n));
  }

  onMessage(sock: RelaySocket, text: string) {
    this.relay.onMessage(sock, text);
  }
  onClose(sock: RelaySocket) {
    this.relay.onClose(sock);
  }

  async mcp(request: Request): Promise<Response> {
    if (request.method !== 'POST') return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }), { status: 405, headers: { 'content-type': 'application/json', allow: 'POST' } });
    const server = buildMcpServer({ request: (method, params = {}) => this.service.handle(method, params) });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(request);
  }

  /** The editor's GitHub endpoints (token, proxy, Cloudflare). `path` is everything after /github. */
  github(request: Request, path: string): Promise<Response> {
    return handleGithubRoute(this.store.kv, request, path);
  }

  /** The editor's sync API. `path` is everything after /sync. */
  async sync(request: Request, path: string): Promise<Response> {
    try {
      const m = request.method;
      if (path === '/projects' && m === 'GET') {
        const meta = await this.store.meta();
        return json(200, { projects: await this.store.list(), tombstones: meta.tombstones, permissions: meta.permissions, active: meta.active });
      }
      const p = /^\/projects\/([A-Za-z0-9_-]{1,64})$/.exec(path);
      if (p) {
        const id = p[1];
        if (m === 'GET') {
          const doc = await this.store.get(id);
          return doc ? json(200, { doc, revision: projectRevision(doc) }) : json(404, { error: 'not found' });
        }
        if (m === 'PUT') {
          const text = await request.text();
          if (text.length > MAX_DOC) return json(413, { error: 'Project too large' });
          const body = JSON.parse(text) as { doc: unknown; base: string | null };
          const loaded = loadProjectDoc(body.doc);
          const doc: ProjectDoc = { ...loaded.doc, id };
          const current = await this.store.header(id);
          if (current && current.revision !== body.base && current.revision !== projectRevision(doc)) return json(409, { conflict: true, revision: current.revision });
          const header = await this.store.put(doc);
          if (!current || current.revision !== header.revision) this.notify({ type: 'project-updated', id, revision: header.revision, label: 'Changes from another device', by: 'editor' });
          return json(200, { revision: header.revision });
        }
        if (m === 'DELETE') {
          await this.store.remove(id);
          this.notify({ type: 'project-deleted', id });
          return json(200, { deleted: id });
        }
      }
      const missing = /^\/blobs\/([A-Za-z0-9_-]{1,64})\/missing$/.exec(path);
      if (missing && m === 'POST') {
        const { hashes } = (await request.json()) as { hashes: string[] };
        const out: string[] = [];
        for (const h of (hashes ?? []).slice(0, 20_000)) if (!(await this.store.hasBlob(missing[1], h))) out.push(h);
        return json(200, { missing: out });
      }
      const blob = /^\/blobs\/([A-Za-z0-9_-]{1,64})\/([0-9a-f]{64})$/.exec(path);
      if (blob) {
        const [, id, hash] = blob;
        if (m === 'GET') {
          const b = await this.store.getBlob(id, hash);
          return b ? new Response(b.data as BodyInit, { headers: { 'content-type': b.mime, 'cache-control': 'private, max-age=31536000, immutable' } }) : json(404, { error: 'not found' });
        }
        if (m === 'PUT') {
          const data = new Uint8Array(await request.arrayBuffer());
          if (data.length > MAX_BLOB) return json(413, { error: 'Asset too large' });
          if ((await sha256Hex(data)) !== hash) return json(400, { error: 'The data does not match its hash' });
          await this.store.putBlob(id, hash, data, request.headers.get('content-type') ?? 'application/octet-stream');
          return json(200, { stored: hash });
        }
      }
      if (path === '/settings' && m === 'PUT') {
        const body = (await request.json()) as { permissions?: Partial<Permissions>; active?: string | null };
        const meta = await this.store.meta();
        await this.store.setMeta({
          ...(body.permissions ? { permissions: { ...meta.permissions, ...body.permissions } } : {}),
          ...(body.active !== undefined ? { active: body.active } : {}),
        });
        return json(200, { ok: true });
      }
      return json(404, { error: 'not found' });
    } catch (e) {
      return json(400, { error: toErrorPayload(e) });
    }
  }
}
