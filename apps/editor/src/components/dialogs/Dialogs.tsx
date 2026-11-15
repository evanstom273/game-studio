/** Editor dialogs: add node, new scene, project settings, export, backups, shortcuts, AI connection. */
import { useEffect, useMemo, useState } from 'react';
import { Download, Package, Search } from 'lucide-react';
import { errorMessage } from '@gs/shared';
import { findDocNode, nodeTypes, type InputBinding, type NodeCategory } from '@gs/core';
import type { ProjectSettings } from '@gs/project';
import { useEditor, activeScenePath } from '@editor/store/editor';
import { useUi } from '@editor/store/ui';
import { toast } from '@editor/store/toasts';
import { listBackups, readBackup } from '@editor/db/projects';
import { exportArchiveFile, exportWeb, restoreDoc } from '@editor/services/editor-service';
import { SHORTCUTS } from '@editor/lib/shortcuts';
import { Button, Dialog, Field, Kbd, Select, TextInput, cx } from '../ui/primitives';
import { NodeIcon } from '../ui/NodeIcon';
import { McpDialog } from './McpDialog';

export function Dialogs() {
  const dialog = useUi((s) => s.dialog);
  const close = () => useUi.getState().set({ dialog: null });
  switch (dialog) {
    case 'add-node':
      return <AddNodeDialog onClose={close} />;
    case 'new-scene':
      return <NewSceneDialog onClose={close} />;
    case 'settings':
      return <SettingsDialog onClose={close} />;
    case 'export':
      return <ExportDialog onClose={close} />;
    case 'backups':
      return <BackupsDialog onClose={close} />;
    case 'shortcuts':
      return <ShortcutsDialog onClose={close} />;
    case 'mcp':
      return <McpDialog onClose={close} />;
    default:
      return null;
  }
}

const CATEGORY_ORDER: NodeCategory[] = ['2D', 'Physics 2D', '3D', 'Physics 3D', 'Core', 'Utility', 'Audio'];

function AddNodeDialog({ onClose }: { onClose: () => void }) {
  const scenePath = useEditor(activeScenePath);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const scene = useEditor((s) => (scenePath ? s.project?.scenes[scenePath] : undefined));
  const selection = useEditor((s) => s.selection);
  const rootDim = scene ? nodeTypes.dimension(scene.root.type) : null;
  const types = useMemo(() => {
    const q = query.trim().toLowerCase();
    return nodeTypes
      .list()
      .filter((t) => !q || t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q))
      .sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category));
  }, [query]);
  if (!scenePath || !scene) return null;
  const parentId = selection.length ? selection[selection.length - 1] : scene.root.id;
  const parent = findDocNode(scene, parentId)?.node ?? scene.root;
  const add = (type: string) => {
    try {
      const r = useEditor.getState().dispatch([{ op: 'add_node', scene: scenePath, parent: parent.id, type }], { label: `Add ${type}` });
      useEditor.getState().select([r.results[0].id!]);
      onClose();
    } catch (e) {
      toast('error', errorMessage(e));
    }
  };
  const grouped = CATEGORY_ORDER.map((c) => [c, types.filter((t) => t.category === c)] as const).filter(([, list]) => list.length);
  const info = picked ? nodeTypes.get(picked) : null;
  return (
    <Dialog
      title={`Add node to ${parent.name}`}
      onClose={onClose}
      width={620}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!picked} onClick={() => picked && add(picked)} data-testid="add-node-confirm">
            Add
          </Button>
        </>
      }
    >
      <div className="relative mb-2">
        <Search size={13} className="pointer-events-none absolute left-2 top-2 text-faint" />
        <TextInput className="pl-7" placeholder="Search node types…" value={query} onChange={(e) => setQuery(e.target.value)} data-autofocus data-testid="node-search" onKeyDown={(e) => e.key === 'Enter' && types[0] && add(picked ?? types[0].name)} />
      </div>
      <div className="grid gap-3 sm:grid-cols-[1fr_200px]">
        <div className="max-h-[50dvh] overflow-auto rounded border border-border">
          {grouped.map(([cat, list]) => (
            <div key={cat}>
              <div className="sticky top-0 bg-panel-2 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
                {cat}
                {rootDim && ((rootDim === '2d' && /3D/.test(cat)) || (rootDim === '3d' && /2D/.test(cat))) ? ' · different from this scene' : ''}
              </div>
              {list.map((t) => (
                <button key={t.name} onClick={() => setPicked(t.name)} onDoubleClick={() => add(t.name)} className={cx('gs-row flex w-full items-center gap-2 px-2 py-1 text-left text-[12px]', picked === t.name ? 'bg-accent/20' : 'hover:bg-panel-2')} data-testid={`node-type-${t.name}`}>
                  <NodeIcon type={t.name} />
                  <span className="font-medium">{t.name}</span>
                  <span className="truncate text-[11px] text-faint">{t.description}</span>
                </button>
              ))}
            </div>
          ))}
          {!grouped.length && <div className="p-3 text-[12px] text-muted">No node types match.</div>}
        </div>
        <div className="hidden text-[12px] text-muted sm:block">
          {info ? (
            <>
              <div className="mb-1 flex items-center gap-1.5 text-[13px] font-semibold text-text">
                <NodeIcon type={info.name} /> {info.name}
              </div>
              <div className="mb-2 leading-snug">{info.description}</div>
              <div className="text-[11px] text-faint">Inherits: {nodeTypes.chain(info.name).slice(1).join(' → ') || '—'}</div>
            </>
          ) : (
            'Pick a type to see what it does. Double-click to add.'
          )}
        </div>
      </div>
    </Dialog>
  );
}

