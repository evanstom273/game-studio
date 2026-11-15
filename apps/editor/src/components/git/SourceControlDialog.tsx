/**
 * Source control for the open project: connect GitHub, publish the project to a new repository,
 * and once it is linked — branch, pull, changes & commit, pull requests, Actions, deploy and the
 * repository's settings. On phones the dialog is a bottom sheet.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ExternalLink, FolderGit2, GitBranch, Plus, RefreshCw } from 'lucide-react';
import { status } from '@gs/git';
import type { GitLink } from '@gs/project';
import { useEditor } from '@editor/store/editor';
import { toast } from '@editor/store/toasts';
import { safeFileName } from '@editor/lib/files';
import { github } from '@editor/git/api';
import { createBranchOpen, publishOpen, pullOpen, recoverDeletedBranch, relinkOpen, switchOpen } from '@editor/git/ops';
import { useGitConflicts, useGitHubAuth } from '@editor/git/store';
import { Button, Dialog, Field, Select, TextInput, cx, isTouch } from '../ui/primitives';
import { TokenForm } from './TokenForm';
import { ChangesTab } from './ChangesTab';
import { PullRequestsTab } from './PullRequestsTab';
import { ActionsTab } from './ActionsTab';
import { DeployTab } from './DeployTab';
import { RepoSettings } from './RepoSettings';
import { linkCls, useBusy } from './common';

type Tab = 'changes' | 'pulls' | 'actions' | 'deploy' | 'repo';

export function SourceControlDialog({ onClose }: { onClose: () => void }) {
  const project = useEditor((s) => s.project);
  const login = useGitHubAuth((s) => s.login);
  useEffect(() => {
    void useGitHubAuth.getState().refresh();
  }, []);
  if (!project) return null;
  const link = project.git ?? null;
  let body: ReactNode;
  if (login === undefined) body = <div className="text-muted">Checking GitHub…</div>;
  else if (login === null) body = <TokenForm />;
  else if (!link) body = <PublishForm login={login} defaultName={safeFileName(project.name)} />;
  else body = <Linked link={link} login={login} />;
  return (
    <Dialog title="Source control" onClose={onClose} width={660}>
      <div className={cx(link && login ? '-mx-4 -my-3' : '')} data-testid="source-control">
        {body}
      </div>
    </Dialog>
  );
}

function PublishForm({ login, defaultName }: { login: string; defaultName: string }) {
  const [name, setName] = useState(defaultName);
  const [description, setDescription] = useState('');
  const [isPrivate, setPrivate] = useState(true);
  const { busy, run } = useBusy();
  const valid = /^[\w.-]{1,100}$/.test(name.trim());
  return (
    <div className="space-y-2 text-[12px]" data-testid="git-not-linked">
      <p className="text-muted">
        Connected to GitHub as <b className="text-text">{login}</b>. This project isn't in a repository yet: publish it to a new one (every scene, script and asset is pushed as the first commit), or open an existing repository from the projects page (“Open from GitHub”).
      </p>
      <form
        className="space-y-1"
        data-testid="publish-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          void run('publish', async () => {
            const r = await publishOpen({ name: name.trim(), description: description.trim() || undefined, private: isPrivate });
            toast('success', `Created ${r.repository} and pushed ${r.files} file(s)`);
          });
        }}
      >
        <Field label="New repository name">
          <TextInput value={name} onChange={(e) => setName(e.target.value)} data-testid="publish-name" />
        </Field>
        <Field label="Description (optional)">
          <TextInput value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <label className="mb-3 flex items-center gap-2 text-muted">
          <input type="checkbox" className="accent-[var(--color-accent)]" checked={isPrivate} onChange={(e) => setPrivate(e.target.checked)} data-testid="publish-private" /> Private
        </label>
        <Button type="submit" variant="primary" className="w-full" disabled={!!busy || !valid} data-testid="publish-create">
          {busy ? 'Creating…' : 'Create repository and push'}
        </Button>
      </form>
      <button className={linkCls} onClick={() => void useGitHubAuth.getState().disconnect()}>
        Disconnect GitHub
      </button>
    </div>
  );
}

/** id, label, shorter label for phones */
const TABS: [Tab, string, string][] = [
  ['changes', 'Changes', 'Changes'],
  ['pulls', 'Pull requests', 'PRs'],
  ['actions', 'Actions', 'Actions'],
  ['deploy', 'Deploy', 'Deploy'],
  ['repo', 'Repository', 'Repo'],
];

