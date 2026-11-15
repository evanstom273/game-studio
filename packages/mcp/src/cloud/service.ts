/**
 * The MCP tools, executed against the cloud copy of the user's projects (CloudStore). This is what
 * lets an AI assistant work in the background: no editor has to be open. Edits go through the same
 * command layer (@gs/project) as the editor's UI, and open editors are told about every change.
 *
 * The few things that need a browser — running a game, the game console, building an export — are
 * passed to an open editor if there is one, and otherwise answered with a clear explanation.
 */
import { GameStudioError, Signal, base64ToBytes, errorMessage, sha256Hex } from '@gs/shared';
import { assetKindForPath, nodeTypes } from '@gs/core';
import { TEMPLATES, applyCommands, createProject, generateTexture, projectDiagnostics, projectRevision, projectSummary, readImageSize, sceneOutline, type Command, type ProjectDoc, type TemplateId } from '@gs/project';
import type { BridgeMethod, EditorRequest } from '../protocol.ts';
import { handleVisual, VISUAL_METHODS, VISUAL_READ, type VisualMethod } from './visual.ts';
import { CloudStore, type Permissions } from './store.ts';
import { checkScripts } from './syntax.ts';

export interface EditorLink {
  /** True when at least one editor tab is connected. */
  connected(): boolean;
  /** Ask the connected editor to do something only a browser can. */
  ask(method: EditorRequest, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
}

export type CloudNotice = { type: 'project-updated'; id: string; revision: string; label: string } | { type: 'project-deleted'; id: string };

const READ: BridgeMethod[] = ['status', 'list_projects', 'get_project', 'list_node_types', 'get_node_type', 'get_scene', 'read_script', 'list_assets', 'get_console', 'get_diagnostics', ...(VISUAL_READ as BridgeMethod[])];
const FULL: BridgeMethod[] = ['run_scene', 'stop_game', 'export_project'];
const OTHER_PROJECTS: BridgeMethod[] = ['create_project', 'open_project'];
const NODE_OPS = new Set(['add_node', 'set_props', 'reset_props', 'set_script_props', 'rename_node', 'remove_node', 'reparent_node', 'move_node', 'duplicate_node', 'attach_script', 'set_groups', 'connect_signal', 'disconnect_signal']);

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', glb: 'model/gltf-binary', gltf: 'model/gltf+json', ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2' };

const NO_EDITOR = 'This needs Game Studio open in a browser on any of your devices: games run there, not in the cloud. Everything else (building scenes, scripts, assets, checking for problems) works without it.';

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

function nodeTypeInfo(type: string) {
  const info = nodeTypes.require(type);
  let signals: string[] = [];
  if (!info.abstract) {
    const probe = new info.ctor() as unknown as Record<string, unknown>;
    signals = Object.keys(probe).filter((k) => probe[k] instanceof Signal);
  }
  return {
    name: info.name,
    inherits: nodeTypes.chain(type).slice(1),
    category: info.category,
    dimension: nodeTypes.dimension(type),
    description: info.description,
    abstract: !!info.abstract,
    signals,
    properties: nodeTypes.properties(type).map((p) => ({
      name: p.name,
      type: p.type === 'resource' ? `resource:${p.resource}` : p.type,
      default: p.default,
      ...(p.min !== undefined ? { min: p.min } : {}),
      ...(p.max !== undefined ? { max: p.max } : {}),
      ...(p.options ? { options: p.options } : {}),
      ...(p.degrees ? { unit: 'radians (or pass rotationDegrees)' } : {}),
      ...(p.nullable ? { nullable: true } : {}),
      ...(p.hint ? { hint: p.hint } : {}),
    })),
  };
}

export class CloudService {
  constructor(
    readonly store: CloudStore,
    private readonly editor: EditorLink,
    private readonly notify: (n: CloudNotice) => void,
  ) {}

  private async permissions(): Promise<Permissions> {
    return (await this.store.meta()).permissions;
  }

  private check(method: BridgeMethod, p: Permissions) {
    if (p.level === 'read' && !READ.includes(method)) throw new GameStudioError('E_FORBIDDEN', 'This AI connection is read-only. The user can allow edits in Game Studio → AI connection.');
    if (p.level === 'edit' && FULL.includes(method)) throw new GameStudioError('E_FORBIDDEN', 'Running and exporting games is not allowed for this AI connection. The user can allow it in Game Studio → AI connection.');
    if (p.scope === 'open-project' && OTHER_PROJECTS.includes(method)) throw new GameStudioError('E_FORBIDDEN', 'This AI connection may only work on the project that is open in Game Studio.');
  }

