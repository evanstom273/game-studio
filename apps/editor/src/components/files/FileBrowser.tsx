/**
 * Project files: scenes, scripts and assets in one folder tree. Open, import (button or drop),
 * rename, delete, make main scene, instance a scene, or drop an image/model into the scene.
 */
import { useMemo, useState } from 'react';
import { Box, ChevronDown, ChevronRight, Clapperboard, FileAudio, FileCode2, FileType, Folder, Image as ImageIcon, MoreHorizontal, Plus, Star, Upload, Workflow } from 'lucide-react';
import { basename, errorMessage, extname } from '@gs/shared';
import { findDocNode, nodeTypes } from '@gs/core';
import { scriptTemplate } from '@gs/scripting';
import { ENGINE_EXPORTS, classNameFor, isVisualScriptPath, newVisualScript, serializeVisualScript } from '@gs/visual';
import { useEditor } from '@editor/store/editor';
import { useUi } from '@editor/store/ui';
import { toast } from '@editor/store/toasts';
import { pickFiles } from '@editor/lib/files';
import { IMPORT_ACCEPT, assetUrl, importFiles } from '@editor/services/assets';
import { IconButton, SectionHeader, cx, formatBytes } from '../ui/primitives';
import { confirmDialog } from '../ui/feedback';

type Entry = { path: string; kind: 'scene' | 'script' | 'asset'; assetKind?: string; size?: number };
interface Dir {
  name: string;
  path: string;
  dirs: Map<string, Dir>;
  files: Entry[];
}

function buildTree(entries: Entry[]): Dir {
  const root: Dir = { name: '', path: '', dirs: new Map(), files: [] };
  for (const e of entries) {
    const parts = e.path.split('/');
    let d = root;
    for (const part of parts.slice(0, -1)) {
      let next = d.dirs.get(part);
      if (!next) d.dirs.set(part, (next = { name: part, path: d.path ? `${d.path}/${part}` : part, dirs: new Map(), files: [] }));
      d = next;
    }
    d.files.push(e);
  }
  return root;
}

function FileIcon({ e }: { e: Entry }) {
  if (e.kind === 'scene') return <Clapperboard size={14} className="shrink-0 text-accent" />;
  if (e.kind === 'script' && isVisualScriptPath(e.path)) return <Workflow size={14} className="shrink-0 text-node-physics" aria-label="Visual script" />;
  if (e.kind === 'script') return <FileCode2 size={14} className="shrink-0 text-node-audio" />;
  if (e.assetKind === 'image') return <ImageIcon size={14} className="shrink-0 text-node-2d" />;
  if (e.assetKind === 'audio') return <FileAudio size={14} className="shrink-0 text-node-audio" />;
  if (e.assetKind === 'model') return <Box size={14} className="shrink-0 text-node-3d" />;
  return <FileType size={14} className="shrink-0 text-muted" />;
}

