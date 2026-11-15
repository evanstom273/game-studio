/**
 * The GitHub, CI and deploy MCP tools (registered in tools-git.ts, run by cloud/git.ts), and the
 * AI-connection level each needs: reading at "read", changing a project or repository at "edit",
 * and deleting repositories, merging pull requests, writing deploy secrets and deploying at "full".
 */
export const GIT_METHODS = [
  'git_repos',
  'git_clone',
  'git_status',
  'git_commit',
  'git_pull',
  'git_branches',
  'git_switch_branch',
  'git_create_branch',
  'git_create_pr',
  'git_pr_list',
  'git_pr_get',
  'git_pr_update',
  'git_pr_merge',
  'git_repo_create',
  'git_repo_update',
  'git_repo_delete',
  'git_publish',
  'ci_status',
  'ci_run',
  'ci_run_details',
  'ci_logs',
  'ci_rerun',
  'ci_add_workflow',
  'ci_cloudflare_secrets',
  'deploy_game',
  'deploy_status',
] as const;

export type GitMethod = (typeof GIT_METHODS)[number];

export type GitLevel = 'read' | 'edit' | 'full';

export const GIT_LEVEL: Record<GitMethod, GitLevel> = {
  git_repos: 'read',
  git_status: 'read',
  git_branches: 'read',
  git_pr_list: 'read',
  git_pr_get: 'read',
  ci_status: 'read',
  ci_run_details: 'read',
  ci_logs: 'read',
  deploy_status: 'read',
  git_clone: 'edit',
  git_commit: 'edit',
  git_pull: 'edit',
  git_switch_branch: 'edit',
  git_create_branch: 'edit',
  git_create_pr: 'edit',
  git_pr_update: 'edit',
  git_repo_create: 'edit',
  git_repo_update: 'edit',
  git_publish: 'edit',
  ci_run: 'edit',
  ci_rerun: 'edit',
  ci_add_workflow: 'edit',
  git_pr_merge: 'full',
  git_repo_delete: 'full',
  ci_cloudflare_secrets: 'full',
  deploy_game: 'full',
};

const SET = new Set<string>(GIT_METHODS);
export const isGitMethod = (m: string): m is GitMethod => SET.has(m);
