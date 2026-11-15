/** AI connection (MCP): switch it on, copy the link, choose what the AI may do, see what it did. */
import { useState } from 'react';
import { Check, Copy, RefreshCw } from 'lucide-react';
import { mcpUrl, useBridge, type BridgePermissions } from '@editor/bridge/client';
import { Button, Dialog, Select, cx } from '../ui/primitives';
import { confirmDialog } from '../ui/feedback';

const STATUS_COLOR: Record<string, string> = { connected: 'bg-ok', connecting: 'bg-warn', offline: 'bg-warn', busy: 'bg-warn', revoked: 'bg-err', off: 'bg-faint' };

function CopyField({ value, label, testId }: { value: string; label: string; testId?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-stretch gap-1.5">
      <code className="min-w-0 flex-1 truncate rounded border border-border bg-bg px-2 py-1.5 font-mono text-[11px]" data-testid={testId} title={value}>
        {value}
      </code>
      <Button
        aria-label={label}
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? <Check size={14} className="text-ok" /> : <Copy size={14} />}
      </Button>
    </div>
  );
}

export function McpDialog({ onClose }: { onClose: () => void }) {
  const b = useBridge();
  const url = mcpUrl(b.key);
  const p = b.permissions;
  const set = (patch: Partial<BridgePermissions>) => b.setPermissions(patch);
  return (
    <Dialog title="AI connection (MCP)" onClose={onClose} width={620}>
      <p className="mb-3 text-[12px] leading-relaxed text-muted">
        Let an AI assistant — Claude (claude.ai, the desktop and phone apps, Claude Code) or ChatGPT where custom MCP connectors are available — build games in this editor: create scenes and nodes, write scripts, run the game and read its errors. Every change appears here and can be undone.
      </p>
      <label className="mb-3 flex items-center gap-3 rounded-md border border-border bg-panel-2 p-3">
        <input type="checkbox" className="h-4 w-4 accent-[var(--color-accent)]" checked={b.enabled} onChange={(e) => b.setEnabled(e.target.checked)} data-testid="mcp-toggle" />
        <div className="flex-1">
          <div className="text-[13px] font-medium">Allow AI assistants to control this editor</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted">
            <span className={cx('inline-block h-2 w-2 rounded-full', STATUS_COLOR[b.status] ?? 'bg-faint')} />
            <span data-testid="mcp-status">{b.statusText}</span>
          </div>
        </div>
        {b.status === 'busy' && <Button onClick={() => b.takeOver()}>Take over</Button>}
      </label>

      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">Your connector link</div>
      <CopyField value={url} label="Copy link" testId="mcp-url" />
      <div className="mt-1 mb-3 flex items-center justify-between gap-2 text-[11px] text-muted">
        <span>Anyone with this link can use the connection while it is on. Keep it private.</span>
        <Button
          variant="ghost"
          className="shrink-0"
          onClick={async () => {
            if (await confirmDialog({ title: 'Make a new link?', message: 'The current link stops working. You will need to add the new one to your AI apps.', confirm: 'New link' })) b.newKey();
          }}
        >
          <RefreshCw size={13} /> New link
        </Button>
      </div>

      <details className="mb-3 rounded-md border border-border bg-panel-2 p-3 text-[12px] leading-relaxed" open>
        <summary className="cursor-pointer font-medium">How to connect</summary>
        <ul className="mt-2 list-disc space-y-1.5 pl-5 text-muted">
          <li>
            <b className="text-text">Claude (claude.ai, desktop, phone):</b> Settings → Connectors → Add custom connector → paste the link. Leave authentication empty.
          </li>
          <li>
            <b className="text-text">Claude Code:</b>
            <div className="mt-1">
              <CopyField value={`claude mcp add --transport http game-studio ${url}`} label="Copy command" />
            </div>
          </li>
          <li>
            <b className="text-text">ChatGPT:</b> in a plan/workspace with developer mode, add a custom connector (MCP server URL = the link, no authentication).
          </li>
          <li>Then ask, for example: “Create a new 3D scene with a floor, a sun and a controllable character, run it and tell me about any errors.”</li>
        </ul>
        <p className="mt-2 text-[11px] text-faint">The AI talks to this tab: keep Game Studio open (on phones, browsers pause background tabs, so switch back if it seems stuck).</p>
      </details>

      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">What the AI may do</div>
      <div className="mb-3 grid gap-2 sm:grid-cols-2">
        <Select value={p.level} onChange={(e) => set({ level: e.target.value as BridgePermissions['level'] })} aria-label="Permission level" data-testid="mcp-level">
          <option value="read">Look only (read projects)</option>
          <option value="edit">Edit projects</option>
          <option value="full">Edit, run and export games</option>
        </Select>
        <Select value={p.scope} onChange={(e) => set({ scope: e.target.value as BridgePermissions['scope'] })} aria-label="Project scope">
          <option value="open-project">Only the project that is open</option>
          <option value="all-projects">All projects in this browser</option>
        </Select>
        <label className="flex items-center gap-2 text-[12px] sm:col-span-2">
          <input type="checkbox" className="accent-[var(--color-accent)]" checked={p.confirmDestructive} onChange={(e) => set({ confirmDestructive: e.target.checked })} />
          Ask me before the AI deletes scenes
        </label>
      </div>

      <div className="mb-1 flex items-center justify-between text-[11px] font-medium uppercase tracking-wide text-muted">
        <span>Activity</span>
        {b.log.length > 0 && (
          <button className="normal-case text-accent hover:underline" onClick={b.clearLog}>
            Clear
          </button>
        )}
      </div>
      <div className="max-h-40 overflow-auto rounded border border-border bg-bg font-mono text-[11px]" data-testid="mcp-log">
        {b.log.length === 0 ? (
          <div className="p-2 text-faint">No requests yet.</div>
        ) : (
          [...b.log].reverse().map((e, i) => (
            <div key={i} className="flex gap-2 border-b border-border/50 px-2 py-1 last:border-0">
              <span className="text-faint">{new Date(e.at).toLocaleTimeString()}</span>
              <span className={e.ok ? 'text-ok' : 'text-err'}>{e.method}</span>
              <span className="text-faint">{e.ms} ms</span>
              <span className="truncate text-muted">{e.summary}</span>
            </div>
          ))
        )}
      </div>
    </Dialog>
  );
}
