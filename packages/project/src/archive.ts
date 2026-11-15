/**
 * Project archives (.gsproj): a zip that moves a whole project between devices or installations.
 *
 *   manifest.json   { format: "game-studio-archive", version: 1, … }
 *   project.json    the project document
 *   files/<path>    each asset's bytes, at its project path
 *
 * Importing never trusts the archive: sizes are checked before decompressing, the document is
 * migrated and validated, and asset bytes are re-hashed. Scripts inside are just text until the
 * user runs the game (in the sandboxed player) — see docs/SCRIPTING.md for the trust model.
 */
import { strToU8, strFromU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { GameStudioError, newId, sha256Hex } from '@gs/shared';
import { loadProjectDoc } from './migrate';
import { PROJECT_FORMAT_VERSION, type ProjectDoc } from './schema';

export const ARCHIVE_FORMAT = 'game-studio-archive';
export const ARCHIVE_VERSION = 1;
export const ARCHIVE_EXT = '.gsproj';
const MAX_TOTAL = 512 * 1024 * 1024;
const MAX_FILES = 25_000;

export interface ArchiveManifest {
  format: typeof ARCHIVE_FORMAT;
  version: number;
  projectFormatVersion: number;
  name: string;
  exportedAt: number;
}

/** Bytes of one asset by its hash; resolves undefined when missing. */
export type BlobReader = (hash: string) => Promise<Uint8Array | undefined>;

export async function exportArchive(project: ProjectDoc, readBlob: BlobReader): Promise<Uint8Array> {
  const manifest: ArchiveManifest = { format: ARCHIVE_FORMAT, version: ARCHIVE_VERSION, projectFormatVersion: PROJECT_FORMAT_VERSION, name: project.name, exportedAt: Date.now() };
  const files: Zippable = {
    'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
    'project.json': strToU8(JSON.stringify(project, null, 2)),
  };
  const missing: string[] = [];
  for (const a of Object.values(project.assets)) {
    const bytes = await readBlob(a.hash);
    if (!bytes) missing.push(a.path);
    // Already-compressed formats are stored, everything else deflated.
    else files[`files/${a.path}`] = [bytes, { level: /\.(png|jpe?g|webp|gif|mp3|ogg|m4a|aac|flac|glb|woff2?)$/i.test(a.path) ? 0 : 6 }];
  }
  if (missing.length) throw new GameStudioError('E_MISSING_ASSETS', `These assets have no stored data and can't be exported: ${missing.join(', ')}`, { missing });
  return zipSync(files);
}

export interface ImportedArchive {
  doc: ProjectDoc;
  blobs: Map<string, Uint8Array>;
  issues: string[];
}

export async function importArchive(bytes: Uint8Array, opts: { newId?: boolean } = { newId: true }): Promise<ImportedArchive> {
  let total = 0;
  let count = 0;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, {
      filter: (f) => {
        count++;
        total += f.originalSize;
        if (count > MAX_FILES || total > MAX_TOTAL) throw new GameStudioError('E_TOO_LARGE', 'The archive is too large to import');
        return f.name === 'manifest.json' || f.name === 'project.json' || f.name.startsWith('files/');
      },
    });
  } catch (e) {
    if (e instanceof GameStudioError) throw e;
    throw new GameStudioError('E_BAD_ARCHIVE', `Not a valid project archive (${e instanceof Error ? e.message : String(e)})`);
  }
  const read = (name: string) => {
    const b = entries[name];
    if (!b) throw new GameStudioError('E_BAD_ARCHIVE', `The archive has no ${name}`);
    try {
      return JSON.parse(strFromU8(b)) as unknown;
    } catch {
      throw new GameStudioError('E_BAD_ARCHIVE', `${name} is not valid JSON`);
    }
  };
  const manifest = read('manifest.json') as Partial<ArchiveManifest>;
  if (manifest.format !== ARCHIVE_FORMAT) throw new GameStudioError('E_BAD_ARCHIVE', 'This is not a Game Studio project archive');
  if (typeof manifest.version !== 'number' || manifest.version > ARCHIVE_VERSION) throw new GameStudioError('E_NEWER_FORMAT', 'This archive was made by a newer version of Game Studio');
  const loaded = loadProjectDoc(read('project.json'));
  const issues = [...loaded.issues];
  const blobs = new Map<string, Uint8Array>();
  const assets = { ...loaded.doc.assets };
  for (const a of Object.values(loaded.doc.assets)) {
    const data = entries[`files/${a.path}`];
    if (!data) {
      issues.push(`Asset "${a.path}" is missing from the archive`);
      continue;
    }
    const hash = await sha256Hex(data);
    if (hash !== a.hash || data.length !== a.size) {
      issues.push(`Asset "${a.path}" did not match its recorded checksum; its metadata was updated`);
      assets[a.path] = { ...a, hash, size: data.length };
    }
    blobs.set(hash, data);
  }
  const doc: ProjectDoc = { ...loaded.doc, assets, ...(opts.newId === false ? {} : { id: newId('p') }) };
  return { doc, blobs, issues };
}
