/**
 * The cloud copy of a user's projects, kept in their own Durable Object (or in memory on the dev
 * server). AI assistants edit this copy directly, so no editor has to be open; editors sync with it.
 *
 * Storage is a small key/value interface (Durable Object storage in production). Values over the
 * storage's per-value limit are split into chunks.
 *
 *   meta                   { active, tombstones, permissions }
 *   p:<id>                 { id, name, updatedAt, revision, chunks }      project header
 *   pc:<id>:<n>            JSON text chunk of the project document
 *   b:<pid>:<hash>         { mime, size, chunks }                           asset header
 *   bc:<pid>:<hash>:<n>    bytes chunk
 *   h:<id>                 { undo: Entry[], redo: Entry[] }                AI undo history
 *   hs:<id>:<seq>:<n>      JSON chunk of a history snapshot
 */
import { projectRevision, type ProjectDoc } from '@gs/project';

export interface KvStore {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  /** Keys with a prefix (values not needed). */
  keys(prefix: string): Promise<string[]>;
}

export interface Permissions {
  scope: 'open-project' | 'all-projects';
  level: 'read' | 'edit' | 'full';
  confirmDestructive: boolean;
}

export interface Meta {
  /** The project the user (or the AI) last opened: tools default to it. */
  active: string | null;
  /** Deleted project ids → time, so other devices delete their copies too. */
  tombstones: Record<string, number>;
  /** Set by the editor (the user's choices in the AI-connection dialog). */
  permissions: Permissions;
}

export interface ProjectHeader {
  id: string;
  name: string;
  updatedAt: number;
  revision: string;
  chunks: number;
}

interface HistoryEntry {
  label: string;
  /** Revision after the AI's change; undo only applies while the project is still at it. */
  after: string;
  seq: number;
  chunks: number;
}

const TEXT_CHUNK = 400_000; // characters (well under the 2 MB value limit even for 4-byte UTF-8)
const BYTE_CHUNK = 1_000_000;
const HISTORY_LIMIT = 20;

export const DEFAULT_PERMISSIONS: Permissions = { scope: 'all-projects', level: 'edit', confirmDestructive: true };

export class MemoryKv implements KvStore {
  private map = new Map<string, unknown>();
  async get<T>(key: string) {
    return this.map.get(key) as T | undefined;
  }
  async put(key: string, value: unknown) {
    this.map.set(key, value);
  }
  async delete(key: string) {
    this.map.delete(key);
  }
  async keys(prefix: string) {
    return [...this.map.keys()].filter((k) => k.startsWith(prefix));
  }
}

async function putText(kv: KvStore, prefix: string, text: string): Promise<number> {
  const n = Math.max(1, Math.ceil(text.length / TEXT_CHUNK));
  for (let i = 0; i < n; i++) await kv.put(`${prefix}:${i}`, text.slice(i * TEXT_CHUNK, (i + 1) * TEXT_CHUNK));
  // Remove chunks left over from a longer previous value.
  for (const k of await kv.keys(`${prefix}:`)) if (Number(k.slice(prefix.length + 1)) >= n) await kv.delete(k);
  return n;
}

async function getText(kv: KvStore, prefix: string, chunks: number): Promise<string | null> {
  const parts: string[] = [];
  for (let i = 0; i < chunks; i++) {
    const part = await kv.get<string>(`${prefix}:${i}`);
    if (part === undefined) return null;
    parts.push(part);
  }
  return parts.join('');
}

export class CloudStore {
  constructor(readonly kv: KvStore) {}

  // --- meta --------------------------------------------------------------------------------------------
  async meta(): Promise<Meta> {
    const m = await this.kv.get<Partial<Meta>>('meta');
    return { active: m?.active ?? null, tombstones: m?.tombstones ?? {}, permissions: { ...DEFAULT_PERMISSIONS, ...m?.permissions } };
  }
  async setMeta(patch: Partial<Meta>) {
    await this.kv.put('meta', { ...(await this.meta()), ...patch });
  }

