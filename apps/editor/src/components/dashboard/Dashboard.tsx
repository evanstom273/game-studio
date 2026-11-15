/** The project manager: create, open, import, duplicate, rename, export and delete projects. */
import { useCallback, useEffect, useState } from 'react';
import { Bot, Box, Copy, Download, FolderOpen, Gamepad2, MoreHorizontal, Pencil, Plus, Shapes, Trash2, Upload } from 'lucide-react';
import { TEMPLATES, type TemplateId } from '@gs/project';
import { deleteProject, duplicateProject, exportProjectArchive, importProjectArchive, listProjects, loadProject, renameStoredProject, type ProjectListItem } from '@editor/db/projects';
import { storageEstimate } from '@editor/db/db';
import { navigate } from '@editor/lib/router';
import { download, pickFiles, safeFileName } from '@editor/lib/files';
import { toast } from '@editor/store/toasts';
import { useBridge } from '@editor/bridge/client';
import { createAndOpenProject } from '@editor/services/editor-service';
import { Button, Dialog, Field, IconButton, TextInput, cx, formatBytes } from '../ui/primitives';
import { confirmDialog } from '../ui/feedback';
import { McpDialog } from '../dialogs/McpDialog';

function ago(t: number) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}

const KIND_STYLE: Record<ProjectListItem['kind'], string> = {
  '2D': 'bg-node-2d/15 text-node-2d',
  '3D': 'bg-node-3d/15 text-node-3d',
  Mixed: 'bg-accent/15 text-accent',
  Empty: 'bg-panel-3 text-muted',
};

