/**
 * Asset bytes for the open project: object URLs for renderers (loaded when the project opens),
 * importing files, and generating simple textures.
 */
import { GameStudioError, normalizePath, sha256Hex, stem, extname, dirname } from '@gs/shared';
import { assetKindForPath } from '@gs/core';
import { readImageSize, type ProjectDoc } from '@gs/project';
import { getProjectBlobs, putBlob } from '@editor/db/projects';
import { useEditor } from '@editor/store/editor';

const urls = new Map<string, string>(); // hash → object URL
const blobs = new Map<string, Blob>(); // hash → Blob
let loadedFor: string | null = null;

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export const IMPORT_ACCEPT = Object.keys(MIME).join(',');
export const MAX_ASSET_BYTES = 50 * 1024 * 1024;

function remember(hash: string, data: Uint8Array, mime: string) {
  if (urls.has(hash)) return;
  const blob = new Blob([data as BlobPart], { type: mime });
  blobs.set(hash, blob);
  urls.set(hash, URL.createObjectURL(blob));
}

/** Loads every asset of the project into memory (call before showing viewports). */
export async function loadProjectAssets(doc: ProjectDoc) {
  if (loadedFor !== doc.id) releaseAssets();
  loadedFor = doc.id;
  for (const row of await getProjectBlobs(doc.id)) remember(row.hash, row.data, row.mime);
}

export function releaseAssets() {
  for (const u of urls.values()) URL.revokeObjectURL(u);
  urls.clear();
  blobs.clear();
  loadedFor = null;
}

/** Object URL of an asset of the open project (null if unknown). */
export function assetUrl(path: string): string | null {
  const a = useEditor.getState().project?.assets[path];
  return a ? (urls.get(a.hash) ?? null) : null;
}

export function assetBlob(path: string): Blob | null {
  const a = useEditor.getState().project?.assets[path];
  return a ? (blobs.get(a.hash) ?? null) : null;
}

export function assetBlobByHash(hash: string) {
  return blobs.get(hash) ?? null;
}

/** A free path near `want` ("art/coin.png" → "art/coin2.png" if taken). */
export function freePath(doc: ProjectDoc, want: string) {
  const taken = (p: string) => p in doc.assets || p in doc.scenes || p in doc.scripts;
  if (!taken(want)) return want;
  const dir = dirname(want);
  const base = stem(want).replace(/\d+$/, '');
  const ext = extname(want);
  for (let i = 2; ; i++) {
    const p = `${dir ? dir + '/' : ''}${base}${i}${ext}`;
    if (!taken(p)) return p;
  }
}

async function imageSize(data: Uint8Array, mime: string) {
  const fromHeader = readImageSize(data);
  if (fromHeader) return fromHeader;
  try {
    const bmp = await createImageBitmap(new Blob([data as BlobPart], { type: mime }));
    const s = { width: bmp.width, height: bmp.height };
    bmp.close();
    return s;
  } catch {
    return null;
  }
}

export interface ImportedAsset {
  path: string;
  kind: string;
  size: number;
  /** True when an identical file was already there (nothing added). */
  existing?: boolean;
}

/**
 * Stores bytes as an asset of the open project and adds it with the command layer.
 * `replace` overwrites an existing asset at the same path.
 */
export async function importAssetBytes(path: string, data: Uint8Array, opts: { replace?: boolean; source?: 'user' | 'mcp' } = {}): Promise<ImportedAsset> {
  const state = useEditor.getState();
  const doc = state.project;
  if (!doc) throw new GameStudioError('E_NO_PROJECT', 'No project is open');
  let target = normalizePath(path);
  const kind = assetKindForPath(target);
  if (kind === 'other') throw new GameStudioError('E_UNSUPPORTED', `"${extname(target) || target}" files are not supported. Supported: ${Object.keys(MIME).join(' ')}`);
  if (data.length > MAX_ASSET_BYTES) throw new GameStudioError('E_TOO_LARGE', `"${target}" is larger than ${MAX_ASSET_BYTES / 1024 / 1024} MB`);
  const mime = MIME[extname(target)] ?? 'application/octet-stream';
  const hash = await sha256Hex(data);
  const existing = doc.assets[target];
  if (existing?.hash === hash) return { path: target, kind, size: data.length, existing: true };
  if (existing && !opts.replace) target = freePath(doc, target);
  const size = kind === 'image' ? await imageSize(data, mime) : null;
  await putBlob(doc.id, hash, data, mime);
  remember(hash, data, mime);
  state.dispatch([{ op: 'add_asset', path: target, info: { kind, mime, size: data.length, hash, ...(size ? { width: size.width, height: size.height } : {}) }, replace: !!opts.replace && !!existing }], { label: `Import ${target}`, source: opts.source ?? 'user' });
  return { path: target, kind, size: data.length };
}

export async function importFiles(files: File[], folder = 'assets'): Promise<{ imported: ImportedAsset[]; errors: string[] }> {
  const imported: ImportedAsset[] = [];
  const errors: string[] = [];
  for (const f of files) {
    try {
      const name = f.name.replace(/[^\w.\- ]+/g, '_');
      imported.push(await importAssetBytes(`${folder ? folder + '/' : ''}${name}`, new Uint8Array(await f.arrayBuffer())));
    } catch (e) {
      errors.push(`${f.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { imported, errors };
}

export { generateTexture } from '@gs/project';
