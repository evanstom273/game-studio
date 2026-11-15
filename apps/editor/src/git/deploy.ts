/**
 * Deploy the open project's playable web build: the export is built here in the browser (it needs
 * the TypeScript compiler and the engine bundles), then committed to the repository's web build
 * branch (gh-pages, under docs/). GitHub Pages serves it from there; for Cloudflare the branch also
 * gets a workflow that uploads it with Wrangler, using repository secrets the server seals from
 * the saved Cloudflare token. See @gs/git deploy.ts.
 */
import { unzipSync } from 'fflate';
import { GameStudioError } from '@gs/shared';
import { BUILD_BRANCH, cloudflareFiles, ensurePages, publishBuild, status, workerName, type BuildFile, type DeployTarget } from '@gs/git';
import { buildWebExport } from '@editor/export/web-export';
import { useEditor } from '@editor/store/editor';
import { cloudflareStatus, github, setCloudflareSecrets } from './api';

export interface DeployResult {
  target: DeployTarget;
  repository: string;
  branch: string;
  commit: string;
  files: number;
  uploaded: number;
  unchanged: boolean;
  url?: string;
  note: string;
}

export async function deployOpen(target: DeployTarget, opts: { branch?: string; workerName?: string; onProgress?: (step: string) => void } = {}): Promise<DeployResult> {
  const project = useEditor.getState().project;
  if (!project) throw new GameStudioError('E_NO_PROJECT', 'No project is open');
  const link = project.git;
  if (!link) throw new GameStudioError('E_NOT_LINKED', 'Publish this project to a GitHub repository first (GitHub → Publish).');
  const branch = opts.branch?.trim() || BUILD_BRANCH;
  if (branch === link.branch) throw new GameStudioError('E_INVALID', `The web build needs its own branch, not "${branch}" (the project's).`);
  const progress = opts.onProgress ?? (() => {});
  progress('Building the web export…');
  const exp = await buildWebExport(project);
  const build: BuildFile[] = Object.entries(unzipSync(exp.zip)).map(([path, data]) => ({ path, data }));
  const gh = github();
  let extra: BuildFile[] = [];
  let url: string | undefined;
  if (target === 'cloudflare') {
    if (!(await cloudflareStatus()).configured) throw new GameStudioError('E_CLOUDFLARE_NOT_CONNECTED', 'Connect Cloudflare first (your API token and account ID, once for all projects).');
    progress('Setting the deploy secrets on the repository…');
    const secrets = await setCloudflareSecrets(link.owner, link.repo);
    const worker = workerName(opts.workerName || link.repo);
    extra = cloudflareFiles(worker, branch);
    if (secrets.workers_subdomain) url = `https://${worker}.${secrets.workers_subdomain}.workers.dev`;
  }
  progress('Uploading the build to GitHub…');
  const pending = status(project).length;
  const source = `${link.branch} @ ${link.commit.slice(0, 7)}${pending ? `, with ${pending} uncommitted change${pending === 1 ? '' : 's'}` : ''}`;
  const r = await publishBuild(gh, link.owner, link.repo, build, { branch, name: project.name, source, extra });
  if (target === 'github-pages') {
    progress('Turning on GitHub Pages…');
    url = (await ensurePages(gh, link.owner, link.repo, branch)).url;
  }
  const note =
    target === 'github-pages'
      ? 'GitHub Pages publishes the build in a minute or so; the address stays the same for every deploy.'
      : 'The "Deploy to Cloudflare" workflow on the build branch is uploading it now (see Actions → runs on the build branch).';
  return { target, repository: `${link.owner}/${link.repo}`, branch: r.branch, commit: r.commit, files: r.files, uploaded: r.uploaded, unchanged: r.unchanged, ...(url ? { url } : {}), note: r.unchanged ? 'Nothing changed since the last deploy: the published build is already this one.' : note };
}