export function Dashboard() {
  const [projects, setProjects] = useState<ProjectListItem[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(null);
  const bridge = useBridge((s) => s.status);
  const refresh = useCallback(() => {
    void listProjects().then(setProjects);
    void storageEstimate().then(setUsage);
  }, []);
  useEffect(() => {
    document.title = 'Game Studio';
    refresh();
  }, [refresh]);

  const importArchive = async () => {
    const [file] = await pickFiles('.gsproj,.zip,application/zip');
    if (!file) return;
    try {
      const { doc, issues } = await importProjectArchive(new Uint8Array(await file.arrayBuffer()));
      toast(issues.length ? 'warning' : 'success', issues.length ? `Imported “${doc.name}” with ${issues.length} problem(s): ${issues[0]}` : `Imported “${doc.name}”`);
      refresh();
    } catch (e) {
      toast('error', e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="safe-top safe-x flex h-12 shrink-0 items-center gap-3 border-b border-border bg-panel px-4">
        <Gamepad2 size={20} className="text-accent" />
        <span className="text-[15px] font-semibold">Game Studio</span>
        <span className="hidden text-[12px] text-muted sm:inline">2D and 3D games, made anywhere</span>
        <div className="flex-1" />
        <Button variant="ghost" onClick={() => setMcpOpen(true)} data-testid="open-mcp">
          <Bot size={15} className={bridge === 'connected' ? 'text-ok' : undefined} /> <span className="hidden sm:inline">AI connection</span>
        </Button>
      </header>
      <main className="flex-1 overflow-auto">
        <div className="safe-x mx-auto max-w-5xl px-4 py-5 sm:px-6">
          <div className="mb-5 flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={() => setCreating(true)} data-testid="new-project">
              <Plus size={14} /> New project
            </Button>
            <Button onClick={importArchive} data-testid="import-project">
              <Upload size={14} /> Import .gsproj
            </Button>
            <span className="ml-1 text-[12px] text-muted">
              Projects are stored in this browser{usage ? ` · ${formatBytes(usage.usage)} used` : ''}. Export a .gsproj to move one to another device.
            </span>
          </div>
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">Projects</h2>
          {projects === null ? (
            <div className="text-muted">Loading…</div>
          ) : projects.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-8 text-center">
              <Shapes size={28} className="mx-auto mb-2 text-faint" />
              <div className="mb-1 font-medium">No projects yet</div>
              <div className="mb-4 text-[12px] text-muted">Start from a template — the 2D platformer and 3D starter are playable straight away.</div>
              <Button variant="primary" onClick={() => setCreating(true)}>
                <Plus size={14} /> New project
              </Button>
            </div>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3" data-testid="project-list">
              {projects.map((p) => (
                <ProjectCard key={p.id} project={p} onChanged={refresh} />
              ))}
            </ul>
          )}
        </div>
      </main>
      {creating && <NewProjectDialog onClose={() => setCreating(false)} />}
      {mcpOpen && <McpDialog onClose={() => setMcpOpen(false)} />}
    </div>
  );
}

function ProjectCard({ project: p, onChanged }: { project: ProjectListItem; onChanged: () => void }) {
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const run = (fn: () => Promise<unknown>) => async () => {
    setMenu(false);
    try {
      await fn();
      onChanged();
    } catch (e) {
      toast('error', e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <li className="group relative rounded-lg border border-border bg-panel transition-colors hover:border-border-strong" data-testid="project-card">
      <button className="flex w-full items-start gap-3 p-3 text-left" onClick={() => navigate({ name: 'project', id: p.id })}>
        <div className={cx('flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-[12px] font-bold', KIND_STYLE[p.kind])}>{p.kind === 'Empty' ? <Box size={16} /> : p.kind}</div>
        <div className="min-w-0 flex-1">
          <div className="truncate pr-8 text-[13px] font-semibold">{p.name}</div>
          <div className="mt-0.5 text-[11px] text-muted">
            {p.scenes} scene{p.scenes === 1 ? '' : 's'} · {p.scripts} script{p.scripts === 1 ? '' : 's'} · {p.assets} asset{p.assets === 1 ? '' : 's'}
          </div>
          <div className="mt-0.5 text-[11px] text-faint">Edited {ago(p.updatedAt)}</div>
        </div>
      </button>
      <IconButton label="Project actions" className="absolute right-1.5 top-1.5" onClick={() => setMenu((m) => !m)} data-testid="project-menu">
        <MoreHorizontal size={15} />
      </IconButton>
      {menu && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setMenu(false)} />
          <div className="absolute right-1.5 top-9 z-40 w-44 overflow-hidden rounded-md border border-border bg-panel-2 py-1 shadow-xl" role="menu">
            <MenuItem icon={FolderOpen} label="Open" onClick={() => navigate({ name: 'project', id: p.id })} />
            <MenuItem icon={Pencil} label="Rename" onClick={() => (setMenu(false), setRenaming(true))} />
            <MenuItem icon={Copy} label="Duplicate" onClick={run(() => duplicateProject(p.id))} />
            <MenuItem
              icon={Download}
              label="Export .gsproj"
              onClick={run(async () => {
                const { doc } = await loadProject(p.id);
                download(`${safeFileName(doc.name)}.gsproj`, await exportProjectArchive(doc), 'application/zip');
              })}
            />
            <MenuItem
              icon={Trash2}
              label="Delete"
              danger
              onClick={run(async () => {
                if (await confirmDialog({ title: 'Delete project?', message: `“${p.name}” and all its files will be deleted from this browser. This can't be undone — export it first if you might want it back.`, confirm: 'Delete', danger: true })) await deleteProject(p.id);
              })}
            />
          </div>
        </>
      )}
      {renaming && <RenameDialog name={p.name} onClose={() => setRenaming(false)} onSave={(name) => void run(() => renameStoredProject(p.id, name))().then(() => setRenaming(false))} />}
    </li>
  );
}

function MenuItem({ icon: Icon, label, onClick, danger }: { icon: typeof Plus; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button role="menuitem" className={cx('touch-target flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-panel-3', danger && 'text-err')} onClick={onClick}>
      <Icon size={14} /> {label}
    </button>
  );
}

function RenameDialog({ name, onClose, onSave }: { name: string; onClose: () => void; onSave: (n: string) => void }) {
  const [value, setValue] = useState(name);
  return (
    <Dialog title="Rename project" onClose={onClose} width={400} footer={<Button variant="primary" onClick={() => onSave(value)} disabled={!value.trim()}>Rename</Button>}>
      <form onSubmit={(e) => (e.preventDefault(), value.trim() && onSave(value))}>
        <Field label="Name">
          <TextInput value={value} onChange={(e) => setValue(e.target.value)} maxLength={100} />
        </Field>
      </form>
    </Dialog>
  );
}

function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('My game');
  const [template, setTemplate] = useState<TemplateId>('2d-platformer');
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      await createAndOpenProject(name, template);
    } catch (e) {
      toast('error', e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="New project"
      onClose={onClose}
      width={560}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={create} disabled={busy || !name.trim()} data-testid="create-project">
            {busy ? 'Creating…' : 'Create'}
          </Button>
        </>
      }
    >
      <form onSubmit={(e) => (e.preventDefault(), void create())}>
        <Field label="Name">
          <TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={100} data-testid="project-name" />
        </Field>
        <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">Template</span>
        <div className="grid gap-2 sm:grid-cols-2">
          {TEMPLATES.map((t) => (
            <button
              type="button"
              key={t.id}
              onClick={() => setTemplate(t.id)}
              aria-pressed={template === t.id}
              data-testid={`template-${t.id}`}
              className={cx('rounded-md border p-3 text-left transition-colors', template === t.id ? 'border-accent bg-accent/10' : 'border-border bg-panel-2 hover:border-border-strong')}
            >
              <div className="text-[13px] font-semibold">{t.name}</div>
              <div className="mt-0.5 text-[11px] leading-snug text-muted">{t.description}</div>
            </button>
          ))}
        </div>
      </form>
    </Dialog>
  );
}