  /** A project by id/name, or the active one, or the only one. */
  private async project(ref?: string): Promise<ProjectDoc> {
    const meta = await this.store.meta();
    const all = await this.store.list();
    let id: string | undefined;
    if (ref) {
      id = all.find((p) => p.id === ref)?.id;
      if (!id) {
        const byName = all.filter((p) => p.name.toLowerCase() === ref.toLowerCase());
        if (byName.length > 1) throw new GameStudioError('E_AMBIGUOUS', `Several projects are called "${ref}": ${byName.map((p) => p.id).join(', ')}. Use the id.`);
        id = byName[0]?.id;
      }
      if (!id) throw new GameStudioError('E_NOT_FOUND', `No project "${ref}". Use list_projects.`);
    } else {
      id = meta.active && all.some((p) => p.id === meta.active) ? meta.active : all.length === 1 ? all[0].id : undefined;
      if (!id) throw new GameStudioError('E_NO_PROJECT', all.length ? 'Several projects exist and none is open. Use open_project (or pass "project").' : 'There are no projects yet. Use create_project.');
    }
    if (meta.permissions.scope === 'open-project' && id !== meta.active) throw new GameStudioError('E_FORBIDDEN', 'This AI connection may only work on the project that is open in Game Studio.');
    const doc = await this.store.get(id);
    if (!doc) throw new GameStudioError('E_NOT_FOUND', `Project "${ref ?? id}" could not be read`);
    if (meta.active !== id && !ref) await this.store.setMeta({ active: id });
    return doc;
  }

