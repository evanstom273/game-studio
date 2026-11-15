/**
 * GitHub: connect a token, and the user's repositories — open one as a project (clone a branch
 * into this browser), create one, rename / change / delete one.
 */
import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, FolderGit2, Lock, Plus, Settings } from 'lucide-react';
import { githubCall, type RepoInfo } from '@gs/git';
import { github } from '@editor/git/api';
import { cloneRepo } from '@editor/git/ops';
import { useGitHubAuth } from '@editor/git/store';
import { navigate } from '@editor/lib/router';
import { toast } from '@editor/store/toasts';
import { Button, Dialog, Field, IconButton, Select, TextInput, cx } from '../ui/primitives';
import { TokenForm } from './TokenForm';
import { RepoSettings } from './RepoSettings';
import { errMsg, linkCls } from './common';

type View = { name: 'list' } | { name: 'open'; repo: RepoInfo } | { name: 'settings'; repo: RepoInfo } | { name: 'new' };

export function GitHubDialog({ onClose, onOpened }: { onClose: () => void; onOpened?: (projectId: string) => void }) {
  const login = useGitHubAuth((s) => s.login);
  const [repos, setRepos] = useState<RepoInfo[] | null>(null);
  const [q, setQ] = useState('');
  const [view, setView] = useState<View>({ name: 'list' });
  const reload = () => {
    setRepos(null);
    github()
      .repos()
      .then(setRepos)
      .catch((e) => {
        toast('error', errMsg(e));
        setRepos([]);
      });
  };
  useEffect(() => {
    void useGitHubAuth.getState().refresh();
  }, []);
  useEffect(() => {
    if (login) reload();
  }, [login]);
  const shown = useMemo(() => (repos ?? []).filter((r) => r.full_name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 200), [repos, q]);
  const title = view.name === 'open' ? `Open ${view.repo.full_name}` : view.name === 'settings' ? view.repo.full_name : view.name === 'new' ? 'New repository' : 'GitHub';

  return (
    <Dialog title={title} onClose={onClose} width={580}>
      <div className="-mx-4 -my-3 min-h-[200px]" data-testid="github-dialog">
        {login === undefined && <div className="px-4 py-3 text-muted">Checking GitHub…</div>}
        {login === null && (
          <div className="px-4 py-3">
            <TokenForm />
          </div>
        )}
        {login && view.name !== 'list' && (
          <button className="flex items-center gap-1 px-3 pt-2 text-[12px] text-muted hover:text-text" onClick={() => setView({ name: 'list' })} data-testid="github-back">
            <ChevronLeft size={14} /> Repositories
          </button>
        )}
        {login && view.name === 'list' && (
          <div className="px-4 py-3">
            <div className="mb-2 flex items-center gap-2 text-[12px] text-muted">
              <span className="min-w-0 flex-1 truncate">
                Connected as <b className="text-text">{login}</b>
              </span>
              <button className={linkCls} onClick={() => void useGitHubAuth.getState().disconnect()} data-testid="github-disconnect">
                Disconnect
              </button>
            </div>
            <div className="mb-2 flex gap-2">
              <TextInput placeholder={`Search ${repos?.length ?? '…'} repositories`} value={q} onChange={(e) => setQ(e.target.value)} data-testid="repo-search" aria-label="Search repositories" />
              <Button onClick={() => setView({ name: 'new' })} data-testid="repo-new">
                <Plus size={13} /> New
              </Button>
            </div>
            {!repos && <div className="text-muted">Loading repositories…</div>}
            {repos?.length === 0 && <div className="py-2 text-muted">No repositories yet. Create one, or publish a project from the editor (GitHub → Publish).</div>}
            <ul className="max-h-[50dvh] overflow-auto">
              {shown.map((r) => (
                <li key={r.full_name} className="gs-row flex items-center rounded hover:bg-panel-2">
                  <button className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-[12.5px]" onClick={() => setView({ name: 'open', repo: r })} data-testid="repo-row" data-repo={r.full_name}>
                    <FolderGit2 size={14} className="shrink-0 text-muted" />
                    <span className="truncate">{r.full_name}</span>
                    {r.private && <Lock size={11} className="shrink-0 text-muted" aria-label="private" />}
                  </button>
                  <IconButton label={`Settings of ${r.full_name}`} onClick={() => setView({ name: 'settings', repo: r })} data-testid="repo-settings-open">
                    <Settings size={13} />
                  </IconButton>
                </li>
              ))}
            </ul>
          </div>
        )}
        {login && view.name === 'open' && <OpenRepo repo={view.repo} onOpened={(id) => (onClose(), onOpened ? onOpened(id) : navigate({ name: 'project', id }))} />}
        {login && view.name === 'settings' && (
          <RepoSettings
            owner={view.repo.owner.login}
            repo={view.repo.name}
            onChanged={() => {
              setView({ name: 'list' });
              reload();
            }}
          />
        )}
        {login && view.name === 'new' && (
          <NewRepo
            onCreated={(r) => {
              reload();
              setView({ name: 'open', repo: r });
            }}
          />
        )}
      </div>
    </Dialog>
  );
}

