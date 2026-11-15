/** Pull requests of the linked repository: list, details, open a new one, merge, close. */
import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, GitMerge, GitPullRequest, Plus, RefreshCw, X } from 'lucide-react';
import type { GitLink } from '@gs/project';
import { githubCall, type PrSummary } from '@gs/git';
import { github } from '@editor/git/api';
import { switchOpen } from '@editor/git/ops';
import { toast } from '@editor/store/toasts';
import { Button, IconButton, Select, TextInput, cx, inputCls } from '../ui/primitives';
import { confirmDialog } from '../ui/feedback';
import { errMsg, useBusy } from './common';

const call = <T,>(method: string, link: GitLink, params: Record<string, unknown> = {}) => githubCall(method, github(), params, link) as Promise<T>;

export function PullRequestsTab({ link, onBranchesChanged }: { link: GitLink; onBranchesChanged: () => void }) {
  const [state, setState] = useState<'open' | 'closed'>('open');
  const [list, setList] = useState<PrSummary[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [method, setMethod] = useState<'merge' | 'squash' | 'rebase'>('squash');
  const [deleteBranch, setDeleteBranch] = useState(true);
  const [details, setDetails] = useState<Record<number, { path: string; status: string }[]>>({});
  const { busy, run } = useBusy();

  const load = useCallback(async () => {
    try {
      setList((await call<{ pull_requests: PrSummary[] }>('git_pr_list', link, { state })).pull_requests);
    } catch (e) {
      toast('error', errMsg(e));
      setList([]);
    }
  }, [link, state]);
  useEffect(() => {
    setList(null);
    void load();
  }, [load]);

  const merge = (p: PrSummary) =>
    run(`m${p.number}`, async () => {
      if (!(await confirmDialog({ title: `Merge #${p.number}?`, message: `${p.head} is merged into ${p.base} on GitHub (${method === 'squash' ? 'squashed into one commit' : method === 'rebase' ? 'rebased' : 'with a merge commit'})${deleteBranch ? `, and ${p.head} is deleted` : ''}.`, confirm: 'Merge' }))) return;
      const r = await call<{ into: string; deleted_branch?: string }>('git_pr_merge', link, { number: p.number, method, delete_branch: deleteBranch });
      // This project was on the merged branch and it's gone: go to where it was merged.
      if (r.deleted_branch && r.deleted_branch === link.branch) {
        const s = await switchOpen(r.into);
        toast('success', `Merged into ${r.into}; this project is now on ${r.into}${s.kept.length ? ` (kept your changes to ${s.kept.length} file(s))` : ''}.`);
      } else toast('success', r.into === link.branch ? `Merged into ${r.into}: Pull to bring it into this project.` : `Merged #${p.number} into ${r.into}`);
      onBranchesChanged();
      await load();
    });

  return (
    <div className="min-h-0 flex-1 overflow-auto pb-3 text-[12px]" data-testid="pull-requests">
      <div className="flex items-center gap-1 px-3 py-2">
        {(['open', 'closed'] as const).map((s) => (
          <button key={s} onClick={() => setState(s)} className={cx('touch-target rounded px-2 py-1 capitalize', state === s ? 'bg-panel-2 text-text' : 'text-muted hover:text-text')}>
            {s}
          </button>
        ))}
        <IconButton label="Refresh" onClick={() => void load()}>
          <RefreshCw size={12} />
        </IconButton>
        <Button className="ml-auto" onClick={() => setCreating((v) => !v)} data-testid="pr-new">
          <Plus size={12} /> New
        </Button>
      </div>
      {creating && (
        <NewPullRequest
          link={link}
          onDone={() => {
            setCreating(false);
            void load();
          }}
        />
      )}
      {state === 'open' && !!list?.length && (
        <div className="flex flex-wrap items-center gap-2 px-3 pb-1 text-[11px] text-muted">
          Merge with
          <Select className="w-auto" value={method} onChange={(e) => setMethod(e.target.value as typeof method)} data-testid="pr-merge-method">
            <option value="squash">Squash</option>
            <option value="merge">Merge commit</option>
            <option value="rebase">Rebase</option>
          </Select>
          <label className="flex items-center gap-1">
            <input type="checkbox" className="accent-[var(--color-accent)]" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} /> delete the branch
          </label>
        </div>
      )}
      {list === null && <div className="px-3 py-2 text-muted">Loading…</div>}
      {list?.length === 0 && <div className="px-3 py-2 text-muted">No {state} pull requests.</div>}
      {list?.map((p) => (
        <div key={p.number} className="mx-2 mb-1.5 rounded border border-border p-2" data-testid="pr-row" data-number={p.number}>
          <div className="flex items-start gap-1.5">
            <GitPullRequest size={13} className={cx('mt-0.5 shrink-0', p.state === 'merged' ? 'text-node-3d' : p.state === 'open' ? 'text-ok' : 'text-err')} />
            <button
              className="min-w-0 flex-1 text-left"
              onClick={() =>
                details[p.number]
                  ? setDetails(({ [p.number]: _gone, ...rest }) => rest)
                  : void call<{ files: { path: string; status: string }[] }>('git_pr_get', link, { number: p.number }).then((d) => setDetails((x) => ({ ...x, [p.number]: d.files })), (e) => toast('error', errMsg(e)))
              }
            >
              <div className="font-medium">
                {p.title} <span className="text-muted">#{p.number}</span>
              </div>
              <div className="truncate text-[11px] text-muted">
                {p.head} → {p.base} · {p.author}
                {p.draft ? ' · draft' : ''}
                {p.state !== 'open' ? ` · ${p.state}` : ''}
                {p.mergeable === false ? ' · has conflicts' : ''}
              </div>
            </button>
            <a href={p.url} target="_blank" rel="noreferrer" className="touch-target inline-flex items-center justify-center text-muted hover:text-text" title="Open on GitHub" aria-label="Open on GitHub">
              <ExternalLink size={12} />
            </a>
          </div>
          {details[p.number] && (
            <div className="mt-1 space-y-0.5 border-l border-border pl-2 font-mono text-[11px] text-muted" data-testid="pr-files">
              {details[p.number].map((f) => (
                <div key={f.path}>
                  {f.status[0].toUpperCase()} {f.path}
                </div>
              ))}
            </div>
          )}
          {p.state === 'open' && (
            <div className="mt-2 flex gap-1.5">
              <Button className="flex-1" disabled={!!busy} onClick={() => void merge(p)} data-testid="pr-merge">
                <GitMerge size={13} /> {busy === `m${p.number}` ? 'Merging…' : 'Merge'}
              </Button>
              <Button
                variant="ghost"
                disabled={!!busy}
                data-testid="pr-close"
                onClick={() =>
                  run(`c${p.number}`, async () => {
                    if (!(await confirmDialog({ title: `Close #${p.number}?`, message: 'It is closed without merging (you can reopen it on GitHub).', confirm: 'Close' }))) return;
                    await call('git_pr_update', link, { number: p.number, state: 'closed' });
                    await load();
                  })
                }
              >
                <X size={13} /> Close
              </Button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function NewPullRequest({ link, onDone }: { link: GitLink; onDone: () => void }) {
  const [branches, setBranches] = useState<string[]>([]);
  const [head, setHead] = useState(link.branch);
  const [base, setBase] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const { busy, run } = useBusy();
  useEffect(() => {
    const gh = github();
    void Promise.all([gh.branches(link.owner, link.repo), gh.repo(link.owner, link.repo)])
      .then(([bs, info]) => {
        setBranches(bs.map((b) => b.name));
        setBase(info.default_branch);
        if (link.branch === info.default_branch) setHead(bs.find((b) => b.name !== info.default_branch)?.name ?? link.branch);
      })
      .catch((e) => toast('error', errMsg(e)));
  }, [link.owner, link.repo, link.branch]);
  return (
    <div className="mx-2 mb-2 space-y-1.5 rounded border border-accent/40 p-2" data-testid="pr-form">
      <div className="grid grid-cols-[auto_1fr] items-center gap-1.5 text-[11.5px]">
        <span className="text-muted">From</span>
        <Select value={head} onChange={(e) => setHead(e.target.value)} data-testid="pr-head">
          {[...new Set([head, ...branches])].map((b) => (
            <option key={b}>{b}</option>
          ))}
        </Select>
        <span className="text-muted">Into</span>
        <Select value={base} onChange={(e) => setBase(e.target.value)} data-testid="pr-base">
          {[...new Set([base, ...branches])].filter(Boolean).map((b) => (
            <option key={b}>{b}</option>
          ))}
        </Select>
      </div>
      <TextInput placeholder={`Title (default: ${head.replace(/[-_/]+/g, ' ')})`} value={title} onChange={(e) => setTitle(e.target.value)} data-testid="pr-title" />
      <textarea className={cx(inputCls, 'h-16 py-1')} placeholder="Description (optional)" value={body} onChange={(e) => setBody(e.target.value)} />
      <Button
        className="w-full"
        disabled={!!busy || !head || !base || head === base}
        data-testid="pr-create"
        onClick={() =>
          run('create', async () => {
            const r = (await githubCall('git_create_pr', github(), { head, base, title: title.trim() || undefined, body: body.trim() || undefined }, link)) as { number: number };
            toast('success', `Pull request #${r.number} opened`);
            onDone();
          })
        }
      >
        {head === base ? 'Pick two different branches' : busy ? 'Opening…' : `Open pull request: ${head} → ${base}`}
      </Button>
      <p className="text-[11px] text-muted">Tip: commit to a new branch in Changes first, then open the pull request from it.</p>
    </div>
  );
}
