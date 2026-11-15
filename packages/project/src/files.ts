/**
 * A project as a folder of files, the way it is stored in a Git repository:
 *
 *   gamestudio.json        { format, version, projectFormatVersion, name, settings }
 *   <path>.scene           each scene, pretty-printed JSON with a fixed key order
 *   <path>.ts / .js        each script, as written
 *   <path>.png / .ogg / …  each asset, its bytes (metadata is recomputed from them)
 *
 * Anything else in the repository (README.md, LICENSE, .github/…) is not part of the project and
 * is left alone. The text form is canonical — the same document always gives the same bytes — so
 * comparing git blob hashes tells what changed, and line-by-line merges of scenes stay readable.
 *
 * Everything coming from files is validated: scenes and settings with the project schema, the
 * assembled document with `loadProjectDoc` (which also migrates older formats).
 */
import { GameStudioError, extname, isPlainObject, normalizePath, sha256Hex } from '@gs/shared';
import { assetKindForPath, walkDoc, type AssetInfo, type NodeDoc, type SceneDoc } from '@gs/core';
import { DEFAULT_SETTINGS, LIMITS, PROJECT_FORMAT, PROJECT_FORMAT_VERSION, SceneDocSchema, SettingsSchema, type ProjectDoc, type ProjectSettings } from './schema';
import { loadProjectDoc } from './migrate';
import { readImageSize } from './png';
import type { Command } from './commands';

export const REPO_MANIFEST = 'gamestudio.json';
export const REPO_FORMAT = 'game-studio-repo';
export const REPO_FORMAT_VERSION = 1;

export type RepoFileRole = 'manifest' | 'scene' | 'script' | 'asset' | 'other';

const SCRIPT_EXT = new Set(['.ts', '.js']);

/** What a repository path is to a project. Dot-folders (.github, .vscode) and other files are not part of it. */
export function repoFileRole(path: string): RepoFileRole {
  if (path === REPO_MANIFEST) return 'manifest';
  let clean: string;
  try {
    clean = normalizePath(path);
  } catch {
    return 'other';
  }
  if (clean !== path) return 'other';
  const segments = path.split('/');
  if (segments.some((s) => s.startsWith('.')) || segments[0] === 'node_modules') return 'other';
  const ext = extname(path);
  if (ext === '.scene') return 'scene';
  if (SCRIPT_EXT.has(ext)) return 'script';
  if (assetKindForPath(path) !== 'other') return 'asset';
  return 'other';
}

export const isProjectFile = (path: string) => repoFileRole(path) !== 'other';

// --- canonical text ------------------------------------------------------------------------------------------------

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (!isPlainObject(v)) return v;
  return Object.fromEntries(
    Object.keys(v)
      .sort()
      .map((k) => [k, sortDeep(v[k])]),
  );
}

const NODE_KEYS = ['id', 'name', 'type', 'instance', 'script', 'scriptProps', 'props', 'groups', 'children'] as const;

function canonicalNode(n: NodeDoc): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const raw = n as unknown as Record<string, unknown>;
  for (const k of NODE_KEYS) {
    if (raw[k] === undefined) continue;
    if (k === 'children') out.children = (n.children ?? []).map(canonicalNode);
    else if (k === 'props' || k === 'scriptProps') out[k] = sortDeep(raw[k]);
    else out[k] = raw[k];
  }
  for (const k of Object.keys(raw).sort()) if (!(NODE_KEYS as readonly string[]).includes(k) && raw[k] !== undefined) out[k] = sortDeep(raw[k]);
  return out;
}

/** A scene as stored in a repository: the same scene always gives the same text. */
export function serializeScene(scene: SceneDoc): string {
  const out: Record<string, unknown> = { root: canonicalNode(scene.root) };
  if (scene.connections?.length) out.connections = scene.connections.map((c) => ({ from: c.from, signal: c.signal, to: c.to, method: c.method }));
  return `${JSON.stringify(out, null, 2)}\n`;
}