function NewSceneDialog({ onClose }: { onClose: () => void }) {
  const project = useEditor((s) => s.project!);
  const [name, setName] = useState('level');
  const [rootType, setRootType] = useState('Node2D');
  const [main, setMain] = useState(!project.settings.mainScene);
  const create = () => {
    const file = name.trim().replace(/\.scene$/, '').replace(/[^\w\-/]+/g, '_');
    const path = file.includes('/') ? `${file}.scene` : `scenes/${file}.scene`;
    try {
      const s = useEditor.getState();
      s.dispatch([{ op: 'create_scene', path, rootType }, ...(main ? [{ op: 'set_main_scene' as const, path }] : [])], { label: `New scene ${path}` });
      s.openDoc({ kind: 'scene', path });
      onClose();
    } catch (e) {
      toast('error', errorMessage(e));
    }
  };
  return (
    <Dialog title="New scene" onClose={onClose} width={440} footer={<Button variant="primary" onClick={create} data-testid="create-scene">Create</Button>}>
      <form onSubmit={(e) => (e.preventDefault(), create())}>
        <Field label="Name" hint="Saved as scenes/<name>.scene">
          <TextInput value={name} onChange={(e) => setName(e.target.value)} data-testid="scene-name" />
        </Field>
        <Field label="Root node">
          <Select value={rootType} onChange={(e) => setRootType(e.target.value)} data-testid="scene-root-type">
            {['Node2D', 'Node3D', 'Node', 'CharacterBody2D', 'CharacterBody3D', 'StaticBody2D', 'StaticBody3D', 'Area2D', 'Area3D', 'RigidBody2D', 'RigidBody3D'].map((t) => (
              <option key={t}>{t}</option>
            ))}
          </Select>
        </Field>
        <label className="flex items-center gap-2 text-[12px]">
          <input type="checkbox" className="accent-[var(--color-accent)]" checked={main} onChange={(e) => setMain(e.target.checked)} /> Make it the main scene
        </label>
      </form>
    </Dialog>
  );
}