  private scenePath(doc: ProjectDoc, scene?: string) {
    if (scene) {
      const clean = scene.replace(/^res:\/\//, '').replace(/^\/+/, '');
      if (!doc.scenes[clean]) throw new GameStudioError('E_NOT_FOUND', `No scene "${scene}". Scenes: ${Object.keys(doc.scenes).join(', ') || '(none)'}`);
      return clean;
    }
    const main = doc.settings.mainScene;
    if (main && doc.scenes[main]) return main;
    const first = Object.keys(doc.scenes)[0];
    if (!first) throw new GameStudioError('E_NO_SCENE', 'The project has no scenes yet. Use create_scene.');
    return first;
  }

  private checkRevision(doc: ProjectDoc, expected: unknown) {
    if (typeof expected !== 'string' || !expected) return;
    const rev = projectRevision(doc);
    if (rev !== expected) throw new GameStudioError('E_REVISION_CONFLICT', `The project changed since revision ${expected} (now ${rev}) — probably the user edited it. Read it again and retry.`, { revision: rev });
  }

  /** Applies commands to the stored project: one AI undo step, and open editors update live. */
  private async edit(doc: ProjectDoc, commands: Command[], label: string) {
    const r = applyCommands(doc, commands);
    if (r.project !== doc) {
      await this.store.put(r.project);
      await this.store.record(doc, r.project, label);
      this.notify({ type: 'project-updated', id: doc.id, revision: projectRevision(r.project), label: `AI: ${label}` });
    }
    return { results: r.results, refs: r.refs, revision: projectRevision(r.project), project: r.project };
  }

  private async addAsset(doc: ProjectDoc, path: string, bytes: Uint8Array, replace: boolean) {
    const kind = assetKindForPath(path);
    if (kind === 'other') throw new GameStudioError('E_UNSUPPORTED', `Unsupported file type for "${path}". Supported: ${Object.keys(MIME).join(', ')}`);
    if (bytes.length > 50 * 1024 * 1024) throw new GameStudioError('E_TOO_LARGE', 'Assets are limited to 50 MB');
    const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    const mime = MIME[ext] ?? 'application/octet-stream';
    const hash = await sha256Hex(bytes);
    const size = kind === 'image' ? readImageSize(bytes) : null;
    await this.store.putBlob(doc.id, hash, bytes, mime);
    const r = await this.edit(doc, [{ op: 'add_asset', path, info: { kind, mime, size: bytes.length, hash, ...(size ? { width: size.width, height: size.height } : {}) }, replace }], `Import ${path}`);
    return { path, kind, size: bytes.length, revision: r.revision };
  }

  /** Runs one MCP tool. */
  async handle(method: BridgeMethod, params: Record<string, unknown>): Promise<unknown> {
    const perms = await this.permissions();
    this.check(method, perms);
    if ((VISUAL_METHODS as readonly string[]).includes(method)) {
      return handleVisual({ project: (ref) => this.project(ref), edit: (doc, commands, label) => this.edit(doc, commands, label), scenePath: (doc, scene) => this.scenePath(doc, scene), checkRevision: (doc, rev) => this.checkRevision(doc, rev) }, method as VisualMethod, params);
    }
    switch (method) {
      case 'status': {
        const meta = await this.store.meta();
        const active = meta.active ? await this.store.get(meta.active) : null;
        return {
          app: 'Game Studio',
          mode: 'cloud copy — works with no editor open',
          editorOpen: this.editor.connected(),
          project: active ? { id: active.id, name: active.name, revision: projectRevision(active), mainScene: active.settings.mainScene, scenes: Object.keys(active.scenes) } : null,
          permissions: perms,
          notes: [
            ...(active ? [] : ['No project is open: use list_projects + open_project, or create_project.']),
            ...(this.editor.connected() ? [] : ['No editor is open, so run_scene, get_console and export_project are unavailable until the user opens Game Studio. Everything else works.']),
          ],
        };
      }
      case 'list_projects': {
        const meta = await this.store.meta();
        const all = await this.store.list();
        const visible = perms.scope === 'open-project' ? all.filter((p) => p.id === meta.active) : all;
        return { projects: visible.map((p) => ({ id: p.id, name: p.name, updated: new Date(p.updatedAt).toISOString(), open: p.id === meta.active })) };
      }
      case 'create_project': {
        const template = (str(params.template) ?? 'empty-2d') as TemplateId;
        if (!TEMPLATES.some((t) => t.id === template)) throw new GameStudioError('E_INVALID_VALUE', `Unknown template ${template}`);
        const { doc, blobs } = await createProject(str(params.name) ?? 'New game', template);
        for (const [hash, data] of blobs) await this.store.putBlob(doc.id, hash, data, 'image/png');
        await this.store.put(doc);
        await this.store.setMeta({ active: doc.id });
        this.notify({ type: 'project-updated', id: doc.id, revision: projectRevision(doc), label: 'AI: Create project' });
        return { ...projectSummary(doc), note: 'Created. It appears in Game Studio the next time it is opened (live if it is open).' };
      }
      case 'open_project': {
        const doc = await this.project(str(params.project));
        await this.store.setMeta({ active: doc.id });
        return projectSummary(doc);
      }
      case 'get_project': {
        const doc = await this.project(str(params.project));
        const diags = projectDiagnostics(doc);
        return { ...projectSummary(doc), settings: doc.settings, problems: { errors: diags.filter((d) => d.severity === 'error').length, warnings: diags.filter((d) => d.severity === 'warning').length } };
      }
      case 'save_project': {
        const doc = await this.project();
        return { saved: true, revision: projectRevision(doc), note: 'The cloud copy is saved after every change.' };
      }
      case 'list_node_types': {
        const cat = str(params.category)?.toLowerCase();
        const grouped: Record<string, { name: string; description: string }[]> = {};
        for (const t of nodeTypes.list().filter((t) => !cat || t.category.toLowerCase() === cat)) (grouped[t.category] ??= []).push({ name: t.name, description: t.description });
        return grouped;
      }
      case 'get_node_type':
        return nodeTypeInfo(str(params.type) ?? '');
      case 'get_scene': {
        const doc = await this.project(str(params.project));
        const path = this.scenePath(doc, str(params.scene));
        const scene = doc.scenes[path];
        return { path, revision: projectRevision(doc), isMain: doc.settings.mainScene === path, outline: sceneOutline(scene), scene, warnings: projectDiagnostics(doc).filter((d) => d.file === path).map((d) => `${d.nodePath ?? ''} ${d.message}`.trim()) };
      }
      case 'create_scene': {
        const doc = await this.project();
        const path = str(params.path) ?? '';
        const commands: Command[] = [{ op: 'create_scene', path, rootType: str(params.rootType) ?? 'Node2D', rootName: str(params.rootName) }];
        if (params.setMain === true) commands.push({ op: 'set_main_scene', path });
        const r = await this.edit(doc, commands, `Create ${path}`);
        return { results: r.results, revision: r.revision };
      }
      case 'delete_scene': {
        const doc = await this.project();
        const path = this.scenePath(doc, str(params.path));
        await this.confirmDelete(perms, `the scene “${path}”`);
        const r = await this.edit(doc, [{ op: 'delete_scene', path }], `Delete ${path}`);
        return { results: r.results, revision: r.revision };
      }
      case 'add_node': {
        const doc = await this.project();
        this.checkRevision(doc, params.expected_revision);
        const scene = this.scenePath(doc, str(params.scene));
        const r = await this.edit(doc, [{ op: 'add_node', scene, parent: str(params.parent), type: str(params.type), name: str(params.name), props: params.props as Record<string, unknown> | undefined, script: str(params.script), instance: str(params.instance) }], `Add ${str(params.name) ?? str(params.type) ?? 'node'}`);
        return { results: r.results, revision: r.revision };
      }
      case 'update_node': {
        const doc = await this.project();
        this.checkRevision(doc, params.expected_revision);
        const scene = this.scenePath(doc, str(params.scene));
        const node = str(params.node) ?? '';
        const commands: Command[] = [];
        if (params.props && Object.keys(params.props as object).length) commands.push({ op: 'set_props', scene, node, props: params.props as Record<string, unknown> });
        if (params.scriptProps) commands.push({ op: 'set_script_props', scene, node, values: params.scriptProps as Record<string, unknown> });
        if (Array.isArray(params.groups)) commands.push({ op: 'set_groups', scene, node, groups: params.groups as string[] });
        if (str(params.name)) commands.push({ op: 'rename_node', scene, node, name: str(params.name)! });
        if (!commands.length) throw new GameStudioError('E_INVALID_VALUE', 'Nothing to change: pass props, name, scriptProps or groups');
        const r = await this.edit(doc, commands, `Change ${node}`);
        return { results: r.results, revision: r.revision };
      }
      case 'remove_node':
      case 'reparent_node':
      case 'duplicate_node': {
        const doc = await this.project();
        this.checkRevision(doc, params.expected_revision);
        const scene = this.scenePath(doc, str(params.scene));
        const node = str(params.node) ?? '';
        const command: Command =
          method === 'remove_node' ? { op: 'remove_node', scene, node } : method === 'reparent_node' ? { op: 'reparent_node', scene, node, parent: str(params.parent) ?? '', keepGlobalTransform: params.keepGlobalTransform === true } : { op: 'duplicate_node', scene, node, name: str(params.name) };
        const r = await this.edit(doc, [command], `${method.replace('_node', '')} ${node}`);
        return { results: r.results, revision: r.revision };
      }
      case 'edit_project': {
        const doc = await this.project();
        this.checkRevision(doc, params.expected_revision);
        const raw = Array.isArray(params.commands) ? (params.commands as Command[]) : [];
        const commands = raw.map((c) => (c && typeof c === 'object' && !('scene' in c) && NODE_OPS.has((c as { op: string }).op) ? ({ ...c, scene: this.scenePath(doc) } as unknown as Command) : c));
        const deletes = commands.filter((c) => c?.op === 'delete_scene').map((c) => (c as { path: string }).path);
        if (deletes.length) await this.confirmDelete(perms, deletes.join(', '));
        const r = await this.edit(doc, commands, `Edit (${commands.length} change${commands.length === 1 ? '' : 's'})`);
        return { results: r.results, refs: r.refs, revision: r.revision };
      }
      case 'read_script': {
        const doc = await this.project();
        const path = str(params.path) ?? '';
        const source = doc.scripts[path];
        if (source === undefined) throw new GameStudioError('E_NOT_FOUND', `No script "${path}". Scripts: ${Object.keys(doc.scripts).join(', ') || '(none)'}`);
        return { path, source };
      }
      case 'write_script': {
        const doc = await this.project();
        this.checkRevision(doc, params.expected_revision);
        const path = str(params.path) ?? '';
        const commands: Command[] = [{ op: 'write_script', path, source: String(params.source ?? '') }];
        const attach = params.attach as { scene?: string; node: string } | undefined;
        if (attach) commands.push({ op: 'attach_script', scene: this.scenePath(doc, attach.scene), node: attach.node, script: path });
        const r = await this.edit(doc, commands, `Write ${path}`);
        const diagnostics = checkScripts(r.project.scripts, [path]);
        return { results: r.results, revision: r.revision, compiled: diagnostics.length === 0, diagnostics, note: diagnostics.length ? 'Fix the errors in diagnostics.' : 'Syntax and imports are fine (types are not checked). Use run_scene when an editor is open to try it.' };
      }
      case 'list_assets': {
        const doc = await this.project();
        return { assets: Object.values(doc.assets).map((a) => ({ path: a.path, kind: a.kind, size: a.size, ...(a.width ? { width: a.width, height: a.height } : {}) })) };
      }
      case 'import_asset': {
        const doc = await this.project();
        let bytes: Uint8Array;
        try {
          bytes = base64ToBytes(String(params.base64 ?? '').replace(/^data:[^,]*,/, ''));
        } catch {
          throw new GameStudioError('E_INVALID_VALUE', 'base64 is not valid base64 data');
        }
        return this.addAsset(doc, str(params.path) ?? '', bytes, params.replace === true);
      }
      case 'create_texture': {
        const doc = await this.project();
        const png = generateTexture(Number(params.width), Number(params.height), (str(params.shape) ?? 'rect') as 'rect', str(params.color) ?? '#4f8cff', str(params.color2));
        return this.addAsset(doc, str(params.path) ?? 'textures/texture.png', png, false);
      }
      case 'get_diagnostics': {
        const doc = await this.project();
        const diags = [...checkScripts(doc.scripts), ...projectDiagnostics(doc)];
        return { errors: diags.filter((d) => d.severity === 'error').length, warnings: diags.filter((d) => d.severity === 'warning').length, diagnostics: diags, note: 'Script syntax and imports are checked here; type errors and runtime errors show up with run_scene.' };
      }
      case 'run_scene': {
        const doc = await this.project();
        if (!this.editor.connected()) throw new GameStudioError('E_NO_EDITOR', NO_EDITOR);
        const scene = str(params.scene) ? this.scenePath(doc, str(params.scene)) : null;
        const seconds = Math.min(30, Math.max(0.5, Number(params.seconds ?? 3)));
        return this.editor.ask('run_scene', { project: doc.id, revision: projectRevision(doc), scene, seconds, keepRunning: params.keepRunning === true }, seconds * 1000 + 60_000);
      }
      case 'stop_game':
        if (!this.editor.connected()) return { stopped: true, note: 'No editor is open, so no game is running.' };
        return this.editor.ask('stop_game', {});
      case 'get_console':
        if (!this.editor.connected()) return { entries: [], note: 'No editor is open. The console shows output from games run in Game Studio.' };
        return this.editor.ask('get_console', params);
      case 'export_project': {
        const doc = await this.project();
        if (!this.editor.connected()) throw new GameStudioError('E_NO_EDITOR', `Exporting builds and downloads files in the browser. ${NO_EDITOR}`);
        return this.editor.ask('export_project', { ...params, project: doc.id, revision: projectRevision(doc) }, 180_000);
      }
      case 'undo':
      case 'redo': {
        const doc = await this.project();
        const r = await this.store.step(doc.id, doc, method);
        if ('error' in r) throw new GameStudioError('E_NOTHING', r.error);
        const next = { ...r.doc, updatedAt: Date.now() };
        await this.store.put(next);
        this.notify({ type: 'project-updated', id: doc.id, revision: projectRevision(next), label: `AI: ${method === 'undo' ? 'Undo' : 'Redo'} ${r.label}` });
        return { [method === 'undo' ? 'undone' : 'redone']: r.label, revision: projectRevision(next) };
      }
    }
  }

  private async confirmDelete(perms: Permissions, what: string) {
    if (!perms.confirmDestructive) return;
    if (!this.editor.connected()) throw new GameStudioError('E_NEEDS_CONFIRMATION', `Deleting ${what} needs the user's OK in Game Studio, which isn't open. Ask them to open it, or to switch off "Ask me before the AI deletes scenes".`);
    let ok: boolean;
    try {
      ok = (await this.editor.ask('confirm', { title: 'Delete?', message: `An AI assistant wants to delete ${what}. You can undo this.` }, 300_000)) === true;
    } catch (e) {
      throw new GameStudioError('E_DECLINED', `Couldn't get the user's confirmation: ${errorMessage(e)}`);
    }
    if (!ok) throw new GameStudioError('E_DECLINED', 'The user declined the deletion.');
  }
}