export interface RepoManifest {
  format: typeof REPO_FORMAT;
  version: number;
  projectFormatVersion: number;
  name: string;
  settings: ProjectSettings;
  /** Sizes of images whose files don't say (SVG), so sprites keep their size. */
  imageSizes?: Record<string, [number, number]>;
}

export function serializeManifest(doc: ProjectDoc): string {
  const imageSizes: Record<string, [number, number]> = {};
  for (const a of Object.values(doc.assets)) if (a.kind === 'image' && extname(a.path) === '.svg' && a.width && a.height) imageSizes[a.path] = [a.width, a.height];
  const m: RepoManifest = {
    format: REPO_FORMAT,
    version: REPO_FORMAT_VERSION,
    projectFormatVersion: PROJECT_FORMAT_VERSION,
    name: doc.name,
    settings: sortDeep(doc.settings) as ProjectSettings,
    ...(Object.keys(imageSizes).length ? { imageSizes: sortDeep(imageSizes) as Record<string, [number, number]> } : {}),
  };
  return `${JSON.stringify(m, null, 2)}\n`;
}

/** The project's text files (manifest, scenes, scripts) by path. Assets are listed by `projectAssets`. */
export function projectTextFiles(doc: ProjectDoc): Map<string, string> {
  const out = new Map<string, string>([[REPO_MANIFEST, serializeManifest(doc)]]);
  for (const [p, s] of Object.entries(doc.scenes)) out.set(p, serializeScene(s));
  for (const [p, src] of Object.entries(doc.scripts)) out.set(p, src);
  return out;
}

// --- reading files ----------------------------------------------------------------------------------------------------

const fileError = (path: string, why: string): never => {
  throw new GameStudioError('E_BAD_FILE', `${path}: ${why}`, { path });
};