function SettingsDialog({ onClose }: { onClose: () => void }) {
  const project = useEditor((s) => s.project!);
  const [s, setS] = useState<ProjectSettings>(structuredClone(project.settings));
  const [name, setName] = useState(project.name);
  const [newAction, setNewAction] = useState('');
  const save = () => {
    try {
      const st = useEditor.getState();
      st.dispatch([...(name.trim() !== project.name ? [{ op: 'rename_project' as const, name: name.trim() }] : []), { op: 'update_settings', patch: s as unknown as Record<string, unknown> }], { label: 'Project settings' });
      onClose();
    } catch (e) {
      toast('error', errorMessage(e));
    }
  };
  const d = s.display;
  const setD = (patch: Partial<ProjectSettings['display']>) => setS({ ...s, display: { ...d, ...patch } });
  const num = (v: string, fallback: number) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
  return (
    <Dialog title="Project settings" onClose={onClose} width={600} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} data-testid="save-settings">Save</Button></>}>
      <Field label="Name">
        <TextInput value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Main scene" hint="The scene exported games start with.">
        <Select value={s.mainScene ?? ''} onChange={(e) => setS({ ...s, mainScene: e.target.value || null })}>
          <option value="">(none)</option>
          {Object.keys(project.scenes).map((p) => (
            <option key={p}>{p}</option>
          ))}
        </Select>
      </Field>
      <div className="grid gap-x-3 sm:grid-cols-2">
        <Field label="Width (px)">
          <TextInput inputMode="numeric" value={d.width} onChange={(e) => setD({ width: num(e.target.value, d.width) })} />
        </Field>
        <Field label="Height (px)">
          <TextInput inputMode="numeric" value={d.height} onChange={(e) => setD({ height: num(e.target.value, d.height) })} />
        </Field>
        <Field label="Stretch" hint="How the game fills screens of other shapes.">
          <Select value={d.stretch} onChange={(e) => setD({ stretch: e.target.value as ProjectSettings['display']['stretch'] })}>
            <option value="fit">Fit (letterbox)</option>
            <option value="expand">Expand (show more world)</option>
            <option value="stretch">Stretch (distort)</option>
            <option value="none">None (1:1 pixels)</option>
          </Select>
        </Field>
        <Field label="Background">
          <TextInput value={d.background} onChange={(e) => setD({ background: e.target.value })} />
        </Field>
        <Field label="2D gravity (px/s²)">
          <TextInput inputMode="decimal" value={s.physics.gravity2d[1]} onChange={(e) => setS({ ...s, physics: { ...s.physics, gravity2d: [s.physics.gravity2d[0], num(e.target.value, s.physics.gravity2d[1])] } })} />
        </Field>
        <Field label="3D gravity (m/s²)">
          <TextInput inputMode="decimal" value={s.physics.gravity3d[1]} onChange={(e) => setS({ ...s, physics: { ...s.physics, gravity3d: [s.physics.gravity3d[0], num(e.target.value, s.physics.gravity3d[1]), s.physics.gravity3d[2]] } })} />
        </Field>
        <Field label="Touch controls" hint="On-screen stick and buttons in the game.">
          <Select value={s.input.touchControls} onChange={(e) => setS({ ...s, input: { ...s.input, touchControls: e.target.value as ProjectSettings['input']['touchControls'] } })}>
            <option value="auto">On touch screens</option>
            <option value="always">Always</option>
            <option value="off">Off</option>
          </Select>
        </Field>
        <label className="mb-3 flex items-center gap-2 self-end text-[12px]">
          <input type="checkbox" className="accent-[var(--color-accent)]" checked={d.pixelArt} onChange={(e) => setD({ pixelArt: e.target.checked })} /> Pixel art (sharp textures)
        </label>
      </div>
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">Input actions</div>
      <div className="mb-1 text-[11px] text-muted">The ui_left / ui_right / ui_up / ui_down / ui_accept / ui_cancel actions always exist (arrows, WASD, Space, gamepad). Add your own here.</div>
      {Object.entries(s.input.actions).map(([action, bindings]) => (
        <div key={action} className="mb-1 flex items-center gap-2 text-[12px]">
          <span className="w-28 truncate font-mono">{action}</span>
          <TextInput
            value={bindings.filter((b): b is Extract<InputBinding, { type: 'key' }> => b.type === 'key').map((b) => b.code).join(', ')}
            onChange={(e) => setS({ ...s, input: { ...s.input, actions: { ...s.input.actions, [action]: e.target.value.split(',').map((c) => c.trim()).filter(Boolean).map((code) => ({ type: 'key' as const, code })) } } })}
            placeholder="Key codes, e.g. Space, KeyJ"
          />
          <Button
            variant="ghost"
            onClick={() => {
              const next = { ...s.input.actions };
              delete next[action];
              setS({ ...s, input: { ...s.input, actions: next } });
            }}
          >
            Remove
          </Button>
        </div>
      ))}
      <form
        className="mt-1 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const n = newAction.trim();
          if (!/^[A-Za-z_]\w*$/.test(n)) return toast('error', 'Action names use letters, digits and _');
          setS({ ...s, input: { ...s.input, actions: { ...s.input.actions, [n]: [] } } });
          setNewAction('');
        }}
      >
        <TextInput placeholder="New action, e.g. jump" value={newAction} onChange={(e) => setNewAction(e.target.value)} />
        <Button type="submit">Add</Button>
      </form>
    </Dialog>
  );
}

