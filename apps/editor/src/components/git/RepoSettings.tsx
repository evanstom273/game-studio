/** Rename a repository, change its description, visibility or default branch, or delete it. */
import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { githubCall } from '@gs/git';
import { github } from '@editor/git/api';
import { toast } from '@editor/store/toasts';
import { Button, Field, Select, TextInput } from '../ui/primitives';
import { confirmDialog } from '../ui/feedback';
import { errMsg } from './common';

interface Info {
  name: string;
  description: string;
  private: boolean;
  default_branch: string;
  branches: string[];
}

export function RepoSettings({ owner, repo, onChanged }: { owner: string; repo: string; onChanged: (fullName: string | null) => void }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const full = `${owner}/${repo}`;
  useEffect(() => {
    const gh = github();
    void Promise.all([gh.repo(owner, repo), gh.branches(owner, repo)])
      .then(([r, bs]) => setInfo({ name: r.name, description: r.description ?? '', private: r.private, default_branch: r.default_branch, branches: bs.map((b) => b.name) }))
      .catch((e) => toast('error', errMsg(e)));
  }, [owner, repo]);
  if (!info) return <div className="px-3 py-3 text-muted">Loading…</div>;
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-1 px-3 py-3 text-[12px]" data-testid="repo-settings">
      <Field label="Name">
        <TextInput value={info.name} onChange={(e) => setInfo({ ...info, name: e.target.value })} data-testid="repo-name" />
      </Field>
      <Field label="Description">
        <TextInput value={info.description} onChange={(e) => setInfo({ ...info, description: e.target.value })} data-testid="repo-description" />
      </Field>
      <Field label="Default branch">
        <Select value={info.default_branch} onChange={(e) => setInfo({ ...info, default_branch: e.target.value })}>
          {info.branches.map((b) => (
            <option key={b}>{b}</option>
          ))}
        </Select>
      </Field>
      <label className="mb-3 flex items-center gap-2">
        <input type="checkbox" className="accent-[var(--color-accent)]" checked={info.private} onChange={(e) => setInfo({ ...info, private: e.target.checked })} data-testid="repo-private" /> Private
      </label>
      <Button
        className="w-full"
        disabled={busy || !/^[\w.-]{1,100}$/.test(info.name)}
        data-testid="repo-save"
        onClick={() =>
          run(async () => {
            const r = (await githubCall('git_repo_update', github(), { repository: full, name: info.name, description: info.description, private: info.private, default_branch: info.default_branch }, null)) as { repository: string };
            toast('success', `Saved ${r.repository}`);
            if (r.repository !== full) onChanged(r.repository);
          })
        }
      >
        Save repository settings
      </Button>
      <div className="mt-4 space-y-1.5 rounded border border-err/40 p-2.5">
        <div className="font-medium text-err">Delete this repository</div>
        <p className="text-[11.5px] text-muted">
          Removes it from GitHub for good: code, history, issues, pull requests. Projects in Game Studio stay, unlinked. Type <b className="font-mono text-text">{full}</b> to confirm.
        </p>
        <TextInput value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder={full} data-testid="repo-delete-confirm" aria-label="Repository name to confirm" />
        <Button
          variant="danger"
          className="w-full"
          disabled={busy || confirmName !== full}
          data-testid="repo-delete"
          onClick={() =>
            run(async () => {
              const ok = await confirmDialog({ title: `Delete ${full}?`, message: `This permanently deletes ${full} on GitHub. It can't be undone.`, confirm: 'Delete repository', danger: true });
              if (!ok) return;
              await githubCall('git_repo_delete', github(), { repository: full, confirm_name: confirmName }, null, async () => true);
              toast('success', `Deleted ${full}`);
              onChanged(null);
            })
          }
        >
          <Trash2 size={13} /> Delete {full}
        </Button>
      </div>
    </div>
  );
}
