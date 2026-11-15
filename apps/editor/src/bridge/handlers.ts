/**
 * MCP tool calls, executed in the editor. Each one uses the same services and command layer as
 * the UI; edits become one undo step labelled "AI: …". Permissions chosen by the user in the
 * AI-connection dialog are enforced here.
 */
import { GameStudioError, Signal, base64ToBytes, errorMessage } from '@gs/shared';
import { nodeTypes, type LogEntry } from '@gs/core';
import { TEMPLATES, projectDiagnostics, projectRevision, projectSummary, sceneOutline, type Command, type TemplateId } from '@gs/project';
import type { BridgeMethod } from '@gs/mcp';
import { listProjects } from '@editor/db/projects';
import { useEditor } from '@editor/store/editor';
import { useConsole } from '@editor/store/console';
import { usePlay, stopGame } from '@editor/play/player-host';
import { generateTexture, importAssetBytes } from '@editor/services/assets';
import { saveNow } from '@editor/services/autosave';
import { allDiagnostics, createAndOpenProject, exportArchiveFile, exportWeb, openProjectById, requireProject, resolveProjectId, resolveScenePath, runScene } from '@editor/services/editor-service';
import { compileProjectScripts } from '@editor/scripting/compiler';
import { confirmDialog } from '@editor/components/ui/feedback';
import { useBridge } from './client';

const READ: BridgeMethod[] = ['status', 'list_projects', 'get_project', 'list_node_types', 'get_node_type', 'get_scene', 'read_script', 'list_assets', 'get_console', 'get_diagnostics'];
const FULL: BridgeMethod[] = ['run_scene', 'stop_game', 'export_project'];
const OTHER_PROJECTS: BridgeMethod[] = ['create_project', 'open_project'];