function OpenRepo({ repo, onOpened }: { repo: RepoInfo; onOpened: (projectId: string) => void }) {
  const [branches, setBranches] = useState<string[] | null>(null);
  const [branch, setBranch] = useState(repo.default_branch);
  const [progress, setProgress] = useState<string | null>(null);
  useEffect(() => {
    github()
      .branches(repo.owner.login, repo.name)
      .then((b) => setBranches(b.map((x) => x.name)))
      .catch(() => setBranches([]));
  }, [repo]);
  const open = async () => {
    setProgress('Starting…');
    try {
      const c = await cloneRepo(repo.owner.login, repo.name, branch || undefined, (d, t) => setProgress(`Downloading ${d}/${t} files…`));
      toast(c.issues.length ? 'warning' : 'success', c.issues.length ? `Opened ${c.fullName} with ${c.issues.length} note(s): ${c.issues[0]}` : `Opened ${c.fullName} (${branch})`);
      onOpened(c.doc.id);
    } catch (e) {
      toast('error', errMsg(e));
      setProgress(null);
    }
  };
  const empty = branches !== null && branches.length === 0;
  return (
    <div className="space-y-2 px-4 py-3 text-[12px]">
      {empty ? (
        <p className="text-muted">This repository is empty. Publish a project to a new repository from the editor instead (GitHub → Publish), or add a first commit on GitHub.</p>
      ) : (
        <>
          <Field label="Branch">
            <Select value={branch} onChange={(e) => setBranch(e.target.value)} data-testid="clone-branch">
              {[...new Set([repo.default_branch, ...(branches ?? [])])].map((b) => (
                <option key={b}>{b}</option>
              ))}
            </Select>
          </Field>
          <p className="text-muted">The branch is downloaded into this browser as a new project: gamestudio.json (name and settings), the .scene files, scripts and assets. Other files (README, workflows…) stay on GitHub. Commit and pull from GitHub in the editor.</p>
          <Button variant="primary" className="w-full" disabled={!!progress} onClick={() => void open()} data-testid="clone-repo">
            {progress ?? `Open ${repo.name}`}
          </Button>
        </>
      )}
    </div>
  );
}

function NewRepo({ onCreated }: { onCreated: (r: RepoInfo) => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isPrivate, setPrivate] = useState(true);
  const [org, setOrg] = useState('');
  const [busy, setBusy] = useState(false);
  const valid = /^[\w.-]{1,100}$/.test(name.trim());
  const create = async () => {
    setBusy(true);
    try {
      const r = (await githubCall('git_repo_create', github(), { name: name.trim(), description: description.trim() || undefined, private: isPrivate, org: org.trim() || undefined }, null)) as { repository: string };
      const [owner, repo] = r.repository.split('/');
      toast('success', `Created ${r.repository}`);
      onCreated(await github().repo(owner, repo));
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="px-4 py-3 text-[12px]" onSubmit={(e) => (e.preventDefault(), valid && void create())} data-testid="repo-new-form">
      <Field label="Name" hint="Letters, digits, - _ and .">
        <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="my-game" data-testid="repo-new-name" />
      </Field>
      <Field label="Description (optional)">
        <TextInput value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <Field label="Organisation (optional)" hint="Leave empty to create it in your account.">
        <TextInput value={org} onChange={(e) => setOrg(e.target.value)} />
      </Field>
      <label className="mb-3 flex items-center gap-2">
        <input type="checkbox" className="accent-[var(--color-accent)]" checked={isPrivate} onChange={(e) => setPrivate(e.target.checked)} /> Private
      </label>
      <p className={cx('mb-2 text-muted')}>To put the project you're editing into a new repository, use GitHub → Publish in the editor: it creates the repository and pushes every file.</p>
      <Button type="submit" variant="primary" className="w-full" disabled={!valid || busy} data-testid="repo-new-create">
        {busy ? 'Creating…' : 'Create repository'}
      </Button>
    </form>
  );
}