export function FileBrowser() {
  const project = useEditor((s) => s.project!);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const entries = useMemo<Entry[]>(
    () => [
      ...Object.keys(project.scenes).map((path) => ({ path, kind: 'scene' as const })),
      ...Object.keys(project.scripts).map((path) => ({ path, kind: 'script' as const })),
      ...Object.values(project.assets).map((a) => ({ path: a.path, kind: 'asset' as const, assetKind: a.kind, size: a.size })),
    ].sort((a, b) => a.path.localeCompare(b.path)),
    [project.scenes, project.scripts, project.assets],
  );
  const tree = useMemo(() => buildTree(entries), [entries]);
  const s = useEditor.getState();
  const run = (fn: () => void) => {
    setMenu(null);
    try {
      fn();
    } catch (e) {
      toast('error', errorMessage(e));
    }
  };
  const doImport = async (files: File[]) => {
    if (!files.length) return;
    const r = await importFiles(files);
    for (const err of r.errors) toast('error', err);
    if (r.imported.length) toast('success', `Imported ${r.imported.length} file${r.imported.length === 1 ? '' : 's'}`);
  };
  const open = (e: Entry) => {
    if (e.kind === 'scene' || e.kind === 'script') s.openDoc({ kind: e.kind, path: e.path });
  };
  const activeScene = s.active?.kind === 'scene' ? s.active.path : null;

  const actions = (e: Entry) => {
    const list: [string, () => void][] = [];
    if (e.kind === 'scene') {
      list.push(['Open', () => open(e)]);
      if (project.settings.mainScene !== e.path) list.push(['Set as main scene', () => s.dispatch([{ op: 'set_main_scene', path: e.path }], { label: 'Set main scene' })]);
      if (activeScene && activeScene !== e.path) list.push([`Instance in ${basename(activeScene)}`, () => s.dispatch([{ op: 'add_node', scene: activeScene, instance: e.path }], { label: `Instance ${basename(e.path)}` })]);
      list.push(['Duplicate', () => s.dispatch([{ op: 'duplicate_scene', from: e.path, to: e.path.replace(/\.scene$/, '_copy.scene') }])]);
    }
    if (e.kind === 'script') list.push(['Open', () => open(e)]);
    if (e.kind === 'asset' && activeScene) {
      const root = project.scenes[activeScene].root.type;
      const dim = nodeTypes.dimension(root);
      if (e.assetKind === 'image' && dim !== '3d') list.push(['Add to scene as Sprite2D', () => s.dispatch([{ op: 'add_node', scene: activeScene, type: 'Sprite2D', name: basename(e.path).replace(/\.\w+$/, '').replace(/[^\w-]/g, '_') || 'Sprite2D', props: { texture: e.path } }])]);
      if (e.assetKind === 'model') list.push(['Add to scene as MeshInstance3D', () => s.dispatch([{ op: 'add_node', scene: activeScene, type: 'MeshInstance3D', name: basename(e.path).replace(/\.\w+$/, '').replace(/[^\w-]/g, '_') || 'Model', props: { mesh: { type: 'model', path: e.path }, material: null } }])]);
      if (e.assetKind === 'audio') list.push(['Add to scene as AudioStreamPlayer', () => s.dispatch([{ op: 'add_node', scene: activeScene, type: 'AudioStreamPlayer', props: { stream: e.path } }])]);
    }
    list.push([
      'Rename / move…',
      () => {
        const to = prompt('New path', e.path);
        if (to && to !== e.path) run(() => s.dispatch([{ op: 'rename_path', from: e.path, to }], { label: `Rename ${basename(e.path)}` }));
      },
    ]);
    list.push([
      'Delete',
      () =>
        void confirmDialog({ title: `Delete ${basename(e.path)}?`, message: e.kind === 'scene' ? 'The scene file will be deleted. You can undo this.' : e.kind === 'script' ? 'Nodes using it will lose their script. You can undo this.' : 'Nodes using it will lose the reference. You can undo this.', confirm: 'Delete', danger: true }).then(
          (ok) => ok && run(() => s.dispatch([{ op: e.kind === 'scene' ? 'delete_scene' : e.kind === 'script' ? 'delete_script' : 'delete_asset', path: e.path } as never], { label: `Delete ${basename(e.path)}` })),
        ),
    ]);
    return list;
  };

  const renderDir = (d: Dir, depth: number): React.ReactNode => (
    <>
      {[...d.dirs.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((sub) => {
          const closed = collapsed.has(sub.path);
          return (
            <div key={sub.path}>
              <button
                className="gs-row flex h-7 w-full items-center gap-1 pr-2 text-left text-[12px] text-muted hover:bg-panel-2 hover:text-text"
                style={{ paddingLeft: 6 + depth * 14 }}
                onClick={() => {
                  const next = new Set(collapsed);
                  if (closed) next.delete(sub.path);
                  else next.add(sub.path);
                  setCollapsed(next);
                }}
              >
                {closed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                <Folder size={14} className="shrink-0" /> {sub.name}
              </button>
              {!closed && renderDir(sub, depth + 1)}
            </div>
          );
        })}
      {d.files.map((e) => {
        const isActive = s.active?.path === e.path;
        return (
          <div key={e.path} className={cx('gs-row group relative flex h-7 items-center gap-1.5 pr-1 text-[12px]', isActive ? 'bg-accent/15' : 'hover:bg-panel-2')} style={{ paddingLeft: 22 + depth * 14 }} data-testid="file-row" data-path={e.path}>
            <button className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => open(e)} onDoubleClick={() => open(e)} draggable={e.kind === 'scene' || e.assetKind === 'image'} onDragStart={(ev) => ev.dataTransfer.setData('text/gs-file', e.path)}>
              <FileIcon e={e} />
              <span className="truncate">{basename(e.path)}</span>
              {project.settings.mainScene === e.path && <Star size={11} className="shrink-0 text-warn" aria-label="Main scene" />}
              {e.assetKind === 'image' && <Thumb path={e.path} />}
            </button>
            {e.size !== undefined && <span className="shrink-0 text-[10px] text-faint">{formatBytes(e.size)}</span>}
            <IconButton label={`Actions for ${basename(e.path)}`} className="h-6 min-w-6 opacity-70 group-hover:opacity-100" onClick={() => setMenu(menu === e.path ? null : e.path)}>
              <MoreHorizontal size={13} />
            </IconButton>
            {menu === e.path && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setMenu(null)} />
                <div className="absolute right-1 top-7 z-40 w-56 overflow-hidden rounded-md border border-border bg-panel-2 py-1 shadow-xl" role="menu">
                  {actions(e).map(([label, fn]) => (
                    <button key={label} role="menuitem" className={cx('touch-target flex w-full px-3 py-1.5 text-left text-[12px] hover:bg-panel-3', label === 'Delete' && 'text-err')} onClick={() => run(fn)}>
                      {label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        );
      })}
    </>
  );

  return (
    <div
      className={cx('flex h-full flex-col', dragOver && 'outline-2 -outline-offset-2 outline-dashed outline-accent')}
      data-testid="file-browser"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragOver(false);
        void doImport([...e.dataTransfer.files]);
      }}
    >
      <SectionHeader
        right={
          <>
            <IconButton label="New visual script" className="h-6 min-w-6" onClick={() => newVisualScriptFile()} data-testid="files-new-visual-script">
              <Workflow size={13} />
            </IconButton>
            <IconButton label="New script" className="h-6 min-w-6" onClick={() => newScript()} data-testid="files-new-script">
              <FileCode2 size={13} />
            </IconButton>
            <IconButton label="New scene" className="h-6 min-w-6" onClick={() => useUi.getState().set({ dialog: 'new-scene' })} data-testid="files-new-scene">
              <Plus size={14} />
            </IconButton>
            <IconButton label="Import files" className="h-6 min-w-6" onClick={async () => doImport(await pickFiles(IMPORT_ACCEPT, true))} data-testid="import-files">
              <Upload size={13} />
            </IconButton>
          </>
        }
      >
        Files
      </SectionHeader>
      <div className="min-h-0 flex-1 overflow-auto py-1">{renderDir(tree, 0)}</div>
      <div className="shrink-0 border-t border-border px-2 py-1 text-[10px] text-faint">Drop images, sounds, models or fonts here to import them.</div>
    </div>
  );
}

function newScript() {
  const s = useEditor.getState();
  const name = prompt('Script file name', 'scripts/new_script.ts');
  if (!name) return;
  const path = extname(name) ? name : `${name}.ts`;
  const className = basename(path).replace(/\.\w+$/, '').replace(/(^|[_\-\s]+)(\w)/g, (_m, _a, c: string) => c.toUpperCase()).replace(/[^A-Za-z0-9]/g, '') || 'Script';
  try {
    s.dispatch([{ op: 'write_script', path, source: scriptTemplate('Node2D', /^[A-Za-z]/.test(className) ? className : `S${className}`) }], { label: `New ${path}` });
    s.openDoc({ kind: 'script', path });
  } catch (e) {
    toast('error', errorMessage(e));
  }
}

/**
 * A new visual script (.vgraph). It extends the selected node's type (or the open scene's kind of
 * root: Node2D / Node3D), which can be changed later in the graph editor's script panel.
 */
/** Creates a visual script (and attaches it to the selected node if that node has no script yet). */
export function newVisualScriptFile() {
  const s = useEditor.getState();
  const name = prompt('Visual script file name', 'scripts/new_visual_script.vgraph');
  if (!name) return;
  const path = (extname(name) ? name.replace(/\.[^./]+$/, '') : name) + '.vgraph';
  const scene = s.active?.kind === 'scene' ? s.project?.scenes[s.active.path] : undefined;
  const selected = scene && s.selection.length ? findDocNode(scene, s.selection[s.selection.length - 1])?.node : undefined;
  const base = selected?.type ?? (scene && nodeTypes.dimension(scene.root.type) === '3d' ? 'Node3D' : 'Node2D');
  let className = classNameFor(path);
  if (!/^[A-Z]/.test(className)) className = `S${className}`;
  if (ENGINE_EXPORTS.has(className)) className = `My${className}`;
  try {
    const attach = scene && s.active?.kind === 'scene' && selected && !selected.script ? [{ op: 'attach_script' as const, scene: s.active.path, node: selected.id, script: path }] : [];
    s.dispatch([{ op: 'write_script', path, source: serializeVisualScript(newVisualScript(className, base)) }, ...attach], { label: `New ${path}` });
    s.openDoc({ kind: 'script', path });
  } catch (e) {
    toast('error', errorMessage(e));
  }
}

function Thumb({ path }: { path: string }) {
  const url = assetUrl(path);
  return url ? <img src={url} alt="" className="checker ml-auto h-5 w-5 shrink-0 rounded-sm object-contain" style={{ imageRendering: 'pixelated' }} /> : null;
}