function checkPermission(method: BridgeMethod) {
  const p = useBridge.getState().permissions;
  if (p.level === 'read' && !READ.includes(method)) throw new GameStudioError('E_FORBIDDEN', `This AI connection is read-only. The user can allow edits in Game Studio → AI connection.`);
  if (p.level === 'edit' && FULL.includes(method)) throw new GameStudioError('E_FORBIDDEN', `Running and exporting games is not allowed for this AI connection. The user can allow it in Game Studio → AI connection.`);
  if (p.scope === 'open-project' && OTHER_PROJECTS.includes(method)) throw new GameStudioError('E_FORBIDDEN', 'This AI connection may only work on the project that is open in the editor.');
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

function checkRevision(expected: unknown) {
  if (typeof expected !== 'string' || !expected) return;
  const rev = projectRevision(requireProject());
  if (rev !== expected) throw new GameStudioError('E_REVISION_CONFLICT', `The project changed since revision ${expected} (now ${rev}) — probably the user edited it. Read it again (get_scene / get_project) and retry.`, { revision: rev });
}

function edit(commands: Command[], label?: string) {
  const r = useEditor.getState().dispatch(commands, { source: 'mcp', label });
  return { results: r.results, refs: r.refs, revision: projectRevision(r.project) };
}

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

function consoleEntries(entries: { level: LogEntry['level']; message: string; source?: string; origin: string; repeat: number; time: number }[]) {
  return entries.map((e) => ({ level: e.level, from: e.origin, message: e.message, ...(e.source ? { at: e.source } : {}), ...(e.repeat > 1 ? { repeated: e.repeat } : {}) }));
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function handleBridgeRequest(method: BridgeMethod, params: Record<string, unknown>): Promise<unknown> {
  checkPermission(method);
  const perms = useBridge.getState().permissions;
  switch (method) {
    case 'status': {
      const s = useEditor.getState();
      const play = usePlay.getState();
      return {
        app: 'Game Studio',
        version: '0.1.0',
        project: s.project ? { id: s.project.id, name: s.project.name, revision: projectRevision(s.project), mainScene: s.project.settings.mainScene } : null,
        activeDocument: s.active,
        openDocuments: s.openDocs,
        selection: s.selection,
        game: { status: play.status, scene: play.scene, fps: play.fps },
        permissions: perms,
        hint: s.project ? undefined : 'No project is open: use list_projects + open_project, or create_project.',
      };
    }
    case 'list_projects': {
      const all = await listProjects();
      const open = useEditor.getState().project?.id;
      const visible = perms.scope === 'open-project' ? all.filter((p) => p.id === open) : all;
      return { projects: visible.map((p) => ({ id: p.id, name: p.name, kind: p.kind, scenes: p.scenes, scripts: p.scripts, assets: p.assets, updated: new Date(p.updatedAt).toISOString(), open: p.id === open })) };
    }
    case 'create_project': {
      const template = (str(params.template) ?? 'empty-2d') as TemplateId;
      if (!TEMPLATES.some((t) => t.id === template)) throw new GameStudioError('E_INVALID_VALUE', `Unknown template ${template}`);
      const doc = await createAndOpenProject(str(params.name) ?? 'New game', template);
      return { ...projectSummary(doc), note: 'Created and opened.' };
    }
    case 'open_project': {
      const id = await resolveProjectId(str(params.project) ?? '');
      return projectSummary(await openProjectById(id));
    }
    case 'get_project': {
      const ref = str(params.project);
      const project = requireProject();
      if (ref && ref !== project.id && ref.toLowerCase() !== project.name.toLowerCase()) throw new GameStudioError('E_NOT_OPEN', `Only the open project ("${project.name}") can be inspected in detail. Use open_project first.`);
      const diags = projectDiagnostics(project);
      return { ...projectSummary(project), settings: project.settings, problems: { errors: diags.filter((d) => d.severity === 'error').length, warnings: diags.filter((d) => d.severity === 'warning').length } };
    }
    case 'save_project':
      requireProject();
      await saveNow();
      return { saved: true, revision: projectRevision(requireProject()) };
    case 'list_node_types': {
      const cat = str(params.category)?.toLowerCase();
      const types = nodeTypes.list().filter((t) => !cat || t.category.toLowerCase() === cat);
      const grouped: Record<string, { name: string; description: string }[]> = {};
      for (const t of types) (grouped[t.category] ??= []).push({ name: t.name, description: t.description });
      return grouped;
    }
    case 'get_node_type':
      return nodeTypeInfo(str(params.type) ?? '');
    case 'get_scene': {
      const project = requireProject();
      const path = resolveScenePath(str(params.scene));
      const scene = project.scenes[path];
      return { path, revision: projectRevision(project), isMain: project.settings.mainScene === path, outline: sceneOutline(scene), scene, warnings: projectDiagnostics(project).filter((d) => d.file === path).map((d) => `${d.nodePath ?? ''} ${d.message}`.trim()) };
    }
    case 'create_scene': {
      requireProject();
      const path = str(params.path) ?? '';
      const commands: Command[] = [{ op: 'create_scene', path, rootType: str(params.rootType) ?? 'Node2D', rootName: str(params.rootName) }];
      if (params.setMain === true) commands.push({ op: 'set_main_scene', path });
      const r = edit(commands);
      useEditor.getState().openDoc({ kind: 'scene', path: r.results[0].path! });
      return r;
    }
    case 'delete_scene': {
      const path = resolveScenePath(str(params.path));
      if (perms.confirmDestructive && !(await confirmDialog({ title: 'Delete scene?', message: `An AI assistant wants to delete the scene “${path}”. You can undo this.`, confirm: 'Delete', danger: true }))) {
        throw new GameStudioError('E_DECLINED', 'The user declined deleting the scene.');
      }
      return edit([{ op: 'delete_scene', path }]);
    }
    case 'add_node': {
      checkRevision(params.expected_revision);
      const scene = resolveScenePath(str(params.scene));
      return edit([{ op: 'add_node', scene, parent: str(params.parent), type: str(params.type), name: str(params.name), props: params.props as Record<string, unknown> | undefined, script: str(params.script), instance: str(params.instance) }]);
    }
    case 'update_node': {
      checkRevision(params.expected_revision);
      const scene = resolveScenePath(str(params.scene));
      const node = str(params.node) ?? '';
      const commands: Command[] = [];
      if (params.props && Object.keys(params.props as object).length) commands.push({ op: 'set_props', scene, node, props: params.props as Record<string, unknown> });
      if (params.scriptProps) commands.push({ op: 'set_script_props', scene, node, values: params.scriptProps as Record<string, unknown> });
      if (Array.isArray(params.groups)) commands.push({ op: 'set_groups', scene, node, groups: params.groups as string[] });
      if (str(params.name)) commands.push({ op: 'rename_node', scene, node, name: str(params.name)! });
      if (!commands.length) throw new GameStudioError('E_INVALID_VALUE', 'Nothing to change: pass props, name, scriptProps or groups');
      return edit(commands);
    }
    case 'remove_node':
      checkRevision(params.expected_revision);
      return edit([{ op: 'remove_node', scene: resolveScenePath(str(params.scene)), node: str(params.node) ?? '' }]);
    case 'reparent_node':
      checkRevision(params.expected_revision);
      return edit([{ op: 'reparent_node', scene: resolveScenePath(str(params.scene)), node: str(params.node) ?? '', parent: str(params.parent) ?? '', keepGlobalTransform: params.keepGlobalTransform === true }]);
    case 'duplicate_node':
      checkRevision(params.expected_revision);
      return edit([{ op: 'duplicate_node', scene: resolveScenePath(str(params.scene)), node: str(params.node) ?? '', name: str(params.name) }]);
    case 'edit_project': {
      checkRevision(params.expected_revision);
      requireProject();
      const commands = params.commands as Command[];
      const project = requireProject();
      // Fill in the active scene for node commands that omit it.
      const filled = commands.map((c) => ('scene' in (c as object) || !['add_node', 'set_props', 'reset_props', 'set_script_props', 'rename_node', 'remove_node', 'reparent_node', 'move_node', 'duplicate_node', 'attach_script', 'set_groups', 'connect_signal', 'disconnect_signal'].includes((c as { op: string }).op) ? c : { ...c, scene: resolveScenePath() }) as Command);
      const deletes = filled.filter((c) => c.op === 'delete_scene');
      if (deletes.length && perms.confirmDestructive && !(await confirmDialog({ title: 'Delete scenes?', message: `An AI assistant wants to delete ${deletes.map((d) => (d as { path: string }).path).join(', ')}. You can undo this.`, confirm: 'Delete', danger: true }))) {
        throw new GameStudioError('E_DECLINED', 'The user declined deleting scenes.');
      }
      void project;
      return edit(filled);
    }
    case 'read_script': {
      const project = requireProject();
      const path = str(params.path) ?? '';
      const source = project.scripts[path];
      if (source === undefined) throw new GameStudioError('E_NOT_FOUND', `No script "${path}". Scripts: ${Object.keys(project.scripts).join(', ') || '(none)'}`);
      return { path, source };
    }
    case 'write_script': {
      checkRevision(params.expected_revision);
      const path = str(params.path) ?? '';
      const commands: Command[] = [{ op: 'write_script', path, source: String(params.source ?? '') }];
      const attach = params.attach as { scene?: string; node: string } | undefined;
      if (attach) commands.push({ op: 'attach_script', scene: resolveScenePath(attach.scene), node: attach.node, script: path });
      const r = edit(commands, `Write ${path}`);
      const compiled = await compileProjectScripts(requireProject().scripts);
      const diagnostics = compiled.diagnostics.filter((d) => !d.file || d.file === path);
      return { ...r, compiled: compiled.ok, diagnostics, note: compiled.ok ? 'Compiles. Use run_scene to test it.' : 'Fix the errors in diagnostics.' };
    }
    case 'list_assets':
      return { assets: Object.values(requireProject().assets).map((a) => ({ path: a.path, kind: a.kind, size: a.size, ...(a.width ? { width: a.width, height: a.height } : {}) })) };
    case 'import_asset': {
      requireProject();
      let bytes: Uint8Array;
      try {
        bytes = base64ToBytes(String(params.base64 ?? '').replace(/^data:[^,]*,/, ''));
      } catch {
        throw new GameStudioError('E_INVALID_VALUE', 'base64 is not valid base64 data');
      }
      const r = await importAssetBytes(str(params.path) ?? '', bytes, { replace: params.replace === true, source: 'mcp' });
      return { ...r, revision: projectRevision(requireProject()) };
    }
    case 'create_texture': {
      requireProject();
      const png = generateTexture(Number(params.width), Number(params.height), (str(params.shape) ?? 'rect') as 'rect', str(params.color) ?? '#4f8cff', str(params.color2));
      const r = await importAssetBytes(str(params.path) ?? 'textures/texture.png', png, { source: 'mcp' });
      return { ...r, revision: projectRevision(requireProject()) };
    }
    case 'run_scene': {
      const seconds = Math.min(30, Math.max(0.5, Number(params.seconds ?? 3)));
      const before = useConsole.getState().entries.at(-1)?.id ?? 0;
      let started = true;
      let scene = '';
      let startError: string | undefined;
      try {
        scene = await runScene(str(params.scene));
        await wait(seconds * 1000);
      } catch (e) {
        started = false;
        startError = errorMessage(e);
      }
      const play = usePlay.getState();
      const entries = useConsole.getState().entries.filter((e) => e.id > before);
      const errors = entries.filter((e) => e.level === 'error');
      const result = {
        scene,
        started,
        ...(startError ? { error: startError } : {}),
        status: play.status,
        ranFor: started ? `${seconds}s` : undefined,
        fps: play.fps,
        nodes: play.nodes,
        errors: errors.length,
        console: consoleEntries(entries.slice(-150)),
        note: document.hidden ? 'The editor tab is in the background, so the browser may have slowed the game down.' : undefined,
      };
      if (params.keepRunning !== true) stopGame();
      return result;
    }
    case 'stop_game':
      stopGame();
      return { stopped: true };
    case 'get_console': {
      const level = str(params.level);
      const limit = Number(params.limit ?? 100);
      const entries = useConsole.getState().entries.filter((e) => !level || e.level === level);
      return { entries: consoleEntries(entries.slice(-limit)) };
    }
    case 'get_diagnostics': {
      const diags = await allDiagnostics();
      return { errors: diags.filter((d) => d.severity === 'error').length, warnings: diags.filter((d) => d.severity === 'warning').length, diagnostics: diags };
    }
    case 'export_project':
      return (str(params.format) ?? 'web') === 'archive' ? exportArchiveFile() : exportWeb();
    case 'undo': {
      const label = useEditor.getState().undo();
      if (!label) throw new GameStudioError('E_NOTHING', 'Nothing to undo');
      return { undone: label, revision: projectRevision(requireProject()) };
    }
    case 'redo': {
      const label = useEditor.getState().redo();
      if (!label) throw new GameStudioError('E_NOTHING', 'Nothing to redo');
      return { redone: label, revision: projectRevision(requireProject()) };
    }
  }
}
