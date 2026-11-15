/**
 * Deploying a game's web export from Game Studio.
 *
 * The export (index.html, the engine modules the game uses, game.js, game.json, assets/) is built
 * in the browser and committed to a separate branch of the project's repository, the "web build"
 * branch (gh-pages by default):
 *
 *   README.md                                 what this branch is
 *   docs/…                                    the playable game
 *   wrangler.jsonc                            Cloudflare only: serve docs/ as Workers static assets
 *   .github/workflows/deploy-cloudflare.yml   Cloudflare only: deploy on every push to this branch
 *
 * GitHub Pages serves docs/ straight from the branch. For Cloudflare, the workflow runs Wrangler
 * with the repository secrets CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID (set, sealed, by the
 * Durable Object that keeps the user's Cloudflare token). The project's own branches are never
 * touched, and every deploy is an ordinary fast-forward commit (nothing is force-pushed).
 */
import { GitHub, GitHubError, isValidBranchName, type NewTreeEntry, type PagesSite } from './github';
import { gitBlobHash } from './hash';
import { COMPATIBILITY_DATE, WORKFLOW_DIR, WRANGLER_VERSION, summarizeRun } from './actions';

export const BUILD_BRANCH = 'gh-pages';
/** Folder of the build branch that holds the game (GitHub Pages can serve "/" or "/docs"). */
export const BUILD_DIR = 'docs';
export const CLOUDFLARE_WORKFLOW = `${WORKFLOW_DIR}/deploy-cloudflare.yml`;

export interface BuildFile {
  path: string;
  data: Uint8Array;
}

export type DeployTarget = 'github-pages' | 'cloudflare';

/** A Worker name from a project or repository name (lower-case letters, digits and dashes). */
export const workerName = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63) || 'game';

export function cloudflareWorkflow(branch = BUILD_BRANCH) {
  return `name: Deploy to Cloudflare
# Published by Game Studio: every web build pushed to this branch is deployed to Cloudflare Workers.
on:
  push:
    branches: [${JSON.stringify(branch)}]
  workflow_dispatch:
concurrency:
  group: deploy-cloudflare
  cancel-in-progress: true
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Deploy to Cloudflare Workers
        run: npx --yes wrangler@${WRANGLER_VERSION} deploy
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
`;
}

export function wranglerConfig(name: string) {
  return `{
  // Published by Game Studio: the game's web build (${BUILD_DIR}/) served as Workers static assets.
  "name": ${JSON.stringify(workerName(name))},
  "compatibility_date": "${COMPATIBILITY_DATE}",
  "assets": { "directory": "./${BUILD_DIR}" }
}
`;
}

const enc = new TextEncoder();

/** The extra files a Cloudflare deploy puts on the build branch. */
export function cloudflareFiles(worker: string, branch = BUILD_BRANCH): BuildFile[] {
  return [
    { path: 'wrangler.jsonc', data: enc.encode(wranglerConfig(worker)) },
    { path: CLOUDFLARE_WORKFLOW, data: enc.encode(cloudflareWorkflow(branch)) },
  ];
}

function readme(name: string, source: string) {
  return `# ${name} — web build

This branch is published by Game Studio: it holds the playable web build of the game, not its source.

- \`${BUILD_DIR}/\` is the game (GitHub Pages serves this folder when it is turned on).
- \`wrangler.jsonc\` and \`.github/workflows/deploy-cloudflare.yml\`, when present, deploy it to Cloudflare Workers on every push.

Built from ${source}. Don't edit this branch by hand: the next deploy replaces it.
`;
}

/** Files of the build branch a deploy keeps when it doesn't write them itself (deploy setup, custom domain). */
const kept = (path: string) => path.startsWith('.github/') || path === 'wrangler.jsonc' || path === `${BUILD_DIR}/CNAME`;

export interface PublishResult {
  branch: string;
  commit: string;
  /** Files whose content changed (uploaded). */
  uploaded: number;
  files: number;
  created: boolean;
  unchanged: boolean;
}

/**
 * Commit a web build to the build branch: the game under docs/, plus `extra` files at the root.
 * Only files whose content changed are uploaded; files of an older build that are gone are removed.
 */
