/**
 * Changes since the last commit or pull: commit & push (optionally to a new branch, then a pull
 * request), conflicts left by the last pull, missing files, and per-file diff / open / discard.
 */
import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, ExternalLink, FileCode2, FileJson, GitPullRequest, Image, Undo2 } from 'lucide-react';
import { repoFileRole, type GitLink } from '@gs/project';
import { githubCall, status, type Change } from '@gs/git';
import { useEditor } from '@editor/store/editor';
import { useUi } from '@editor/store/ui';
import { toast } from '@editor/store/toasts';
import { github } from '@editor/git/api';
import { commitOpen, revertOpen } from '@editor/git/ops';
import { useGitConflicts } from '@editor/git/store';
import { Button, TextInput, cx, inputCls } from '../ui/primitives';
import { confirmDialog } from '../ui/feedback';
import { Banner, SectionLabel, linkCls, useBusy } from './common';
import { DiffView } from './DiffView';

export function FileIcon({ path }: { path: string }) {
  const role = repoFileRole(path);
  if (role === 'asset') return <Image size={13} className="shrink-0 text-node-audio" />;
  if (role === 'script') return <FileCode2 size={13} className="shrink-0 text-accent" />;
  return <FileJson size={13} className={cx('shrink-0', role === 'scene' ? 'text-node-2d' : 'text-muted')} />;
}

/** Open a project file in the editor (scenes and scripts). */
export function openInEditor(path: string) {
  const s = useEditor.getState();
  if (s.project?.scenes[path]) s.openDoc({ kind: 'scene', path });
  else if (s.project?.scripts[path] !== undefined) s.openDoc({ kind: 'script', path });
  else return false;
  useUi.getState().set({ dialog: null, sheet: null });
  return true;
}

const STATUS_COLOR = { added: 'text-ok', deleted: 'text-err', modified: 'text-warn' } as const;

export function ChangesTab({ link }: { link: GitLink }) {
  const project = useEditor((s) => s.project)!;
  const changes = useMemo(() => status(project), [project]);
  const conflicts = useGitConflicts((s) => (s.projectId === project.id ? s.conflicts : []));
  const { busy, run } = useBusy();
  const [msg, setMsg] = useState('');
  const [toBranch, setToBranch] = useState(false);
  const [branchName, setBranchName] = useState('');
  const [pr, setPr] = useState<{ branch: string; url?: string } | null>(null);
  const [mass, setMass] = useState<{ count: number; message: string } | null>(null);
  const [typed, setTyped] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const missing = changes.filter((c) => c.status === 'deleted');

  const commit = (confirmDeletions?: number) =>
    run('commit', async () => {
      const opts = { ...(toBranch ? { newBranch: branchName.trim() } : {}), ...(confirmDeletions !== undefined ? { confirmDeletions } : {}) };
      try {
        const r = await commitOpen(msg, opts);
        toast('success', r.files ? `Pushed ${r.files} file(s) to ${r.branch}` : 'Up to date with GitHub');
        setMsg('');
        setMass(null);
        setTyped('');
        if (toBranch) setPr({ branch: r.branch });
        setToBranch(false);
        setBranchName('');
      } catch (e) {
        const d = (e as { code?: string; details?: { deletions?: number } }).code === 'E_MASS_DELETE' ? (e as { details: { deletions: number } }).details.deletions : undefined;
        if (d === undefined) throw e;
        setMass({ count: d, message: (e as Error).message });
      }
    });

  return (
    <div className="min-h-0 flex-1 overflow-auto pb-3 text-[12px]" data-testid="git-changes">
      {missing.length >= 10 && (
        <Banner tone="err" testId="git-missing">
          <div className="font-medium">{missing.length} project files are missing compared with GitHub</div>
          <div className="mt-0.5 text-muted">If you didn't delete them, the project didn't load completely. Don't commit: that would delete them from the repository.</div>
          <Button className="mt-1.5" variant="danger" disabled={!!busy} onClick={() => run('restore', async () => void (await revertOpen(missing.map((c) => c.path))))} data-testid="git-restore-missing">
            {busy === 'restore' ? 'Restoring…' : 'Restore them from GitHub'}
          </Button>
        </Banner>
      )}
      {conflicts.length > 0 && (
        <Banner tone="warn" testId="git-conflicts">
          <div className="mb-1 font-medium">Changed here and on GitHub</div>
          {conflicts.map((c) => (
            <div key={c.path} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 py-0.5">
              <FileIcon path={c.path} />
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">{c.path}</span>
              <span className="w-full text-[11px] text-muted sm:w-auto">{c.reason ?? c.kind}</span>
              <button
                className={linkCls}
                disabled={!!busy}
                onClick={() =>
                  run('theirs', async () => {
                    await revertOpen([c.path]);
                    useGitConflicts.getState().drop(c.path);
                  })
                }
                data-testid="conflict-theirs"
              >
                Use GitHub's
              </button>
              <button className="text-muted hover:text-text" onClick={() => useGitConflicts.getState().drop(c.path)} data-testid="conflict-mine">
                Keep mine
              </button>
            </div>
          ))}
        </Banner>
      )}
      <div className="space-y-1.5 border-b border-border p-3">
        <textarea className={cx(inputCls, 'h-16 resize-none py-1.5')} placeholder="Commit message" value={msg} onChange={(e) => setMsg(e.target.value)} data-testid="commit-message" aria-label="Commit message" />
        <label className="flex items-center gap-1.5 text-muted">
          <input type="checkbox" className="accent-[var(--color-accent)]" checked={toBranch} onChange={(e) => setToBranch(e.target.checked)} data-testid="commit-new-branch" /> Commit to a new branch
        </label>
        {toBranch && <TextInput placeholder="branch-name" value={branchName} onChange={(e) => setBranchName(e.target.value)} data-testid="commit-branch-name" aria-label="New branch name" />}
        {mass && (
          <div className="space-y-1 rounded border border-err/40 bg-err/10 p-2" data-testid="mass-delete">
            <div>{mass.message}</div>
            <div className="flex gap-2">
              <TextInput placeholder={`Type ${mass.count}`} value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Number of deletions" />
              <Button variant="danger" disabled={typed.trim() !== String(mass.count) || !!busy} onClick={() => void commit(mass.count)}>
                Delete {mass.count} files
              </Button>
            </div>
          </div>
        )}
        <Button variant="primary" className="w-full" disabled={!changes.length || !msg.trim() || (toBranch && !branchName.trim()) || !!busy} onClick={() => void commit()} data-testid="commit-push">
          {busy === 'commit' ? 'Pushing…' : `Commit & push ${changes.length} change${changes.length === 1 ? '' : 's'}`}
        </Button>
        {pr && !pr.url && (
          <Button
            className="w-full"
            disabled={!!busy}
            data-testid="create-pr"
            onClick={() =>
              run('pr', async () => {
                const r = (await githubCall('git_create_pr', github(), { head: pr.branch }, link)) as { number: number; url: string };
                setPr({ ...pr, url: r.url });
                toast('success', `Pull request #${r.number} opened`);
              })
            }
          >
            <GitPullRequest size={13} /> Open a pull request for {pr.branch}
          </Button>
        )}
        {pr?.url && (
          <a className={cx(linkCls, 'flex items-center gap-1')} href={pr.url} target="_blank" rel="noreferrer" data-testid="pr-link">
            <ExternalLink size={12} /> Pull request opened — view on GitHub
          </a>
        )}
      </div>
      <SectionLabel>Changes ({changes.length})</SectionLabel>
      {!changes.length && <div className="px-3 text-muted">No changes since the last commit or pull.</div>}
      {changes.map((c) => (
        <ChangeRow key={c.path} change={c} open={open === c.path} onToggle={() => setOpen(open === c.path ? null : c.path)} busy={!!busy} onDiscard={() => run('discard', async () => void (await revertOpen([c.path], `Discard changes to ${c.path}`)))} />
      ))}
      {link.skipped?.length ? <div className="px-3 pt-2 text-[11px] text-faint">Left on GitHub (too large or unreadable here): {link.skipped.join(', ')}</div> : null}
    </div>
  );
}

