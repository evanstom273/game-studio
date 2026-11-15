/** Small pieces shared by the GitHub panels. */
import { useState, type ReactNode } from 'react';
import { CheckCircle2, CircleDashed, XCircle } from 'lucide-react';
import { errorMessage } from '@gs/shared';
import { toast } from '@editor/store/toasts';
import { cx } from '../ui/primitives';

export const errMsg = errorMessage;

export function StateIcon({ state, size = 13 }: { state: string; size?: number }) {
  if (state === 'running') return <CircleDashed size={size} className="shrink-0 animate-spin text-warn" />;
  if (state === 'passed') return <CheckCircle2 size={size} className="shrink-0 text-ok" />;
  if (state === 'failed') return <XCircle size={size} className="shrink-0 text-err" />;
  return <CircleDashed size={size} className="shrink-0 text-muted" />;
}

export function ago(iso: string | number) {
  const s = Math.max(0, (Date.now() - (typeof iso === 'number' ? iso : Date.parse(iso))) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** One action at a time per panel, with errors shown as toasts. */
export function useBusy() {
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what);
    try {
      await fn();
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(null);
    }
  };
  return { busy, run };
}

export function SectionLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-muted">
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {right && <span className="shrink-0 font-normal normal-case">{right}</span>}
    </div>
  );
}

export function Banner({ tone, children, testId }: { tone: 'warn' | 'err' | 'info'; children: ReactNode; testId?: string }) {
  return (
    <div className={cx('mx-3 my-2 rounded border px-3 py-2 text-[12px]', tone === 'err' ? 'border-err/40 bg-err/10' : tone === 'warn' ? 'border-warn/40 bg-warn/10' : 'border-accent/40 bg-accent/10')} data-testid={testId}>
      {children}
    </div>
  );
}

export const linkCls = 'text-accent hover:underline';
