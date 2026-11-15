/**
 * GitHub Actions for Game Studio projects: ready-made workflows, run summaries, and turning a job
 * log into problems that point at project files.
 */
import type { Job, WorkflowRun } from './github';

export const WORKFLOW_DIR = '.github/workflows';
/** The Wrangler release the Cloudflare deploy workflow uses. */
export const WRANGLER_VERSION = '4.162.0';
/** The esbuild release the check workflow syntax-checks scripts with (the editor's compiler). */
export const ESBUILD_VERSION = '0.28.2';
export const COMPATIBILITY_DATE = '2026-10-01';

/**
 * Checks a project on every push and pull request: gamestudio.json and every scene must be valid
 * JSON, and every script must compile (syntax; esbuild, like the editor). Errors are printed as
 * `file:line:column` so Game Studio can link them to the file.
 */
export const CHECK_WORKFLOW = `name: Check project
on:
  push:
  pull_request:
  workflow_dispatch:
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Scenes and gamestudio.json are valid
        run: |
          node -e '
            const fs = require("fs"), path = require("path");
            let bad = 0;
            const walk = (dir) => {
              for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                if (e.name.startsWith(".") || e.name === "node_modules") continue;
                const p = path.join(dir, e.name);
                if (e.isDirectory()) walk(p);
                else if (p.endsWith(".scene") || p === "gamestudio.json") {
                  try { JSON.parse(fs.readFileSync(p, "utf8")); }
                  catch (err) {
                    const m = /line (\\d+) column (\\d+)/.exec(err.message) || [0, 1, 1];
                    console.log(p + ":" + m[1] + ":" + m[2] + ": error " + err.message);
                    bad++;
                  }
                }
              }
            };
            walk(".");
            if (bad) { console.log("::error::" + bad + " file(s) are not valid JSON"); process.exit(1); }
          '
      - name: Scripts compile
        run: |
          files=$(git ls-files '*.ts' '*.js' | grep -v '^\\.' || true)
          if [ -n "$files" ]; then npx --yes esbuild@${ESBUILD_VERSION} $files --outdir="$RUNNER_TEMP/out" --log-level=warning; fi
`;

export interface WorkflowTemplate {
  id: 'check' | 'cloudflare';
  title: string;
  description: string;
  path: string;
  /** Where the workflow lives: the project's branch, or the web build branch (deploys). */
  where: 'project' | 'build';
}

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: 'check',
    title: 'Check project (CI)',
    description: 'On every push and pull request: checks that every scene and gamestudio.json is valid, and that every script compiles. Problems link to the file and line.',
    path: `${WORKFLOW_DIR}/check.yml`,
    where: 'project',
  },
  {
    id: 'cloudflare',
    title: 'Deploy to Cloudflare (Workers)',
    description: 'Every published web build is deployed to Cloudflare Workers (static assets) with Wrangler 4. Needs the repository secrets CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, which Game Studio sets from your saved Cloudflare token.',
    path: `${WORKFLOW_DIR}/deploy-cloudflare.yml`,
    where: 'build',
  },
];

export interface LogProblem {
  /** Line in the log (1-based). */
  logLine: number;
  message: string;
  file?: string;
  line?: number;
  column?: number;
  severity: 'error' | 'warning';
}

// Timestamps GitHub prefixes to every log line.
const TS = /^\d{4}-\d\d-\d\dT[\d:.]+Z\s?/;
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');

export function cleanLogLine(l: string) {
  return l.replace(TS, '').replace(ANSI, '');
}

/**
 * Finds errors in a job log: `##[error]` annotations, `file(line,col): error` (tsc),
 * `file:line:col` (esbuild, node, the check workflow) — matched against project paths.
 */
export function parseLogProblems(log: string, hasFile: (path: string) => boolean): LogProblem[] {
  const out: LogProblem[] = [];
  const seen = new Set<string>();
  const lines = log.split('\n');
  const resolve = (raw: string) => {
    const p = raw.replace(/^\.?\//, '').replace(/^\/home\/runner\/work\/[^/]+\/[^/]+\//, '');
    return hasFile(p) ? p : undefined;
  };
  let lastFailure = -100;
  let lastMessage = '';
  lines.forEach((rawLine, i) => {
    const l = cleanLogLine(rawLine);
    const failing = /error|fail|✗|✘|×|FAIL|ERROR|Error/.test(l);
    const ann = /^##\[(error|warning)\](.*)$/.exec(l);
    const tsc = /([\w./@-]+\.[a-zA-Z]+)\((\d+),(\d+)\):\s*(error|warning)\s*(.*)$/.exec(l);
    const loc = /(?:^|[\s(])((?:\.?\/)?[\w./@-]+\.[a-zA-Z]{1,6}):(\d+)(?::(\d+))?(?::\s*(?:error\s*)?(.*))?/.exec(l);
    let p: LogProblem | null = null;
    if (tsc && resolve(tsc[1])) p = { logLine: i + 1, file: resolve(tsc[1]), line: +tsc[2], column: +tsc[3], severity: tsc[4] as 'error', message: tsc[5].trim() };
    else if (ann) {
      const f = loc ? resolve(loc[1]) : undefined;
      p = { logLine: i + 1, severity: ann[1] as 'error', message: ann[2].trim() || 'Error', ...(f ? { file: f, line: +loc![2], ...(loc![3] ? { column: +loc![3] } : {}) } : {}) };
    } else if (loc && resolve(loc[1]) && (failing || i - lastFailure <= 6)) {
      // A location on a failure line, or just after one (esbuild prints the file below its message).
      const own = loc[4]?.trim();
      p = { logLine: i + 1, severity: 'error', message: (own || (failing ? l.trim() : lastMessage) || l.trim()).slice(0, 300), file: resolve(loc[1]), line: +loc[2], ...(loc[3] ? { column: +loc[3] } : {}) };
    }
    if (failing && !ann && !loc) {
      lastFailure = i;
      lastMessage = l.replace(/^\s*[✘✗×]\s*/, '').replace(/^\[ERROR\]\s*/, '').trim();
    } else if (failing && !ann) lastFailure = i;
    if (!p) return;
    const key = `${p.file}:${p.line}:${p.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(p);
  });
  return out.slice(0, 200);
}

export const runState = (r: Pick<WorkflowRun, 'status' | 'conclusion'>) =>
  r.status !== 'completed' ? 'running' : r.conclusion === 'success' ? 'passed' : r.conclusion === 'skipped' || r.conclusion === 'cancelled' || r.conclusion === 'neutral' ? r.conclusion : 'failed';

export function summarizeRun(r: WorkflowRun, jobs?: Job[]) {
  return {
    id: r.id,
    workflow: r.name,
    number: r.run_number,
    branch: r.head_branch,
    commit: r.head_sha.slice(0, 7),
    event: r.event,
    state: runState(r),
    title: r.display_title,
    url: r.html_url,
    started: r.created_at,
    ...(jobs
      ? {
          jobs: jobs.map((j) => ({
            id: j.id,
            name: j.name,
            state: runState({ status: j.status as WorkflowRun['status'], conclusion: j.conclusion as WorkflowRun['conclusion'] }),
            failed_steps: (j.steps ?? []).filter((s) => s.conclusion === 'failure').map((s) => s.name),
          })),
        }
      : {}),
  };
}
