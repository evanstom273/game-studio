/**
 * Keeps this browser's projects and the cloud copy (in the user's own Cloudflare Durable Object)
 * in step while the AI connection is on, so AI assistants can work with Game Studio closed.
 *
 *  - On connect: both sides are compared. A project changed on one side only is copied to the
 *    other; changed on both, the newer one wins and the other is kept as a local backup.
 *  - After every local save the project is pushed (and any new asset bytes uploaded).
 *  - When the AI (or another device) changes a project, the cloud tells open editors; the change is
 *    pulled and, if that project is open, applied as an undoable step.
 */
import { errorMessage } from '@gs/shared';
import { projectRevision, type ProjectDoc } from '@gs/project';
import type { CloudNoticeMessage } from '@gs/mcp';
import { addBackup, deleteProject, getBlob, getProjectBlobs, listProjects, loadProject, putBlob, saveProject } from '@editor/db/projects';
import { useEditor } from '@editor/store/editor';
import { toast } from '@editor/store/toasts';
import { logEditor } from '@editor/store/console';
import { loadProjectAssets } from '@editor/services/assets';
import type { BridgePermissions } from './client';

interface CloudHeader {
  id: string;
  name: string;
  updatedAt: number;
  revision: string;
}

const REVS_KEY = 'game-studio:sync-revisions';

/** The revision each project had when it was last in step with the cloud. */
function knownRevs(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(REVS_KEY) ?? '{}');
  } catch {
    return {};
  }
}
function setKnown(id: string, rev: string | null) {
  const r = knownRevs();
  if (rev) r[id] = rev;
  else delete r[id];
  try {
    localStorage.setItem(REVS_KEY, JSON.stringify(r));
  } catch {
    /* storage unavailable */
  }
}