export async function publishBuild(gh: GitHub, owner: string, repo: string, build: BuildFile[], opts: { branch?: string; name: string; source: string; extra?: BuildFile[]; message?: string }): Promise<PublishResult> {
  const branch = opts.branch?.trim() || BUILD_BRANCH;
  if (!isValidBranchName(branch)) throw new GitHubError('E_INVALID', `"${branch}" is not a valid branch name.`);
  if (!build.some((f) => f.path === 'index.html')) throw new GitHubError('E_INVALID', 'The web build has no index.html.');
  const files: BuildFile[] = [
    ...build.map((f) => ({ path: `${BUILD_DIR}/${f.path}`, data: f.data })),
    { path: `${BUILD_DIR}/.nojekyll`, data: new Uint8Array() },
    { path: 'README.md', data: enc.encode(readme(opts.name, opts.source)) },
    ...(opts.extra ?? []),
  ];
  const seen = new Set<string>();
  for (const f of files) {
    if (seen.has(f.path) || f.path.split('/').some((s) => s === '..' || s === '')) throw new GitHubError('E_INVALID', `Bad build file path "${f.path}"`);
    seen.add(f.path);
  }
  for (let attempt = 0; ; attempt++) {
    const head = await gh.headOrNull(owner, repo, branch);
    const old = head ? await gh.commit(owner, repo, head) : null;
    const oldTree = old ? await gh.tree(owner, repo, old.tree.sha) : [];
    const oldSha = new Map(oldTree.filter((e) => e.type === 'blob').map((e) => [e.path, e.sha]));
    const existing = new Set(oldSha.values());
    const entries: NewTreeEntry[] = [];
    let uploaded = 0;
    const queue = [...files];
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        for (let f = queue.shift(); f; f = queue.shift()) {
          const sha = gitBlobHash(f.data);
          if (oldSha.get(f.path) !== sha) {
            uploaded++;
            // Content GitHub already has (moved, or a duplicate) needn't be sent again.
            if (!existing.has(sha)) {
              const stored = await gh.createBlob(owner, repo, f.data);
              if (stored !== sha) throw new GitHubError('E_GITHUB', `GitHub stored ${f.path} with an unexpected hash`);
            }
          }
          entries.push({ path: f.path, mode: '100644', type: 'blob', sha });
        }
      }),
    );
    for (const [p, sha] of oldSha) if (!seen.has(p) && kept(p)) entries.push({ path: p, mode: '100644', type: 'blob', sha });
    entries.sort((a, b) => (a.path < b.path ? -1 : 1));
    const tree = await gh.createTree(owner, repo, null, entries);
    if (old && tree === old.tree.sha) return { branch, commit: head!, uploaded: 0, files: files.length, created: false, unchanged: true };
    const commit = await gh.createCommit(owner, repo, opts.message ?? `Web build of ${opts.name} (${opts.source})`, tree, head ? [head] : []);
    try {
      if (head) await gh.updateRef(owner, repo, branch, commit);
      else await gh.createRef(owner, repo, branch, commit);
    } catch (e) {
      // Someone else published at the same moment: build on top of theirs once more.
      if (attempt < 2 && e instanceof GitHubError && e.code === 'E_GITHUB_REJECTED') continue;
      throw e;
    }
    return { branch, commit, uploaded, files: files.length, created: !head, unchanged: false };
  }
}

/** Turn GitHub Pages on for the build branch's docs/ folder (or point it there). Returns the site. */
export async function ensurePages(gh: GitHub, owner: string, repo: string, branch = BUILD_BRANCH): Promise<{ url: string; status: string | null; changed: boolean }> {
  const source = { branch, path: `/${BUILD_DIR}` as const };
  let site = await gh.pages(owner, repo);
  let changed = false;
  if (!site) {
    site = await gh.createPages(owner, repo, source);
    changed = true;
  } else if (site.source?.branch !== branch || site.source?.path !== source.path || (site.build_type && site.build_type !== 'legacy')) {
    await gh.updatePages(owner, repo, source);
    site = (await gh.pages(owner, repo)) ?? site;
    changed = true;
  }
  return { url: site.html_url ?? `https://${owner.toLowerCase()}.github.io/${repo}/`, status: site.status ?? null, changed };
}

export interface DeployStatus {
  branch: string;
  exists: boolean;
  commit?: string;
  message?: string;
  pages: { enabled: boolean; url?: string; status?: string | null; source?: PagesSite['source']; serves_build?: boolean };
  cloudflare: { workflow: boolean; last_run?: ReturnType<typeof summarizeRun> };
}

/** Where the game is published: the build branch, Pages, and the latest Cloudflare deploy run. */
export async function deployStatus(gh: GitHub, owner: string, repo: string, branch = BUILD_BRANCH): Promise<DeployStatus> {
  const head = await gh.headOrNull(owner, repo, branch);
  const [commit, site] = await Promise.all([head ? gh.commit(owner, repo, head) : null, gh.pages(owner, repo)]);
  const tree = commit ? await gh.tree(owner, repo, commit.tree.sha) : [];
  const workflow = tree.some((e) => e.path === CLOUDFLARE_WORKFLOW);
  const runs = workflow ? await gh.runs(owner, repo, { branch }).catch(() => []) : [];
  const last = runs.find((r) => r.path === CLOUDFLARE_WORKFLOW || /cloudflare/i.test(r.name));
  return {
    branch,
    exists: !!head,
    ...(head ? { commit: head, message: commit?.message } : {}),
    pages: site ? { enabled: true, url: site.html_url, status: site.status ?? null, source: site.source, serves_build: site.source?.branch === branch && site.source?.path === `/${BUILD_DIR}` } : { enabled: false },
    cloudflare: { workflow, ...(last ? { last_run: summarizeRun(last) } : {}) },
  };
}

