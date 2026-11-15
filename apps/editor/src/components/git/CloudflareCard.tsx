/**
 * Cloudflare deploy credentials: entered once (for every project), kept server-side next to the
 * GitHub token, and only ever written — sealed — into a repository's GitHub Actions secrets.
 */
import { useState } from 'react';
import { Cloud } from 'lucide-react';
import { toast } from '@editor/store/toasts';
import { forgetCloudflare, saveCloudflare, type CloudflareStatus } from '@editor/git/api';
import { Button, TextInput } from '../ui/primitives';
import { errMsg, linkCls } from './common';

export function CloudflareCard({ status, onChange }: { status: CloudflareStatus | null; onChange: (s: CloudflareStatus) => void }) {
  const [token, setToken] = useState('');
  const [account, setAccount] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  if (!status) return <div className="px-3 text-muted">Checking Cloudflare…</div>;
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
    <div className="mx-3 rounded border border-border p-2.5" data-testid="cloudflare-card">
      <div className="mb-1 flex items-center gap-1.5 font-medium">
        <Cloud size={13} className="text-node-audio" /> Cloudflare account
      </div>
      {status.configured && !editing ? (
        <div className="space-y-1.5">
          <p className="text-[11.5px] text-muted" data-testid="cloudflare-connected">
            Connected (account …{status.accountId?.slice(-6)}). Deploying puts the token into this repository's secrets for the deploy workflow; it's never shown again.
          </p>
          <div className="flex gap-3 text-[11.5px]">
            <button className={linkCls} onClick={() => setEditing(true)}>
              Change token
            </button>
            <button className="text-muted hover:text-err" onClick={() => run(async () => onChange(await forgetCloudflare()))}>
              Disconnect
            </button>
          </div>
        </div>
      ) : (
        <form
          className="space-y-1.5"
          data-testid="cloudflare-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              onChange(await saveCloudflare(token, account));
              setToken('');
              setAccount('');
              setEditing(false);
              toast('success', 'Cloudflare connected');
            });
          }}
        >
          <p className="text-[11.5px] leading-snug text-muted">
            Once, for all your projects: in the Cloudflare dashboard go to <b className="text-text">My Profile → API Tokens → Create Token</b>, use the <b className="text-text">“Edit Cloudflare Workers”</b> template, and paste it here with your <b className="text-text">Account ID</b> (Workers &amp; Pages page, right-hand side). It's kept in your own Game Studio cloud storage.
          </p>
          <TextInput type="password" autoComplete="off" placeholder="Cloudflare API token" value={token} onChange={(e) => setToken(e.target.value)} data-testid="cloudflare-token" aria-label="Cloudflare API token" />
          <TextInput autoComplete="off" placeholder="Account ID (32 characters)" value={account} onChange={(e) => setAccount(e.target.value)} data-testid="cloudflare-account" aria-label="Cloudflare account ID" />
          <div className="flex gap-1.5">
            <Button type="submit" className="flex-1" variant="primary" disabled={busy || !token.trim() || !account.trim()} data-testid="cloudflare-save">
              {busy ? 'Checking…' : 'Save'}
            </Button>
            {editing && (
              <Button variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