function ChangeRow({ change: c, open, onToggle, busy, onDiscard }: { change: Change; open: boolean; onToggle: () => void; busy: boolean; onDiscard: () => void }) {
  const role = repoFileRole(c.path);
  const text = role !== 'asset';
  return (
    <div className={cx('mx-1', open && 'rounded bg-panel-2')}>
      <div className="gs-row flex items-center gap-1.5 rounded px-2 py-[3px] hover:bg-panel-2" data-testid="git-change" data-path={c.path} data-status={c.status}>
        <button className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={onToggle} aria-expanded={open}>
          {open ? <ChevronDown size={12} className="shrink-0 text-muted" /> : <ChevronRight size={12} className="shrink-0 text-muted" />}
          <FileIcon path={c.path} />
          <span className="truncate">{c.path}</span>
        </button>
        <span className={cx('w-3 shrink-0 text-center font-mono text-[11px]', STATUS_COLOR[c.status])} title={c.status}>
          {c.status[0].toUpperCase()}
        </span>
      </div>
      {open && (
        <div className="pb-1.5">
          {text && <DiffView path={c.path} />}
          <div className="flex gap-3 px-3 pt-1 text-[11.5px]">
            {c.status !== 'deleted' && (role === 'scene' || role === 'script') && (
              <button className={linkCls} onClick={() => openInEditor(c.path)}>
                Open
              </button>
            )}
            <button
              className="flex items-center gap-1 text-muted hover:text-err"
              disabled={busy}
              onClick={async () => {
                if (await confirmDialog({ title: `Discard changes to ${c.path}?`, message: c.status === 'added' ? 'The file is removed from the project (you can undo this).' : "The file goes back to GitHub's version (you can undo this).", confirm: 'Discard', danger: true })) onDiscard();
              }}
              data-testid="git-discard"
            >
              <Undo2 size={12} /> Discard
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