export class CloudSync {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly key: string) {}

  private url(path: string) {
    return `/sync/${this.key}${path}`;
  }

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(this.url(path), init);
    if (res.status === 409) throw Object.assign(new Error('conflict'), { conflict: true });
    if (!res.ok) throw new Error(`Sync failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    return res.json() as Promise<T>;
  }

  /** Serialise sync operations so they never overlap. */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  pushSettings(permissions: BridgePermissions, active?: string | null) {
    void fetch(this.url('/settings'), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ permissions, ...(active !== undefined ? { active } : {}) }) }).catch(() => {});
  }

  setActive(active: string | null) {
    void fetch(this.url('/settings'), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ active }) }).catch(() => {});
  }

  /** Two-way sync of every project. */
  syncAll() {
    return this.run(async () => {
      const cloud = await this.req<{ projects: CloudHeader[]; tombstones: Record<string, number> }>('/projects');
      const byId = new Map(cloud.projects.map((p) => [p.id, p]));
      const known = knownRevs();
      let pulled = 0;
      let pushed = 0;
      for (const item of await listProjects()) {
        const c = byId.get(item.id);
        byId.delete(item.id);
        const { doc } = await loadProject(item.id);
        const localRev = projectRevision(doc);
        if (!c) {
          const deletedAt = cloud.tombstones[item.id];
          if (deletedAt && deletedAt > item.updatedAt && known[item.id]) {
            await deleteProject(item.id);
            setKnown(item.id, null);
            continue;
          }
          await this.pushDoc(doc, null);
          pushed++;
          continue;
        }
        if (c.revision === localRev) {
          setKnown(item.id, localRev);
          continue;
        }
        const localChanged = localRev !== known[item.id];
        const cloudChanged = c.revision !== known[item.id];
        if (localChanged && !cloudChanged) {
          await this.pushDoc(doc, c.revision);
          pushed++;
        } else if (cloudChanged && !localChanged) {
          await this.pullDoc(item.id, 'Synced from the cloud');
          pulled++;
        } else if (c.updatedAt > doc.updatedAt) {
          await addBackup(doc.id, 'Before syncing (changed on both sides)', doc);
          await this.pullDoc(item.id, 'Synced from the cloud');
          pulled++;
        } else {
          await this.pushDoc(doc, c.revision, true);
          pushed++;
        }
      }
      for (const c of byId.values()) {
        await this.pullDoc(c.id, 'Synced from the cloud');
        pulled++;
      }
      if (pulled || pushed) window.dispatchEvent(new Event('gs:projects-changed'));
      return { pulled, pushed };
    });
  }

  /** Uploads a project (and its missing asset bytes). `force` overwrites the cloud copy. */
  private async pushDoc(doc: ProjectDoc, base: string | null, force = false): Promise<void> {
    try {
      const baseRev = force ? (await this.req<{ revision: string }>(`/projects/${doc.id}`)).revision : base;
      const r = await this.req<{ revision: string }>(`/projects/${doc.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc, base: baseRev }) });
      setKnown(doc.id, r.revision);
    } catch (e) {
      if ((e as { conflict?: boolean }).conflict) {
        // The AI changed it at the same time: keep the cloud version, back ours up.
        await addBackup(doc.id, 'Your version (the AI changed the project at the same time)', doc);
        await this.pullDoc(doc.id, 'AI changes (your concurrent edit is in Backups)');
        toast('warning', 'The AI changed this project while you were editing. Its version was kept; yours is in Menu → Backups.');
        return;
      }
      throw e;
    }
    const hashes = [...new Set(Object.values(doc.assets).map((a) => a.hash))];
    if (!hashes.length) return;
    const { missing } = await this.req<{ missing: string[] }>(`/blobs/${doc.id}/missing`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hashes }) });
    for (const hash of missing) {
      const data = await getBlob(doc.id, hash);
      const mime = Object.values(doc.assets).find((a) => a.hash === hash)?.mime ?? 'application/octet-stream';
      if (data) await fetch(this.url(`/blobs/${doc.id}/${hash}`), { method: 'PUT', headers: { 'content-type': mime }, body: data as BodyInit });
    }
  }

  /** Downloads a project (and missing asset bytes); applies it to the editor if it is open. */
  private async pullDoc(id: string, label: string) {
    const { doc, revision } = await this.req<{ doc: ProjectDoc; revision: string }>(`/projects/${id}`);
    const have = new Set((await getProjectBlobs(id)).map((b) => b.hash));
    for (const a of Object.values(doc.assets)) {
      if (have.has(a.hash)) continue;
      const res = await fetch(this.url(`/blobs/${id}/${a.hash}`));
      if (res.ok) {
        await putBlob(id, a.hash, new Uint8Array(await res.arrayBuffer()), a.mime);
        have.add(a.hash);
      }
    }
    await saveProject(doc);
    setKnown(id, revision);
    const editor = useEditor.getState();
    if (editor.project?.id === id && projectRevision(editor.project) !== revision) {
      await loadProjectAssets(doc);
      editor.replace(doc, label, 'mcp');
      editor.markSaved(doc);
    }
  }

  /** After a local save. */
  pushAfterSave(doc: ProjectDoc) {
    return this.run(async () => {
      const known = knownRevs()[doc.id] ?? null;
      if (known === projectRevision(doc)) return;
      await this.pushDoc(doc, known);
    }).catch((e) => logEditor('warn', `Couldn't sync "${doc.name}" to the cloud: ${errorMessage(e)}`));
  }

  /** The cloud says a project changed or was deleted. */
  onNotice(n: CloudNoticeMessage) {
    void this.run(async () => {
      if (n.type === 'project-deleted') {
        if (useEditor.getState().project?.id === n.id) return; // never pull the rug out from under the open editor
        await deleteProject(n.id).catch(() => {});
        setKnown(n.id, null);
      } else {
        if (knownRevs()[n.id] === n.revision) return; // our own push coming back
        const open = useEditor.getState().project;
        await this.pullDoc(n.id, n.label);
        if (open?.id === n.id) logEditor('info', `${n.label}`);
      }
      window.dispatchEvent(new Event('gs:projects-changed'));
    }).catch((e) => logEditor('warn', `Couldn't fetch changes from the cloud: ${errorMessage(e)}`));
  }

  /** Make sure `id` is at least at `revision` locally (before running a game the AI asked for). */
  ensure(id: string, revision: string) {
    return this.run(async () => {
      const open = useEditor.getState().project;
      const local = open?.id === id ? open : await loadProject(id).then((l) => l.doc).catch(() => null);
      if (!local || projectRevision(local) !== revision) await this.pullDoc(id, 'AI changes');
    });
  }

  /** The user deleted a project in this browser: delete the cloud copy too. */
  deleteRemote(id: string) {
    setKnown(id, null);
    return fetch(this.url(`/projects/${id}`), { method: 'DELETE' }).catch(() => {});
  }
}
