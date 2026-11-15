/** Connect GitHub with a fine-grained personal access token (kept server-side, never in this browser). */
import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { toast } from '@editor/store/toasts';
import { saveToken } from '@editor/git/api';
import { useGitHubAuth } from '@editor/git/store';
import { Button, TextInput } from '../ui/primitives';
import { errMsg, linkCls } from './common';

export const TOKEN_PERMISSIONS: [string, string][] = [
  ['Contents', 'commit, pull, branches, publishing builds'],
  ['Pull requests', 'open, merge and close pull requests'],
  ['Workflows', 'add GitHub Actions workflows (check, Cloudflare deploy)'],
  ['Actions', 'run and re-run workflows, read logs'],
  ['Pages', 'turn on GitHub Pages for the game'],
  ['Secrets', 'set the Cloudflare deploy secrets for you'],
  ['Administration', 'create, rename and delete repositories'],
];

export function TokenForm({ onDone }: { onDone?: (login: string) => void }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const connect = async () => {
    setBusy(true);
    try {
      const r = await saveToken(token);
      setToken('');
      useGitHubAuth.getState().connected(r.login);
      toast('success', `Connected to GitHub as ${r.login}`);
      onDone?.(r.login);
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="space-y-2 text-[12px]" data-testid="github-token-form" onSubmit={(e) => (e.preventDefault(), token.trim() && void connect())}>
      <p className="text-muted">
        Connect GitHub with a{' '}
        <a className={linkCls} href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">
          fine-grained personal access token
        </a>{' '}
        for the repositories you want to use (or <b className="text-text">All repositories</b>), with these permissions set to <b className="text-text">Read and write</b>:
      </p>
      <ul className="space-y-0.5 pl-1 text-muted">
        {TOKEN_PERMISSIONS.map(([name, why]) => (
          <li key={name}>
            <b className="text-text">{name}</b> — {why}
          </li>
        ))}
      </ul>
      <p className="text-muted">Only Contents and Pull requests are needed for commit, pull and pull requests. The token is kept in your own Game Studio cloud storage, never in this browser or in your projects, and is only sent to GitHub.</p>
      <div className="flex gap-2">
        <TextInput type="password" autoComplete="off" placeholder="github_pat_…" value={token} onChange={(e) => setToken(e.target.value)} data-testid="github-token" aria-label="GitHub token" />
        <Button type="submit" variant="primary" disabled={!token.trim() || busy} data-testid="github-token-save">
          <KeyRound size={13} /> {busy ? 'Checking…' : 'Connect'}
        </Button>
      </div>
    </form>
  );
}