function parseJson(path: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    return fileError(path, `not valid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
}

/** Parses and checks one .scene file (shape, unique node ids, size limits). Throws E_BAD_FILE. */
export function parseSceneFile(path: string, text: string): SceneDoc {
  const parsed = SceneDocSchema.safeParse(parseJson(path, text));
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    fileError(path, `${i.path.join('.') || '(root)'}: ${i.message}`);
  }
  const scene = parsed.data as SceneDoc;
  const ids = new Set<string>();
  let count = 0;
  walkDoc(scene.root, (n, _p, depth) => {
    if (ids.has(n.id)) fileError(path, `node id "${n.id}" is used twice`);
    ids.add(n.id);
    if (++count > LIMITS.nodesPerScene || depth >= LIMITS.depth) fileError(path, 'the scene is too large');
  });
  return scene;
}

/** Parses and checks gamestudio.json. Throws E_BAD_FILE (or E_NEWER_FORMAT). */
export function parseManifestFile(text: string): RepoManifest {
  const raw = parseJson(REPO_MANIFEST, text);
  if (!isPlainObject(raw) || raw.format !== REPO_FORMAT) fileError(REPO_MANIFEST, `not a Game Studio project file (expected "format": "${REPO_FORMAT}")`);
  const r = raw as Record<string, unknown>;
  if (typeof r.version !== 'number' || r.version > REPO_FORMAT_VERSION) throw new GameStudioError('E_NEWER_FORMAT', `${REPO_MANIFEST} was written by a newer version of Game Studio. Update the editor to open it.`);
  if (typeof r.projectFormatVersion !== 'number' || r.projectFormatVersion > PROJECT_FORMAT_VERSION) throw new GameStudioError('E_NEWER_FORMAT', `This project was saved by a newer version of Game Studio (format ${String(r.projectFormatVersion)}). Update the editor to open it.`);
  if (typeof r.name !== 'string' || !r.name.trim() || r.name.length > LIMITS.nameLength) fileError(REPO_MANIFEST, '"name" must be 1–100 characters');
  const settings = SettingsSchema.safeParse(r.settings);
  if (!settings.success) {
    const i = settings.error.issues[0];
    fileError(REPO_MANIFEST, `settings.${i.path.join('.')}: ${i.message}`);
  }
  const sizes: Record<string, [number, number]> = {};
  if (isPlainObject(r.imageSizes))
    for (const [p, v] of Object.entries(r.imageSizes)) if (Array.isArray(v) && v.length === 2 && v.every((x) => Number.isInteger(x) && x > 0 && x <= 65536)) sizes[p] = [v[0] as number, v[1] as number];
  return { format: REPO_FORMAT, version: r.version, projectFormatVersion: r.projectFormatVersion, name: (r.name as string).trim(), settings: settings.data as ProjectSettings, ...(Object.keys(sizes).length ? { imageSizes: sizes } : {}) };
}

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2' };

export const mimeForPath = (path: string) => MIME[extname(path)] ?? 'application/octet-stream';

/**
 * Asset metadata from a file's bytes. Image sizes come from the file header, else from
 * `known` (the previous metadata or gamestudio.json's imageSizes).
 */
export async function assetInfoFromBytes(path: string, data: Uint8Array, known?: { width?: number; height?: number }): Promise<AssetInfo> {
  const kind = assetKindForPath(path);
  if (kind === 'other') fileError(path, 'not a supported asset type');
  if (data.length > LIMITS.assetBytes) fileError(path, 'larger than the asset limit');
  const size = kind === 'image' ? (readImageSize(data) ?? (known?.width && known.height ? { width: known.width, height: known.height } : null)) : null;
  return { path, kind, mime: mimeForPath(path), size: data.length, hash: await sha256Hex(data), ...(size ? { width: size.width, height: size.height } : {}) };
}

export interface FilesToProjectResult {
  doc: ProjectDoc;
  /** Asset bytes by SHA-256, to store next to the document. */
  blobs: Map<string, { data: Uint8Array; mime: string }>;
  /** Files that were left out, and why (the project still opens). */
  issues: string[];
}

/**
 * Builds a project from repository files (text as string, binary as bytes). Files that are not
 * part of a project are ignored. A repository without gamestudio.json still opens, with default
 * settings (and a name from `opts.name`), so plain repositories of scenes and scripts can be used.
 */
export async function projectFromFiles(files: Map<string, string | Uint8Array>, opts: { id: string; name: string; now?: number }): Promise<FilesToProjectResult> {
  const now = opts.now ?? Date.now();
  const issues: string[] = [];
  const text = (p: string, v: string | Uint8Array) => (typeof v === 'string' ? v : decodeText(p, v));
  const mf = files.get(REPO_MANIFEST);
  const manifest = mf !== undefined ? parseManifestFile(text(REPO_MANIFEST, mf)) : null;
  const scenes: Record<string, SceneDoc> = {};
  const scripts: Record<string, string> = {};
  const assets: Record<string, AssetInfo> = {};
  const blobs = new Map<string, { data: Uint8Array; mime: string }>();
  for (const [p, v] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const role = repoFileRole(p);
    if (role === 'scene') scenes[p] = parseSceneFile(p, text(p, v));
    else if (role === 'script') {
      const src = text(p, v);
      if (src.length > LIMITS.scriptBytes) issues.push(`${p}: larger than ${LIMITS.scriptBytes / 1_000_000} MB, left out`);
      else scripts[p] = src;
    } else if (role === 'asset') {
      const data = typeof v === 'string' ? new TextEncoder().encode(v) : v;
      const s = manifest?.imageSizes?.[p];
      const info = await assetInfoFromBytes(p, data, s ? { width: s[0], height: s[1] } : undefined);
      assets[p] = info;
      blobs.set(info.hash, { data, mime: info.mime });
    }
  }
  const settings: ProjectSettings = manifest?.settings ?? structuredClone(DEFAULT_SETTINGS);
  if (!manifest && Object.keys(scenes).length) settings.mainScene = Object.keys(scenes)[0];
  if (settings.mainScene && !scenes[settings.mainScene]) {
    issues.push(`The main scene "${settings.mainScene}" is not in the repository`);
    settings.mainScene = null;
  }
  const raw = { format: PROJECT_FORMAT, formatVersion: manifest?.projectFormatVersion ?? PROJECT_FORMAT_VERSION, id: opts.id, name: manifest?.name ?? (opts.name.trim().slice(0, LIMITS.nameLength) || 'Game'), createdAt: now, updatedAt: now, settings, scenes, scripts, assets };
  const loaded = loadProjectDoc(raw);
  return { doc: loaded.doc, blobs, issues: [...issues, ...loaded.issues] };
}

/** UTF-8 text of a file (scripts and scenes must be text). */
export function decodeText(path: string, data: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(data);
  } catch {
    return fileError(path, 'not UTF-8 text');
  }
}

// --- file changes → commands -----------------------------------------------------------------------------------------

/** A change to one project file: new text (manifest, scene, script), new asset metadata, or deletion. */
export type FileUpdate = { path: string; text: string } | { path: string; asset: AssetInfo } | { path: string; deleted: true };

/**
 * Commands that bring `doc` in line with changed files, in an order the command layer accepts:
 * scripts and assets first, then scenes (which may use them), then settings, then deletions
 * (scenes that instance others before the scenes they instance). A scene that a remaining scene
 * still instances is not deleted; it is reported in `kept`.
 */
export function fileUpdatesToCommands(doc: ProjectDoc, updates: FileUpdate[]): { commands: Command[]; kept: string[] } {
  const writes: Command[] = [];
  const scenes: Command[] = [];
  const settings: Command[] = [];
  const deletes: Command[] = [];
  const deletedScenes = new Set<string>();
  const nextScenes: Record<string, SceneDoc> = { ...doc.scenes };
  for (const u of updates) {
    const role = repoFileRole(u.path);
    if ('deleted' in u) {
      if (role === 'scene' && doc.scenes[u.path]) {
        deletedScenes.add(u.path);
        delete nextScenes[u.path];
      } else if (role === 'script' && doc.scripts[u.path] !== undefined) deletes.push({ op: 'delete_script', path: u.path });
      else if (role === 'asset' && doc.assets[u.path]) deletes.push({ op: 'delete_asset', path: u.path });
      continue;
    }
    if ('asset' in u) {
      const { path: _p, ...info } = u.asset;
      writes.push({ op: 'add_asset', path: u.path, info, replace: !!doc.assets[u.path] });
    } else if (role === 'script') writes.push({ op: 'write_script', path: u.path, source: u.text });
    else if (role === 'scene') {
      const scene = parseSceneFile(u.path, u.text);
      nextScenes[u.path] = scene;
      scenes.push({ op: 'put_scene', path: u.path, scene });
    } else if (role === 'manifest') {
      const m = parseManifestFile(u.text);
      if (m.name !== doc.name) settings.push({ op: 'rename_project', name: m.name });
      settings.push({ op: 'update_settings', patch: m.settings as unknown as Record<string, unknown> });
    }
  }
  // Scenes still instanced by a scene that stays can't go: keep them (and say so).
  const kept: string[] = [];
  const instances = (s: SceneDoc) => {
    const out = new Set<string>();
    walkDoc(s.root, (n) => {
      if (n.instance) out.add(n.instance);
    });
    return out;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of deletedScenes) {
      if (Object.values(nextScenes).some((s) => instances(s).has(p))) {
        deletedScenes.delete(p);
        nextScenes[p] = doc.scenes[p];
        kept.push(p);
        changed = true;
      }
    }
  }
  // Delete instancing scenes before the scenes they instance.
  const order: string[] = [];
  const visit = (p: string, seen: Set<string>) => {
    if (order.includes(p) || seen.has(p)) return;
    seen.add(p);
    for (const q of deletedScenes) if (q !== p && instances(doc.scenes[q]).has(p)) visit(q, seen);
    order.push(p);
  };
  for (const p of deletedScenes) visit(p, new Set());
  const sceneDeletes: Command[] = order.map((path) => ({ op: 'delete_scene', path }));
  // The main scene setting must name a scene that exists when it is applied.
  const fix = settings.find((c) => c.op === 'update_settings');
  if (fix && fix.op === 'update_settings') {
    const main = (fix.patch as { mainScene?: string | null }).mainScene;
    if (main && !nextScenes[main]) fix.patch = { ...fix.patch, mainScene: null };
  }
  return { commands: [...writes, ...scenes, ...settings, ...sceneDeletes, ...deletes], kept };
}