  // --- projects ------------------------------------------------------------------------------------------
  async list(): Promise<ProjectHeader[]> {
    const out: ProjectHeader[] = [];
    for (const k of await this.kv.keys('p:')) {
      const h = await this.kv.get<ProjectHeader>(k);
      if (h) out.push(h);
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async header(id: string) {
    return (await this.kv.get<ProjectHeader>(`p:${id}`)) ?? null;
  }

  async get(id: string): Promise<ProjectDoc | null> {
    const h = await this.header(id);
    if (!h) return null;
    const text = await getText(this.kv, `pc:${id}`, h.chunks);
    return text ? (JSON.parse(text) as ProjectDoc) : null;
  }

  async put(doc: ProjectDoc): Promise<ProjectHeader> {
    const chunks = await putText(this.kv, `pc:${doc.id}`, JSON.stringify(doc));
    const header: ProjectHeader = { id: doc.id, name: doc.name, updatedAt: doc.updatedAt, revision: projectRevision(doc), chunks };
    await this.kv.put(`p:${doc.id}`, header);
    const meta = await this.meta();
    if (meta.tombstones[doc.id]) {
      delete meta.tombstones[doc.id];
      await this.setMeta({ tombstones: meta.tombstones });
    }
    return header;
  }

  async remove(id: string) {
    for (const prefix of [`pc:${id}:`, `b:${id}:`, `bc:${id}:`, `hs:${id}:`]) for (const k of await this.kv.keys(prefix)) await this.kv.delete(k);
    await this.kv.delete(`p:${id}`);
    await this.kv.delete(`h:${id}`);
    const meta = await this.meta();
    meta.tombstones[id] = Date.now();
    await this.setMeta({ tombstones: meta.tombstones, active: meta.active === id ? null : meta.active });
  }

  // --- asset bytes ----------------------------------------------------------------------------------------
  async hasBlob(projectId: string, hash: string) {
    return (await this.kv.get(`b:${projectId}:${hash}`)) !== undefined;
  }

  async putBlob(projectId: string, hash: string, data: Uint8Array, mime: string) {
    const n = Math.max(1, Math.ceil(data.length / BYTE_CHUNK));
    for (let i = 0; i < n; i++) await this.kv.put(`bc:${projectId}:${hash}:${i}`, data.slice(i * BYTE_CHUNK, (i + 1) * BYTE_CHUNK));
    await this.kv.put(`b:${projectId}:${hash}`, { mime, size: data.length, chunks: n });
  }

  async getBlob(projectId: string, hash: string): Promise<{ data: Uint8Array; mime: string } | null> {
    const h = await this.kv.get<{ mime: string; size: number; chunks: number }>(`b:${projectId}:${hash}`);
    if (!h) return null;
    const out = new Uint8Array(h.size);
    let o = 0;
    for (let i = 0; i < h.chunks; i++) {
      const part = await this.kv.get<Uint8Array>(`bc:${projectId}:${hash}:${i}`);
      if (!part) return null;
      out.set(part, o);
      o += part.length;
    }
    return { data: out, mime: h.mime };
  }

  // --- AI undo history -------------------------------------------------------------------------------------
  private async history(id: string) {
    return (await this.kv.get<{ undo: HistoryEntry[]; redo: HistoryEntry[]; seq: number }>(`h:${id}`)) ?? { undo: [], redo: [], seq: 0 };
  }

  private async snapshot(id: string, seq: number, doc: ProjectDoc) {
    return putText(this.kv, `hs:${id}:${seq}`, JSON.stringify(doc));
  }

  private async readSnapshot(id: string, e: HistoryEntry) {
    const text = await getText(this.kv, `hs:${id}:${e.seq}`, e.chunks);
    return text ? (JSON.parse(text) as ProjectDoc) : null;
  }

  private async dropSnapshot(id: string, e: HistoryEntry) {
    for (const k of await this.kv.keys(`hs:${id}:${e.seq}:`)) await this.kv.delete(k);
  }

  /** Records that `before` became `after` (an AI edit), for undo. */
  async record(before: ProjectDoc, after: ProjectDoc, label: string) {
    const h = await this.history(before.id);
    const seq = ++h.seq;
    const chunks = await this.snapshot(before.id, seq, before);
    for (const e of h.redo) await this.dropSnapshot(before.id, e);
    h.redo = [];
    h.undo.push({ label, after: projectRevision(after), seq, chunks });
    while (h.undo.length > HISTORY_LIMIT) await this.dropSnapshot(before.id, h.undo.shift()!);
    await this.kv.put(`h:${before.id}`, h);
  }

  /** Undo/redo the last AI change, but only if nobody changed the project since. */
  async step(id: string, current: ProjectDoc, direction: 'undo' | 'redo'): Promise<{ doc: ProjectDoc; label: string } | { error: string }> {
    const h = await this.history(id);
    const from = direction === 'undo' ? h.undo : h.redo;
    const entry = from[from.length - 1];
    if (!entry) return { error: `Nothing to ${direction}` };
    if (entry.after !== projectRevision(current)) return { error: `The project changed since that edit (probably in the editor), so it can't be ${direction === 'undo' ? 'undone' : 'redone'} here. Use the editor's undo instead.` };
    const target = await this.readSnapshot(id, entry);
    if (!target) return { error: 'That history entry is no longer available' };
    from.pop();
    await this.dropSnapshot(id, entry);
    const seq = ++h.seq;
    const chunks = await this.snapshot(id, seq, current);
    (direction === 'undo' ? h.redo : h.undo).push({ label: entry.label, after: projectRevision(target), seq, chunks });
    await this.kv.put(`h:${id}`, h);
    return { doc: target, label: entry.label };
  }
}
