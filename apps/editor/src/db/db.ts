/**
 * Browser storage (IndexedDB via Dexie).
 *
 * Schema history — never edit an old version, add a new one:
 *   v1  projects (one document per project), blobs (asset bytes by project + SHA-256),
 *       backups (snapshots before risky changes), settings (key/value)
 *
 * Each save is a single IndexedDB transaction, so an interrupted save (tab closed, crash, power
 * loss) leaves the previous version intact rather than a half-written project.
 */
import Dexie, { type Table } from 'dexie';

export interface ProjectRow {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** The project document as stored; always read through loadProjectDoc (migrations + validation). */
  doc: unknown;
}

export interface BlobRow {
  projectId: string;
  hash: string;
  mime: string;
  size: number;
  data: Uint8Array;
}

export interface BackupRow {
  id?: number;
  projectId: string;
  at: number;
  label: string;
  doc: unknown;
}

export interface SettingRow {
  key: string;
  value: unknown;
}

export class GameStudioDB extends Dexie {
  projects!: Table<ProjectRow, string>;
  blobs!: Table<BlobRow, [string, string]>;
  backups!: Table<BackupRow, number>;
  settings!: Table<SettingRow, string>;

  constructor(name = 'game-studio') {
    super(name);
    this.version(1).stores({
      projects: 'id, updatedAt, name',
      blobs: '[projectId+hash], projectId',
      backups: '++id, projectId, at',
      settings: 'key',
    });
  }
}

export const db = new GameStudioDB();

/** Ask the browser not to evict our data under storage pressure (best effort). */
export async function requestPersistentStorage() {
  try {
    if (navigator.storage?.persisted && !(await navigator.storage.persisted())) await navigator.storage.persist?.();
  } catch {
    /* not supported */
  }
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const e = await navigator.storage?.estimate?.();
    return e && e.quota ? { usage: e.usage ?? 0, quota: e.quota } : null;
  } catch {
    return null;
  }
}

/** Turns IndexedDB failures into messages people can act on. */
export function storageErrorMessage(e: unknown): string {
  const name = (e as { name?: string })?.name ?? '';
  const inner = (e as { inner?: { name?: string } })?.inner?.name ?? '';
  if (name === 'QuotaExceededError' || inner === 'QuotaExceededError') return 'Browser storage is full. Export projects you are not using (Projects → ⋯ → Export) and delete them, or free space in your browser settings.';
  if (name === 'InvalidStateError' || name === 'DatabaseClosedError') return 'Browser storage is unavailable (private browsing, or storage was cleared). Your changes cannot be saved in this window.';
  return `Could not save to browser storage: ${e instanceof Error ? e.message : String(e)}`;
}
