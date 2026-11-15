/**
 * Deploy the playable game: the web export is built here and published to the repository's web
 * build branch, then served by GitHub Pages or deployed to Cloudflare Workers by a workflow.
 */
import { useCallback, useEffect, useState } from 'react';
import { Cloud, ExternalLink, Globe, Rocket } from 'lucide-react';
import type { GitLink } from '@gs/project';
import { BUILD_BRANCH, deployStatus, workerName, type DeployStatus, type DeployTarget } from '@gs/git';
import { toast } from '@editor/store/toasts';
import { cloudflareStatus, github, type CloudflareStatus } from '@editor/git/api';
import { deployOpen, type DeployResult } from '@editor/git/deploy';
import { Button, TextInput, cx } from '../ui/primitives';
import { Banner, SectionLabel, StateIcon, errMsg, linkCls } from './common';
import { CloudflareCard } from './CloudflareCard';

export function DeployTab({ link }: { link: GitLink }) {
  const [st, setSt] = useState<DeployStatus | null>(null);
  const [cf, setCf] = useState<CloudflareStatus | null>(null);
  const [worker, setWorker] = useState(workerName(link.repo));
  const [busy, setBusy] = useState<DeployTarget | null>(null);
  const [step, setStep] = useState('');
  const [result, setResult] = useState<DeployResult | null>(null);
  const refresh = useCallback(() => {
    deployStatus(github(), link.owner, link.repo).then(setSt, (e) => toast('error', errMsg(e)));
  }, [link.owner, link.repo]);
  useEffect(() => {
    refresh();
    cloudflareStatus().then(setCf, () => setCf({ configured: false }));
  }, [refresh]);

  const deploy = async (target: DeployTarget) => {
    setBusy(target);
    setResult(null);
    try {
      const r = await deployOpen(target, { workerName: worker, onProgress: setStep });
      setResult(r);
      toast('success', r.unchanged ? 'The published build is already up to date' : `Published the web build to ${r.branch}`);
      refresh();
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(null);
      setStep('');
    }
  };

  const run = st?.cloudflare.last_run;
  return (
    <div className="min-h-0 flex-1 overflow-auto pb-3 text-[12px]" data-testid="deploy-panel">
      <p className="px-3 pt-3 text-muted">
        Deploying builds the playable web export of this project as it is now (uncommitted changes included) and publishes it to the <span className="font-mono text-text">{BUILD_BRANCH}</span> branch of {link.owner}/{link.repo}, under <span className="font-mono">docs/</span>. Your project's branches aren't touched.
      </p>
      {result && (
        <Banner tone="info" testId="deploy-result">
          <div className="font-medium">{result.target === 'github-pages' ? 'GitHub Pages' : 'Cloudflare'}: {result.unchanged ? 'already up to date' : `published ${result.files} files (${result.uploaded} changed)`}</div>
          {result.url && (
            <a className={cx(linkCls, 'flex items-center gap-1 break-all')} href={result.url} target="_blank" rel="noreferrer" data-testid="deploy-url">
              <ExternalLink size={12} className="shrink-0" /> {result.url}
            </a>
          )}
          <div className="text-muted">{result.note}</div>
        </Banner>
      )}
      {busy && step && <div className="px-3 py-1 text-accent" data-testid="deploy-progress">{step}</div>}

      <SectionLabel>
        <span className="inline-flex items-center gap-1.5">
          <Globe size={12} /> GitHub Pages
        </span>
      </SectionLabel>
      <div className="space-y-1.5 px-3">
        {st?.pages.enabled ? (
          <div className="text-muted" data-testid="pages-status">
            Live at{' '}
            <a className={linkCls} href={st.pages.url} target="_blank" rel="noreferrer">
              {st.pages.url}
            </a>
            {st.pages.serves_build ? '' : ` (serving ${st.pages.source?.branch}${st.pages.source?.path}; deploying points it at the web build)`}
          </div>
        ) : (
          <div className="text-muted">Not on yet. The first deploy turns GitHub Pages on (free for public repositories; private ones need a paid GitHub plan).</div>
        )}
        <Button variant="primary" className="w-full" disabled={!!busy} onClick={() => void deploy('github-pages')} data-testid="deploy-pages">
          <Rocket size={13} /> {busy === 'github-pages' ? 'Deploying…' : 'Deploy to GitHub Pages'}
        </Button>
      </div>

      <SectionLabel>
        <span className="inline-flex items-center gap-1.5">
          <Cloud size={12} /> Cloudflare Workers
        </span>
      </SectionLabel>
      <CloudflareCard status={cf} onChange={setCf} />
      <div className="mt-2 space-y-1.5 px-3">
        <label className="block">
          <span className="mb-1 block text-[11px] text-muted">Worker name (its address is &lt;name&gt;.&lt;your-subdomain&gt;.workers.dev)</span>
          <TextInput value={worker} onChange={(e) => setWorker(e.target.value)} onBlur={() => setWorker(workerName(worker))} data-testid="deploy-worker" />
        </label>
        {run && (
          <div className="flex items-center gap-1.5 text-muted" data-testid="cloudflare-run">
            <StateIcon state={run.state} /> Last Cloudflare deploy: {run.state}
            <a className={cx(linkCls, 'ml-auto')} href={run.url} target="_blank" rel="noreferrer">
              details
            </a>
          </div>
        )}
        <Button variant="primary" className="w-full" disabled={!!busy || !cf?.configured} onClick={() => void deploy('cloudflare')} data-testid="deploy-cloudflare">
          <Rocket size={13} /> {busy === 'cloudflare' ? 'Deploying…' : cf?.configured ? 'Deploy to Cloudflare' : 'Connect Cloudflare above to deploy there'}
        </Button>
        <p className="text-[11px] text-muted">The web build branch gets a "Deploy to Cloudflare" workflow (GitHub Actions) that uploads the game with Wrangler using the secrets CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, which Game Studio sets for you. Needs the token's Workflows, Secrets and Actions permissions.</p>
      </div>
    </div>
  );
}
