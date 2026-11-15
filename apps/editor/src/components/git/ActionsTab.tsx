/**
 * GitHub Actions for the linked repository: add a ready-made workflow, run one, follow runs, read a
 * job's log with its problems linked to project files, re-run what failed.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ExternalLink, Play, RotateCcw } from 'lucide-react';
import type { GitLink } from '@gs/project';
import { BUILD_BRANCH, WORKFLOW_DIR, WORKFLOW_TEMPLATES, cleanLogLine, parseLogProblems, projectFilesOf, runState, summarizeRun, type Job, type LogProblem, type Workflow, type WorkflowRun } from '@gs/git';
import { useEditor } from '@editor/store/editor';
import { toast } from '@editor/store/toasts';
import { github } from '@editor/git/api';
import { addWorkflowOpen } from '@editor/git/ops';
import { Button, Select, cx } from '../ui/primitives';
import { SectionLabel, StateIcon, ago, errMsg, linkCls, useBusy } from './common';
import { openInEditor } from './ChangesTab';

export function ActionsTab({ link }: { link: GitLink }) {
  const [branch, setBranch] = useState(link.branch);
  const [workflows, setWorkflows] = useState<Workflow[] | null>(null);
  const [runs, setRuns] = useState<WorkflowRun[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [jobs, setJobs] = useState<Record<number, Job[]>>({});
  const [log, setLog] = useState<{ job: number; name: string } | null>(null);
  const { busy, run } = useBusy();

  const refresh = useCallback(async () => {
    const gh = github();
    try {
      const [w, r] = await Promise.all([gh.workflows(link.owner, link.repo), gh.runs(link.owner, link.repo, { branch })]);
      setWorkflows(w);
      setRuns(r);
    } catch (e) {
      toast('error', errMsg(e));
      setWorkflows((x) => x ?? []);
      setRuns((x) => x ?? []);
    }
  }, [link.owner, link.repo, branch]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  // Follow runs: every 5 s while one is running, every 30 s otherwise.
  const running = runs?.some((r) => runState(r) === 'running');
  useEffect(() => {
    const t = setInterval(() => void refresh(), running ? 5000 : 30000);
    return () => clearInterval(t);
  }, [refresh, running]);
  useEffect(() => {
    if (open === null) return;
    void github()
      .jobs(link.owner, link.repo, open)
      .then((j) => setJobs((x) => ({ ...x, [open]: j })))
      .catch((e) => toast('error', errMsg(e)));
  }, [open, runs, link.owner, link.repo]);

  const has = (path: string) => workflows?.some((w) => w.path === path);
  return (
    <div className="min-h-0 flex-1 overflow-auto pb-3 text-[12px]" data-testid="actions-panel">
      <SectionLabel>Workflows</SectionLabel>
      {workflows === null && <div className="px-3 text-muted">Loading…</div>}
      {workflows?.length === 0 && <div className="px-3 text-muted">No workflows on the default branch yet.</div>}
      {workflows?.map((w) => (
        <div key={w.id} className="gs-row mx-1 flex items-center gap-1.5 rounded px-2 py-1 hover:bg-panel-2" data-testid="workflow-row">
          <span className="truncate">{w.name}</span>
          <span className="truncate text-[10.5px] text-muted">{w.path.replace(`${WORKFLOW_DIR}/`, '')}</span>
          <Button
            className="ml-auto"
            variant="ghost"
            disabled={!!busy}
            data-testid="run-workflow"
            onClick={() =>
              run('dispatch', async () => {
                try {
                  await github().dispatch(link.owner, link.repo, w.id, branch);
                } catch (e) {
                  throw new Error(`${errMsg(e)} (a workflow run by hand needs "on: workflow_dispatch", and the token's "Actions: Read and write")`, { cause: e });
                }
                toast('success', `Started ${w.name} on ${branch}`);
                setTimeout(() => void refresh(), 1500);
              })
            }
          >
            <Play size={12} /> Run
          </Button>
        </div>
      ))}
      <div className="space-y-1.5 px-3 pt-2">
        {WORKFLOW_TEMPLATES.filter((t) => !has(t.path)).map((t) => (
          <button
            key={t.id}
            className="block w-full rounded border border-border p-2 text-left hover:border-accent/60 disabled:opacity-50"
            disabled={!!busy}
            onClick={() =>
              run(`add-${t.id}`, async () => {
                const r = await addWorkflowOpen(t.id);
                toast('success', r.already ? 'That workflow is already there.' : `Added ${r.added.join(' and ')} on ${r.branch}.`);
                if (r.secrets) toast('info', r.secrets);
                setTimeout(() => void refresh(), 1000);
              })
            }
            data-testid={`add-workflow-${t.id}`}
          >
            <div className="font-medium">{busy === `add-${t.id}` ? 'Adding…' : `Add: ${t.title}`}</div>
            <div className="text-[11px] text-muted">{t.description}</div>
          </button>
        ))}
      </div>

      <SectionLabel
        right={
          <span className="flex items-center gap-2">
            <Select className="h-7 w-auto" value={branch} onChange={(e) => setBranch(e.target.value)} aria-label="Branch of the runs" data-testid="runs-branch">
              {[...new Set([link.branch, BUILD_BRANCH])].map((b) => (
                <option key={b} value={b}>
                  {b === BUILD_BRANCH ? `${b} (web build)` : b}
                </option>
              ))}
            </Select>
            <button className={linkCls} onClick={() => void refresh()}>
              Refresh
            </button>
          </span>
        }
      >
        Runs
      </SectionLabel>
      {runs?.length === 0 && <div className="px-3 text-muted">No runs on {branch} yet.</div>}
      {runs?.map((r) => {
        const s = summarizeRun(r);
        return (
          <div key={r.id} className="mx-1">
            <button className={cx('gs-row flex w-full items-center gap-1.5 rounded px-2 py-1 text-left hover:bg-panel-2', open === r.id && 'bg-panel-2')} onClick={() => setOpen(open === r.id ? null : r.id)} data-testid="run-row" data-state={s.state}>
              <StateIcon state={s.state} />
              <span className="truncate">
                {r.name} #{r.run_number}
              </span>
              <span className="ml-auto shrink-0 text-[10.5px] text-muted">
                {s.commit} · {ago(r.created_at)}
              </span>
            </button>
            {open === r.id && (
              <div className="mb-1 ml-5 border-l border-border pl-2">
                {(jobs[r.id] ?? []).map((j) => {
                  const js = runState({ status: j.status as WorkflowRun['status'], conclusion: j.conclusion as WorkflowRun['conclusion'] });
                  return (
                    <div key={j.id} className="py-0.5">
                      <div className="flex items-center gap-1.5">
                        <StateIcon state={js} size={12} />
                        <span className="truncate">{j.name}</span>
                        <button className={cx(linkCls, 'ml-auto')} onClick={() => setLog(log?.job === j.id ? null : { job: j.id, name: j.name })} data-testid="open-log">
                          {log?.job === j.id ? 'Hide log' : 'Log'}
                        </button>
                      </div>
                      {(j.steps ?? [])
                        .filter((x) => x.conclusion === 'failure')
                        .map((x) => (
                          <div key={x.number} className="pl-5 text-[11px] text-err">
                            ✗ {x.name}
                          </div>
                        ))}
                      {log?.job === j.id && <JobLog link={link} job={j.id} />}
                    </div>
                  );
                })}
                <div className="flex gap-3 py-1">
                  {s.state === 'failed' && (
                    <button
                      className={cx(linkCls, 'flex items-center gap-1')}
                      data-testid="rerun-failed"
                      onClick={() =>
                        run('rerun', async () => {
                          await github().rerun(link.owner, link.repo, r.id);
                          toast('success', 'Re-running the failed jobs');
                          setTimeout(() => void refresh(), 1500);
                        })
                      }
                    >
                      <RotateCcw size={11} /> Re-run failed
                    </button>
                  )}
                  <a className={cx(linkCls, 'flex items-center gap-1')} href={r.html_url} target="_blank" rel="noreferrer">
                    <ExternalLink size={11} /> GitHub
                  </a>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** A job's log: the problems found (linked to project files) and its last lines. */
