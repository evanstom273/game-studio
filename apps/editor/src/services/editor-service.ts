/**
 * Editor operations shared by the UI and the MCP bridge. Anything an AI assistant can do goes
 * through here (and through the command layer for edits) — there is no separate AI-only logic.
 */
import { GameStudioError } from '@gs/shared';
import { projectDiagnostics, type Diagnostic, type ProjectDoc, type TemplateId } from '@gs/project';
import { addBackup, createNewProject, exportProjectArchive, listProjects, loadProject } from '@editor/db/projects';
import { useEditor } from '@editor/store/editor';
import { navigate } from '@editor/lib/router';
import { download, safeFileName } from '@editor/lib/files';
import { loadProjectAssets, releaseAssets } from './assets';
import { saveNow } from './autosave';
import { compileProjectScripts } from '@editor/scripting/compiler';
import { startGame, stopGame } from '@editor/play/player-host';
import { buildWebExport } from '@editor/export/web-export';
import { toast } from '@editor/store/toasts';

let opening: Promise<ProjectDoc> | null = null;
let openingId: string | null = null;

/** Opens a project (saving the current one first). Safe to call repeatedly with the same id. */
export function openProjectById(id: string): Promise<ProjectDoc> {
  const current = useEditor.getState().project;
  if (current?.id === id) return Promise.resolve(current);
  if (opening && openingId === id) return opening;
  openingId = id;
  opening = (async () => {
    try {
      await saveNow().catch(() => {});
      stopGame();
      const loaded = await loadProject(id);
      await loadProjectAssets(loaded.doc);
      useEditor.getState().open(loaded.doc, loaded.issues);
      if (location.hash !== `#/project/${id}`) navigate({ name: 'project', id });
      if (loaded.migratedFrom !== undefined) toast('info', 'Project upgraded to the current format (a backup of the original was kept).');
      if (loaded.issues.length) toast('warning', `This project has ${loaded.issues.length} problem(s): ${loaded.issues[0]}`);
      return loaded.doc;
    } finally {
      opening = null;
      openingId = null;
    }
  })();
  return opening;
}

export async function closeProject() {
  await saveNow().catch(() => {});
  stopGame();
  useEditor.getState().close();
  releaseAssets();
}

export async function createAndOpenProject(name: string, template: TemplateId) {
  const doc = await createNewProject(name, template);
  return openProjectById(doc.id);
}

/** Finds a project by id or exact (case-insensitive) name. */
export async function resolveProjectId(ref: string): Promise<string> {
  const all = await listProjects();
  const byId = all.find((p) => p.id === ref);
  if (byId) return byId.id;
  const byName = all.filter((p) => p.name.toLowerCase() === ref.toLowerCase());
  if (byName.length > 1) throw new GameStudioError('E_AMBIGUOUS', `Several projects are called "${ref}": ${byName.map((p) => p.id).join(', ')}. Use the id.`);
  if (!byName.length) throw new GameStudioError('E_NOT_FOUND', `No project "${ref}". Use list_projects.`);
  return byName[0].id;
}

export function requireProject(): ProjectDoc {
  const p = useEditor.getState().project;
  if (!p) throw new GameStudioError('E_NO_PROJECT', 'No project is open. Use open_project or create_project.');
  return p;
}

/** The given scene, or the active scene tab, or the main scene. */
export function resolveScenePath(scene?: string | null): string {
  const project = requireProject();
  if (scene) {
    const clean = scene.replace(/^res:\/\//, '').replace(/^\/+/, '');
    if (!project.scenes[clean]) throw new GameStudioError('E_NOT_FOUND', `No scene "${scene}". Scenes: ${Object.keys(project.scenes).join(', ') || '(none)'}`);
    return clean;
  }
  const s = useEditor.getState();
  if (s.active?.kind === 'scene') return s.active.path;
  const main = project.settings.mainScene;
  if (main && project.scenes[main]) return main;
  const first = Object.keys(project.scenes)[0];
  if (!first) throw new GameStudioError('E_NO_SCENE', 'The project has no scenes yet. Use create_scene.');
  return first;
}

export async function runScene(scene?: string | null) {
  const project = requireProject();
  const path = scene ? resolveScenePath(scene) : (project.settings.mainScene ?? resolveScenePath());
  await startGame(project, path);
  return path;
}

/** Project checks plus a full compile of every script. */
export async function allDiagnostics(): Promise<Diagnostic[]> {
  const project = requireProject();
  const compiled = await compileProjectScripts(project.scripts);
  return [...compiled.diagnostics, ...projectDiagnostics(project)];
}

export async function exportWeb() {
  const project = requireProject();
  const result = await buildWebExport(project);
  const name = `${safeFileName(project.name)}-web.zip`;
  download(name, result.zip, 'application/zip');
  return { file: name, size: result.zip.length, modules: result.modules, files: result.files };
}

export async function exportArchiveFile() {
  const project = requireProject();
  await saveNow().catch(() => {});
  const bytes = await exportProjectArchive(project);
  const name = `${safeFileName(project.name)}.gsproj`;
  download(name, bytes, 'application/zip');
  return { file: name, size: bytes.length };
}

/** Restore a stored snapshot as an undoable change (backing up the current state first). */
export async function restoreDoc(doc: ProjectDoc, label: string) {
  const current = requireProject();
  await addBackup(current.id, `Before restoring “${label}”`, current);
  useEditor.getState().replace({ ...doc, id: current.id, updatedAt: Date.now() }, `Restore ${label}`);
}
