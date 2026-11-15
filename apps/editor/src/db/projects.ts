/** Project storage: create, list, load, save, duplicate, delete, archives, blobs and backups. */
import { GameStudioError, newId } from '@gs/shared';
import { createProject, exportArchive, importArchive, loadProjectDoc, type LoadedProject, type ProjectDoc, type TemplateId } from '@gs/project';
import { db, requestPersistentStorage, type ProjectRow } from './db';

export interface ProjectListItem {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  scenes: number;
  scripts: number;
  assets: number;
  mainScene: string | null;
  /** The main scene's root type, for the 2D/3D badge. */
  kind: '2D' | '3D' | 'Mixed' | 'Empty';
}

const MAX_BACKUPS = 20;

function summarize(row: ProjectRow): ProjectListItem {
  const doc = row.doc as Partial<ProjectDoc>;
  const scenes = doc.scenes ?? {};
  const types = Object.values(scenes).map((s) => s.root.type);
  const has2D = types.some((t) => /2D$/.test(t));
  const has3D = types.some((t) => /3D$/.test(t));
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    scenes: Object.keys(scenes).length,
    scripts: Object.keys(doc.scripts ?? {}).length,
    assets: Object.keys(doc.assets ?? {}).length,
    mainScene: doc.settings?.mainScene ?? null,
    kind: has2D && has3D ? 'Mixed' : has3D ? '3D' : has2D ? '2D' : 'Empty',
  };
}

export async function listProjects(): Promise<ProjectListItem[]> {
  const rows = await db.projects.orderBy('updatedAt').reverse().toArray();
  return rows.map(summarize);
}

export async function loadProject(id: string): Promise<LoadedProject> {
  const row = await db.projects.get(id);
  if (!row) throw new GameStudioError('E_NOT_FOUND', 'This project does not exist in this browser.');
  const loaded = loadProjectDoc(row.doc);
  // Rows and documents must agree on the id (archives get new ids on import).
  if (loaded.doc.id !== id) loaded.doc = { ...loaded.doc, id };
  if (loaded.migratedFrom !== undefined) await addBackup(id, `Before upgrading from format ${loaded.migratedFrom}`, row.doc);
  return loaded;
}

export async function saveProject(doc: ProjectDoc) {
  await db.projects.put({ id: doc.id, name: doc.name, createdAt: doc.createdAt, updatedAt: doc.updatedAt, doc });
}

async function storeNew(doc: ProjectDoc, blobs: Map<string, Uint8Array>) {
  await db.transaction('rw', db.projects, db.blobs, async () => {
    for (const [hash, data] of blobs) {
      const info = Object.values(doc.assets).find((a) => a.hash === hash);
      await db.blobs.put({ projectId: doc.id, hash, data, size: data.length, mime: info?.mime ?? 'application/octet-stream' });
    }
    await saveProject(doc);
  });
  void requestPersistentStorage();
  return doc;
}

export async function createNewProject(name: string, template: TemplateId) {
  const { doc, blobs } = await createProject(name, template);
  return storeNew(doc, blobs);
}

export async function importProjectArchive(bytes: Uint8Array) {
  const { doc, blobs, issues } = await importArchive(bytes);
  const now = Date.now();
  await storeNew({ ...doc, updatedAt: now }, blobs);
  return { doc, issues };
}

/** Stores a project made elsewhere (opened from GitHub) as a new project in this browser. */
export async function addProject(doc: ProjectDoc, blobs: Map<string, Uint8Array>) {
  return storeNew({ ...doc, updatedAt: Date.now() }, blobs);
}

export async function exportProjectArchive(doc: ProjectDoc) {
  return exportArchive(doc, (hash) => getBlob(doc.id, hash));
}

export async function duplicateProject(id: string, name?: string) {
  const { doc } = await loadProject(id);
  const now = Date.now();
  const copy: ProjectDoc = { ...doc, id: newId('p'), name: name ?? `${doc.name} copy`, createdAt: now, updatedAt: now };
  await db.transaction('rw', db.projects, db.blobs, async () => {
    const blobs = await db.blobs.where('projectId').equals(id).toArray();
    await db.blobs.bulkPut(blobs.map((b) => ({ ...b, projectId: copy.id })));
    await saveProject(copy);
  });
  return copy;
}

export async function renameStoredProject(id: string, name: string) {
  const { doc } = await loadProject(id);
  await saveProject({ ...doc, name: name.trim() || doc.name, updatedAt: Date.now() });
}

export async function deleteProject(id: string) {
  await db.transaction('rw', db.projects, db.blobs, db.backups, async () => {
    await db.projects.delete(id);
    await db.blobs.where('projectId').equals(id).delete();
    await db.backups.where('projectId').equals(id).delete();
  });
}

// --- blobs ----------------------------------------------------------------------------------------------

export async function putBlob(projectId: string, hash: string, data: Uint8Array, mime: string) {
  await db.blobs.put({ projectId, hash, data, size: data.length, mime });
}

export async function getBlob(projectId: string, hash: string): Promise<Uint8Array | undefined> {
  return (await db.blobs.get([projectId, hash]))?.data;
}

export async function getProjectBlobs(projectId: string) {
  return db.blobs.where('projectId').equals(projectId).toArray();
}

/** Removes stored bytes no asset refers to any more (and no backup could need). */
export async function collectGarbage(doc: ProjectDoc) {
  const live = new Set(Object.values(doc.assets).map((a) => a.hash));
  const backups = await db.backups.where('projectId').equals(doc.id).toArray();
  for (const b of backups) for (const a of Object.values((b.doc as ProjectDoc).assets ?? {})) live.add(a.hash);
  const rows = await db.blobs.where('projectId').equals(doc.id).primaryKeys();
  const dead = rows.filter(([, hash]) => !live.has(hash));
  if (dead.length) await db.blobs.bulkDelete(dead);
  return dead.length;
}

// --- backups --------------------------------------------------------------------------------------------

export async function addBackup(projectId: string, label: string, doc: unknown) {
  await db.backups.add({ projectId, at: Date.now(), label, doc });
  const all = await db.backups.where('projectId').equals(projectId).sortBy('at');
  if (all.length > MAX_BACKUPS) await db.backups.bulkDelete(all.slice(0, all.length - MAX_BACKUPS).map((b) => b.id!));
}

export async function listBackups(projectId: string) {
  const rows = await db.backups.where('projectId').equals(projectId).reverse().sortBy('at');
  return rows.map((r) => ({ id: r.id!, at: r.at, label: r.label }));
}

export async function readBackup(id: number) {
  const row = await db.backups.get(id);
  if (!row) throw new GameStudioError('E_NOT_FOUND', 'That backup no longer exists');
  return loadProjectDoc(row.doc).doc;
}