function JobLog({ link, job }: { link: GitLink; job: number }) {
  const project = useEditor((s) => s.project);
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    github()
      .jobLog(link.owner, link.repo, job)
      .then(setText, (e) => setText(`Couldn't read the log: ${errMsg(e)}`));
  }, [link.owner, link.repo, job]);
  const files = useMemo(() => (project ? projectFilesOf(project) : new Set<string>()), [project]);
  const problems: LogProblem[] = useMemo(() => (text ? parseLogProblems(text, (p) => files.has(p)) : []), [text, files]);
  if (text === null) return <div className="py-1 pl-5 text-muted">Loading the log…</div>;
  const tail = text.split('\n').map(cleanLogLine).slice(-80).join('\n');
  return (
    <div className="mt-1 space-y-1" data-testid="job-log">
      {problems.map((p, i) => (
        <button key={i} className="flex w-full items-start gap-1.5 rounded px-1 py-0.5 text-left hover:bg-panel-3" onClick={() => p.file && openInEditor(p.file)} disabled={!p.file} data-testid="log-problem" data-file={p.file}>
          <StateIcon state="failed" size={12} />
          <span className="min-w-0 flex-1">{p.message}</span>
          {p.file && (
            <span className="shrink-0 font-mono text-[10.5px] text-accent">
              {p.file}:{p.line}
            </span>
          )}
        </button>
      ))}
      <pre className="max-h-56 overflow-auto rounded bg-bg p-2 font-mono text-[10.5px] leading-snug text-muted">{tail}</pre>
    </div>
  );
}
