/**
 * MCP tools for GitHub: repositories, commit / pull / branches, pull requests, GitHub Actions and
 * deploying the game's web build (GitHub Pages or Cloudflare). They run against the cloud copy of
 * the project (cloud/git.ts) with the GitHub token kept in the user's Durable Object; deploying
 * asks an open editor to build the game. Kept apart from tools.ts so the two evolve independently.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toErrorPayload } from '../../shared/src/errors.ts';
import type { GitMethod } from './git-methods.ts';
import type { Relay } from './tools.ts';

const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
const fail = (e: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: toErrorPayload(e) }, null, 2) }] });

const project = z.string().optional().describe('Project id or exact name. Omit for the open project.');
const repository = z.string().optional().describe('"owner/name": another repository instead of the project\'s');
const ro = { readOnlyHint: true } as const;
const destructive = { destructiveHint: true } as const;
const NOTE = "Needs GitHub connected in Game Studio (Source control → connect a token; the token stays in the user's own cloud storage and is never shown).";

export function registerGitTools(server: McpServer, relay: Relay) {
  const tool = <S extends z.ZodRawShape>(name: GitMethod, title: string, description: string, inputSchema: S, annotations: Record<string, boolean> = {}, timeout = 120_000) =>
    server.registerTool(name, { title, description, inputSchema, annotations }, (async (args: Record<string, unknown>) => {
      try {
        return text(await relay.request(name, args, timeout));
      } catch (e) {
        return fail(e);
      }
    }) as never);

  // --- repositories --------------------------------------------------------------------------------
  tool('git_repos', 'List GitHub repositories', `Repositories the user's GitHub token can reach. ${NOTE}`, {}, ro, 60_000);
  tool('git_clone', 'Open a GitHub repository', `Download a branch of a repository as a new Game Studio project, linked to it for commit and pull. Scenes, scripts and assets become the project (gamestudio.json holds the settings); README, workflows and other files stay on GitHub. ${NOTE}`, { repository: z.string().describe('"owner/name"'), branch: z.string().optional().describe("Default: the repository's default branch") }, {}, 300_000);
  tool('git_repo_create', 'Create a repository', `Create a new GitHub repository (private unless private=false; org to create it in an organisation). To put a project into a new repository, use git_publish instead. ${NOTE}`, { name: z.string().min(1).max(100), description: z.string().max(350).optional(), private: z.boolean().optional(), org: z.string().optional(), auto_init: z.boolean().optional().describe('Start with a README commit (default true)') }, {}, 60_000);
  tool('git_repo_update', 'Edit a repository', "Rename a repository, change its description, homepage, visibility (private), default branch, or archive it. Defaults to the project's repository (a rename keeps the project linked).", { project, repository, name: z.string().optional(), description: z.string().max(350).optional(), homepage: z.string().optional(), private: z.boolean().optional(), default_branch: z.string().optional(), archived: z.boolean().optional() }, {}, 60_000);
  tool('git_repo_delete', 'Delete a repository', "Permanently delete a GitHub repository. confirm_name must be exactly \"owner/name\", and the user is asked to confirm in Game Studio (unless they turned confirmations off). A project linked to it stays, unlinked. Needs the token's Administration permission and the AI connection's \"full\" level.", { project, repository, confirm_name: z.string() }, destructive, 300_000);
  tool('git_publish', 'Publish project to a new repository', 'Create a GitHub repository for a project that is not linked yet, link it, and push every project file as the first commit.', { project, name: z.string().min(1).max(100), description: z.string().max(350).optional(), private: z.boolean().optional(), org: z.string().optional(), message: z.string().optional() }, {}, 300_000);

  // --- commit, pull, branches -------------------------------------------------------------------------
  tool('git_status', 'Git status', 'Repository, branch and the project files changed (added / modified / deleted) since the last commit or pull. Files are gamestudio.json (name and settings), each .scene, each script and each asset.', { project }, ro, 30_000);
  tool(
    'git_commit',
    'Commit & push',
    `Commit all changes (or only "paths") and push them to GitHub; only changed files are uploaded. new_branch commits to a new branch made from the current commit (then git_create_pr). Refused with E_NOT_FAST_FORWARD if GitHub has newer commits — git_pull first; never forced. Refused with E_MASS_DELETE when it would delete 10+ files: that almost always means the project didn't load completely, so STOP and tell the user; only pass confirm_deletions (the exact number) if the user asked for those deletions (they are asked to confirm in Game Studio too). ${NOTE}`,
    { project, message: z.string().min(1).max(5000), paths: z.array(z.string()).optional(), new_branch: z.string().optional(), confirm_deletions: z.number().int().optional().describe('Only when the user asked to delete those files: the exact number E_MASS_DELETE reported.') },
    {},
    300_000,
  );
  tool('git_pull', 'Pull', "Bring in new commits from GitHub as one undo step. Files changed only on GitHub are updated; scripts changed on both sides are merged line by line (overlaps get conflict markers); scenes and gamestudio.json changed on both sides are merged only when the result is still valid, otherwise the local version is kept and reported; assets changed on both sides keep the local version. Open editors update live.", { project }, {}, 300_000);
  tool('git_branches', 'List branches', "Every branch of the project's repository, the one the project is on, the default branch, and whether the current one still exists on GitHub (it may have been deleted after its pull request was merged).", { project }, ro, 60_000);
  tool('git_switch_branch', 'Switch branch', "Switch the project to another existing branch. Files not changed here become that branch's version; files changed here keep your version (nothing is lost). One undo step.", { project, branch: z.string().min(1) }, {}, 300_000);
  tool('git_create_branch', 'Create a branch', "Create a branch on GitHub at the project's current commit and (unless switch=false) switch the project to it; local changes come along. To commit straight to a new branch, use git_commit with new_branch.", { project, name: z.string().min(1).max(200), switch: z.boolean().optional() }, {}, 60_000);

  // --- pull requests -----------------------------------------------------------------------------------
  tool('git_create_pr', 'Open a pull request', 'Open a pull request from the current branch (or "head") into the default branch (or "base").', { project, repository, title: z.string().max(256).optional(), body: z.string().optional(), head: z.string().optional(), base: z.string().optional(), draft: z.boolean().optional() }, {}, 60_000);
  tool('git_pr_list', 'List pull requests', `Pull requests of the project's repository (or "repository"). ${NOTE}`, { project, repository, state: z.enum(['open', 'closed', 'all']).optional() }, ro, 60_000);
  tool('git_pr_get', 'Pull request details', 'One pull request: description, whether it can be merged, and the files it changes.', { project, repository, number: z.number().int().min(1) }, ro, 60_000);
  tool('git_pr_update', 'Edit / close a pull request', "Change a pull request's title, description or base branch, or close / reopen it (state).", { project, repository, number: z.number().int().min(1), title: z.string().optional(), body: z.string().optional(), base: z.string().optional(), state: z.enum(['open', 'closed']).optional() }, {}, 60_000);
  tool(
    'git_pr_merge',
    'Merge a pull request',
    'Merge a pull request on GitHub (method merge, squash or rebase; delete_branch removes its branch afterwards). Refused with E_MERGE_CONFLICT if it conflicts with its base. If the project was on the merged branch and it was deleted, the project switches to the base branch (switched_project_to); otherwise git_pull brings the merge in. Needs the "full" level.',
    { project, repository, number: z.number().int().min(1), method: z.enum(['merge', 'squash', 'rebase']).optional(), commit_title: z.string().optional(), delete_branch: z.boolean().optional() },
    {},
    120_000,
  );

  // --- GitHub Actions ------------------------------------------------------------------------------------
  tool('ci_status', 'CI status', "Workflows of the project's repository and the latest runs on the current branch (or \"branch\"): running / passed / failed …", { project, branch: z.string().optional() }, ro, 60_000);
  tool('ci_run', 'Run a workflow', 'Start a workflow (it needs "on: workflow_dispatch") on the current branch or "ref".', { project, workflow: z.string().optional().describe('Workflow id, name or file (e.g. check.yml); optional if there is only one'), ref: z.string().optional() }, {}, 60_000);
  tool('ci_run_details', 'CI run details', 'Jobs of a run with their state and failed steps.', { project, run_id: z.number().int() }, ro, 60_000);
  tool('ci_logs', 'CI logs', "Logs of a run's failed jobs (or one job): the problems found (errors with the project file and line, when they point at one) and the last lines of the log.", { project, run_id: z.number().int().optional(), job_id: z.number().int().optional(), tail: z.number().int().min(10).max(1000).optional() }, ro, 120_000);
  tool('ci_rerun', 'Re-run CI', 'Re-run the failed jobs of a run (all=true re-runs everything).', { project, run_id: z.number().int(), all: z.boolean().optional() }, {}, 60_000);
  tool(
    'ci_add_workflow',
    'Add a ready-made workflow',
    'Add a GitHub Actions workflow. "check": on every push and pull request, checks that scenes and gamestudio.json are valid and that every script compiles (committed on its own to the project\'s branch; problems link to files). "cloudflare": deploys every published web build to Cloudflare Workers (added to the web build branch; deploy_game with target "cloudflare" does this for you, and sets the secrets).',
    { project, template: z.enum(['check', 'cloudflare']) },
    {},
    120_000,
  );
  tool('ci_cloudflare_secrets', 'Set Cloudflare deploy secrets', "Put the Cloudflare API token and account ID saved in Game Studio into the project repository's GitHub Actions secrets (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID), sealed with the repository's key. The values are never returned. Needs Cloudflare connected once in Game Studio (Source control → Deploy), the token's \"Secrets: Read and write\" permission and the \"full\" level.", { project }, {}, 60_000);

  // --- deploying the game ------------------------------------------------------------------------------------
  tool(
    'deploy_game',
    'Deploy the game',
    'Publish the playable web build of the project: Game Studio (open in a browser) builds the web export and commits it to the web build branch (gh-pages, under docs/). "github-pages" turns on GitHub Pages for it and returns the address. "cloudflare" also adds a workflow that deploys it to Cloudflare Workers with the saved Cloudflare token (repository secrets are set for you). Needs an open editor (E_NO_EDITOR otherwise), the "full" level, and the token\'s Contents, Pages (for Pages) or Workflows + Secrets (for Cloudflare) permissions.',
    { project, target: z.enum(['github-pages', 'cloudflare']), branch: z.string().optional().describe('Web build branch (default gh-pages)'), worker_name: z.string().optional().describe('Cloudflare Worker name (default: the repository name)') },
    {},
    660_000,
  );
  tool('deploy_status', 'Deploy status', 'Where the game is published: the web build branch (latest build commit), the GitHub Pages address and state, and the latest Cloudflare deploy run.', { project, branch: z.string().optional() }, ro, 60_000);
}
