# GitHub

Ported from Coding Studio: link a project to a GitHub repository, commit and pull, branches and
pull requests, GitHub Actions, and deploying the game to GitHub Pages or Cloudflare, from the
editor or from an AI assistant over MCP.

> **Tested against a fake GitHub only.** Everything below is covered by unit tests that run
> against an in-memory GitHub (`tests/fixtures/fake-github.ts`, `tests/unit/git.test.ts`,
> `tests/unit/git-cloud.test.ts`). No real GitHub or Cloudflare account has been used yet.

## Connecting

In the editor: **GitHub** (toolbar / menu) opens Source control; the dashboard has **Open from
GitHub**. (Exact labels may still shift slightly.)

You need a **fine-grained personal access token** (GitHub → Settings → Developer settings →
Fine-grained tokens) with access to the repositories you want, and these repository permissions
(Read and write):

| Permission | Needed for |
| --- | --- |
| Contents | commit, pull, branches, builds — **required** |
| Pull requests | pull requests — **required** for PRs |
| Workflows | adding workflows (checks, the Cloudflare deploy workflow) |
| Actions | running, re-running and reading Actions logs |
| Pages | turning on GitHub Pages |
| Secrets | storing the Cloudflare deploy secrets |
| Administration | creating, renaming and deleting repositories |

Metadata (read) is added automatically. Contents + Pull requests is enough for everyday
commit/pull/PR work.

### Where the token lives

Only in your link key's Durable Object (storage key `gh:token`), never in the browser's project
data or the repo. The editor calls GitHub through `/github/<key>/api/<path>` on the same site
(same-origin and `Sec-Fetch-Site` checks). The proxy only allows `GET /user`,
`GET|POST /user/repos`, `POST /orgs/<org>/repos` and anything under `/repos/<owner>/<repo>/…`; it
follows redirects itself and only ever sends the token to `api.github.com`.

Endpoints: `GET|PUT|DELETE /github/<key>/token`, `/github/<key>/cloudflare`,
`POST /github/<key>/cloudflare/secrets`. GitHub works whether the AI connection is switched on or
not (the link key always exists).

## How a project is stored in a repo

`packages/project/src/files.ts`:

- `gamestudio.json` — `{ format: "game-studio-repo", version: 1, projectFormatVersion, name, settings, imageSizes? }` (`imageSizes` only for SVGs).
- Each scene as canonical, pretty-printed JSON at its path (fixed node key order: id, name, type, instance, script, scriptProps, props, groups, children; property keys sorted), so diffs stay small and readable.
- Scripts (`.ts`, `.js`, visual `.vgraph`) as they are.
- Assets as their bytes (size, mime, hash and image size are recomputed on the way in).
- Everything else in the repo (README, LICENSE, `.github/`, other dot-folders, `node_modules`…) isn't part of the project and is never touched.

A repo without `gamestudio.json` still opens, with default settings.

The link itself (owner, repo, branch, last commit, file hashes) is stored in the project
(`ProjectDoc.git`), changes only through the `set_git_link` and `put_scene` commands, syncs with
the cloud copy and is undoable like any edit.

## Commit, pull, branches

- **Commit** uploads only changed files and never force-pushes. If GitHub moved on, you get
  `E_NOT_FAST_FORWARD`: pull first. Deleting 10 or more files needs an explicit confirmation
  (`E_MASS_DELETE`; MCP also asks you in the editor when "ask before deleting" is on). You can
  commit to a new branch (`E_BRANCH_EXISTS` if it's taken).
- **Pull** takes changes made only on GitHub. If both sides changed:
  - scripts are merged line by line (conflict markers where they overlap);
  - scenes and `gamestudio.json` are merged only when the changes don't overlap *and* the result
    is still a valid scene; otherwise your version is kept;
  - assets: your version is kept;
  - deleted on one side, changed on the other: reported, your version kept;
  - an invalid file on GitHub: your version kept (and it's never deleted by a later commit);
  - a scene deleted on GitHub but still used by another scene: kept.
  The pull is one undo step. A pull done by the AI shows up in open editors as "AI: Pull <branch>".
- **Branches**: all are listed; switching keeps your unsaved changes and takes the branch's
  version of everything else; new branches start at the project's commit. If the tracked branch
  was deleted (e.g. after its PR merged), the project moves back to the default branch.

## Deploying the game

The editor builds the web export (`apps/editor/src/export/web-export.ts`) and commits it to the
**`gh-pages`** branch under `docs/` (plus `README.md` and `docs/.nojekyll`). It's a normal
fast-forward commit on top of the previous build — never forced, only changed files uploaded —
and it keeps `.github/**`, `wrangler.jsonc` and `docs/CNAME` if you add them.

- **GitHub Pages**: Pages is switched on with source `gh-pages` / `docs`. (Private repos on free
  plans can't use Pages; GitHub's message is shown as is.)
- **Cloudflare Workers**: give it a Cloudflare API token (the "Edit Cloudflare Workers" template)
  and your Account ID. The token is checked with Cloudflare, then sealed into the repo's Actions
  secrets (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) with the repo's public key — Game Studio
  doesn't keep it in the browser. The build branch also gets a `wrangler.jsonc` (static assets from
  `./docs`) and `.github/workflows/deploy-cloudflare.yml`, which deploys on every push to
  `gh-pages`. The game's address is `https://<worker>.<your-subdomain>.workers.dev` when Cloudflare
  reports the subdomain.

Deploying needs Game Studio open (the build happens in the browser); an AI asking for a deploy
with no editor open gets `E_NO_EDITOR`.

### Workflows

- **check** — `.github/workflows/check.yml` on the project branch: every scene and
  `gamestudio.json` must be valid JSON, and scripts are syntax-checked with esbuild. Problems link
  to file and line.
- **cloudflare** — the deploy workflow above (on the build branch; needs a build first,
  `E_NO_BUILD`).

## Limits

Cloning in the cloud copy: up to 60 MB of project files; in the browser: up to 400 MB. Files over
50 MB are skipped, listed, and never deleted by commits.

## For AI assistants (MCP)

26 tools (`packages/mcp/src/tools-git.ts`, run on the cloud copy in `cloud/git.ts`):

| AI-connection level | Tools |
| --- | --- |
| Read | `git_repos`, `git_status`, `git_branches`, `git_pr_list`, `git_pr_get`, `ci_status`, `ci_run_details`, `ci_logs`, `deploy_status` |
| Edit | `git_clone` (not with "open project only"), `git_commit`, `git_pull`, `git_switch_branch`, `git_create_branch`, `git_create_pr`, `git_pr_update`, `git_repo_create`, `git_repo_update` (a rename keeps the project linked), `git_publish`, `ci_run`, `ci_rerun`, `ci_add_workflow` |
| Full | `git_pr_merge` (if the project's branch was merged and deleted, the project switches to the base branch), `git_repo_delete` (`confirm_name` must be exactly `owner/name`, and you're asked in the editor when "ask before deleting" is on; the project is unlinked), `ci_cloudflare_secrets`, `deploy_game` |

Error codes: `E_GITHUB_NOT_CONNECTED`, `E_GITHUB_AUTH`, `E_GITHUB_PERMISSION`,
`E_GITHUB_RATE_LIMIT`, `E_NOT_LINKED`, `E_NOT_FAST_FORWARD`, `E_MASS_DELETE`, `E_BRANCH_GONE`,
`E_BRANCH_EXISTS`, `E_MERGE_CONFLICT`, `E_CONFIRM`, `E_DECLINED`, `E_NO_BUILD`, `E_FORBIDDEN`,
`E_NO_EDITOR`.