function Linked({ link, login }: { link: GitLink; login: string }) {
  const project = useEditor((s) => s.project)!;
  const changes = status(project).length;
  const [tab, setTab] = useState<Tab>('changes');
  const [branches, setBranches] = useState<string[] | null>(null);
  const [newBranch, setNewBranch] = useState<string | null>(null);
  const { busy, run } = useBusy();
  const repoKey = `${link.owner}/${link.repo}`;
  const loadBranches = useCallback(() => {
    github()
      .branches(link.owner, link.repo)
      .then((b) => setBranches(b.map((x) => x.name)))
      .catch(() => setBranches(null));
  }, [link.owner, link.repo]);
  useEffect(() => {
    loadBranches();
    // The tracked branch may have been deleted after its pull request was merged.
    void recoverDeletedBranch()
      .then((r) => {
        if (!r) return;
        toast('warning', `"${r.deleted}" no longer exists on GitHub (merged and deleted?), so this project is now on ${r.link.branch}.${r.kept.length ? ` Your changes to ${r.kept.length} file(s) were kept.` : ''}`);
        loadBranches();
      })
      .catch(() => undefined);
  }, [repoKey, loadBranches]);

  const doPull = () =>
    run('pull', async () => {
      const r = await pullOpen();
      useGitConflicts.getState().set(project.id, r.conflicts);
      if (r.conflicts.length) setTab('changes');
      toast(r.conflicts.length ? 'warning' : 'success', r.upToDate ? 'Already up to date' : `Pulled ${r.updated.length} file(s)${r.merged.length ? `, merged ${r.merged.length}` : ''}${r.conflicts.length ? ` — ${r.conflicts.length} conflict(s) to look at` : ''}`);
    });

  const doSwitch = (to: string) =>
    run('switch', async () => {
      const r = await switchOpen(to);
      useGitConflicts.getState().set(project.id, r.conflicts);
      toast(r.kept.length ? 'warning' : 'success', `Switched to ${to}${r.updated.length ? ` (${r.updated.length} file(s) updated)` : ''}${r.kept.length ? `. Kept your changes to ${r.kept.join(', ')}` : ''}`);
    });

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-2 text-[12px]">
        <span className="sr-only" data-testid="git-branch">
          {repoKey} · {link.branch}
        </span>
        <FolderGit2 size={14} className="shrink-0 text-muted" />
        <a className="min-w-0 truncate font-medium hover:underline" href={`https://github.com/${repoKey}`} target="_blank" rel="noreferrer" title={`${repoKey} on GitHub`}>
          {repoKey}
        </a>
        <GitBranch size={13} className="ml-1 shrink-0 text-muted" />
        <Select
          className="h-7 w-auto max-w-[12rem] font-mono"
          value={link.branch}
          disabled={!!busy}
          aria-label="Branch"
          data-testid="git-branch-select"
          onFocus={loadBranches}
          onChange={(e) => {
            const to = e.target.value;
            if (to === '__new__') setNewBranch('');
            else if (to !== link.branch) void doSwitch(to);
          }}
        >
          {[...new Set([link.branch, ...(branches ?? [])])].map((b) => (
            <option key={b} value={b}>
              {b}
              {branches && !branches.includes(b) ? ' (deleted on GitHub)' : ''}
            </option>
          ))}
          <option value="__new__">＋ New branch…</option>
        </Select>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" disabled={!!busy} onClick={() => void doPull()} data-testid="git-pull" title="Bring in new commits from GitHub">
            <RefreshCw size={12} className={busy === 'pull' ? 'animate-spin' : undefined} /> Pull
          </Button>
          <Button variant="ghost" disabled={!!busy} onClick={() => void useGitHubAuth.getState().disconnect()} title={`Connected as ${login}. Forget this token and connect another one.`} data-testid="git-change-token">
            Change token
          </Button>
          <a className="touch-target inline-flex items-center justify-center rounded px-1.5 text-muted hover:text-text" href={`https://github.com/${repoKey}/tree/${encodeURIComponent(link.branch)}`} target="_blank" rel="noreferrer" aria-label="Open on GitHub" title={`Connected as ${login}. Open on GitHub`}>
            <ExternalLink size={13} />
          </a>
        </div>
        {newBranch !== null && (
          <form
            className="flex w-full gap-1.5 pt-1"
            onSubmit={(e) => {
              e.preventDefault();
              void run('branch', async () => {
                const r = await createBranchOpen(newBranch.trim());
                toast('success', `Created ${r.branch} at ${r.commit.slice(0, 7)}; this project is now on it`);
                setNewBranch(null);
                loadBranches();
              });
            }}
          >
            <TextInput autoFocus={!isTouch()} placeholder="new-branch-name" value={newBranch} onChange={(e) => setNewBranch(e.target.value)} data-testid="new-branch-name" aria-label="New branch name" />
            <Button type="submit" disabled={!newBranch.trim() || !!busy} data-testid="new-branch-create">
              <Plus size={12} /> Create
            </Button>
            <Button variant="ghost" onClick={() => setNewBranch(null)}>
              Cancel
            </Button>
          </form>
        )}
      </div>
      <div className="flex shrink-0 overflow-x-auto border-b border-border" role="tablist">
        {TABS.map(([id, label, short]) => (
          <button key={id} role="tab" aria-selected={tab === id} aria-label={id === 'changes' ? undefined : label} onClick={() => setTab(id)} className={cx('touch-target shrink-0 grow border-b-2 px-2 py-1.5 text-[12px] font-medium sm:px-3', tab === id ? 'border-accent text-text' : 'border-transparent text-muted hover:text-text')} data-testid={`git-view-${id}`}>
            {id === 'changes' ? (
              `${label} (${changes})`
            ) : (
              <>
                <span className="sm:hidden">{short}</span>
                <span className="hidden sm:inline">{label}</span>
              </>
            )}
          </button>
        ))}
      </div>
      {tab === 'changes' && <ChangesTab link={link} />}
      {tab === 'pulls' && <PullRequestsTab link={link} onBranchesChanged={loadBranches} />}
      {tab === 'actions' && <ActionsTab link={link} />}
      {tab === 'deploy' && <DeployTab link={link} />}
      {tab === 'repo' && (
        <RepoSettings
          owner={link.owner}
          repo={link.repo}
          onChanged={(full) => {
            if (!full) relinkOpen(null, 'Unlink from GitHub (repository deleted)');
            else {
              const [owner, repo] = full.split('/');
              relinkOpen({ ...link, owner, repo }, `Repository renamed to ${full}`);
            }
            setTab('changes');
          }}
        />
      )}
      {busy === 'switch' && <div className="px-3 py-2 text-accent">Switching branch…</div>}
    </div>
  );
}