function ExportDialog({ onClose }: { onClose: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const run = async (kind: 'web' | 'archive') => {
    setBusy(kind);
    setResult(null);
    try {
      if (kind === 'web') {
        const r = await exportWeb();
        setResult(`Downloaded ${r.file} (${(r.size / 1024 / 1024).toFixed(2)} MB) · runtime modules: core${r.modules.length ? ', ' + r.modules.join(', ') : ''}`);
      } else {
        const r = await exportArchiveFile();
        setResult(`Downloaded ${r.file} (${(r.size / 1024 / 1024).toFixed(2)} MB)`);
      }
    } catch (e) {
      toast('error', errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Dialog title="Export" onClose={onClose} width={520}>
      <div className="space-y-2">
        <button className="flex w-full items-start gap-3 rounded-md border border-border bg-panel-2 p-3 text-left hover:border-border-strong disabled:opacity-50" disabled={!!busy} onClick={() => void run('web')} data-testid="export-web">
          <Download size={18} className="mt-0.5 text-accent" />
          <div>
            <div className="text-[13px] font-semibold">{busy === 'web' ? 'Building…' : 'Web game (.zip)'}</div>
            <div className="text-[12px] text-muted">A standalone playable build: upload it to itch.io, Cloudflare, GitHub Pages or any static host. Includes only the engine modules your game uses.</div>
          </div>
        </button>
        <button className="flex w-full items-start gap-3 rounded-md border border-border bg-panel-2 p-3 text-left hover:border-border-strong disabled:opacity-50" disabled={!!busy} onClick={() => void run('archive')} data-testid="export-archive">
          <Package size={18} className="mt-0.5 text-accent" />
          <div>
            <div className="text-[13px] font-semibold">{busy === 'archive' ? 'Packing…' : 'Project archive (.gsproj)'}</div>
            <div className="text-[12px] text-muted">The whole project, to back it up or open it in Game Studio on another device.</div>
          </div>
        </button>
        <div className="rounded-md border border-dashed border-border p-3 text-[12px] text-muted">Desktop (Windows, macOS, Linux) and mobile app exports are planned (Tauri 2); they are not available yet.</div>
        {result && (
          <div className="text-[12px] text-ok" data-testid="export-result">
            {result}
          </div>
        )}
      </div>
    </Dialog>
  );
}

function BackupsDialog({ onClose }: { onClose: () => void }) {
  const id = useEditor((s) => s.project!.id);
  const [list, setList] = useState<{ id: number; at: number; label: string }[] | null>(null);
  useEffect(() => void listBackups(id).then(setList), [id]);
  return (
    <Dialog title="Backups" onClose={onClose} width={520}>
      <p className="mb-2 text-[12px] text-muted">Taken automatically before format upgrades and restores. Restoring is undoable.</p>
      {list === null ? (
        <div className="text-muted">Loading…</div>
      ) : list.length === 0 ? (
        <div className="text-[12px] text-faint">No backups yet.</div>
      ) : (
        list.map((b) => (
          <div key={b.id} className="flex items-center gap-2 border-b border-border/60 py-1.5 text-[12px]">
            <span className="flex-1">{b.label}</span>
            <span className="text-faint">{new Date(b.at).toLocaleString()}</span>
            <Button
              onClick={async () => {
                try {
                  await restoreDoc(await readBackup(b.id), b.label);
                  onClose();
                } catch (e) {
                  toast('error', errorMessage(e));
                }
              }}
            >
              Restore
            </Button>
          </div>
        ))
      )}
    </Dialog>
  );
}

function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose} width={440}>
      {SHORTCUTS.map(([k, v]) => (
        <div key={k} className="flex items-center justify-between border-b border-border/50 py-1.5 text-[12px]">
          <span>{v}</span>
          <Kbd>{k}</Kbd>
        </div>
      ))}
    </Dialog>
  );
}
