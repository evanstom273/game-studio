/** Toasts and confirmation dialogs (promise-based, usable from services and the MCP bridge). */
import type { ReactNode } from 'react';
import { create } from 'zustand';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { dismissToast, useToasts } from '@editor/store/toasts';
import { Button, Dialog, IconButton, cx } from './primitives';

interface ConfirmReq {
  title: string;
  message: ReactNode;
  confirm: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}

const useConfirm = create<{ queue: ConfirmReq[] }>()(() => ({ queue: [] }));

export function confirmDialog(opts: Omit<ConfirmReq, 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => useConfirm.setState((s) => ({ queue: [...s.queue, { ...opts, resolve }] })));
}

export function ConfirmHost() {
  const req = useConfirm((s) => s.queue[0]);
  if (!req) return null;
  const done = (ok: boolean) => {
    useConfirm.setState((s) => ({ queue: s.queue.slice(1) }));
    req.resolve(ok);
  };
  return (
    <Dialog
      title={req.title}
      onClose={() => done(false)}
      width={440}
      footer={
        <>
          <Button onClick={() => done(false)}>Cancel</Button>
          <Button variant={req.danger ? 'danger' : 'primary'} onClick={() => done(true)} data-testid="confirm-ok" data-autofocus>
            {req.confirm}
          </Button>
        </>
      }
    >
      <div className="text-[13px] leading-relaxed text-text">{req.message}</div>
    </Dialog>
  );
}

const ICONS = { info: Info, success: CheckCircle2, warning: AlertTriangle, error: XCircle };
const COLORS = { info: 'text-accent', success: 'text-ok', warning: 'text-warn', error: 'text-err' };

export function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-16 z-[60] flex flex-col items-center gap-2 px-3 sm:bottom-10" aria-live="polite">
      {toasts.map((t) => {
        const Icon = ICONS[t.kind];
        return (
          <div key={t.id} role="status" className="pointer-events-auto flex max-w-[min(560px,100%)] items-start gap-2 rounded-lg border border-border bg-panel-2 px-3 py-2 text-[12px] shadow-2xl">
            <Icon size={15} className={cx('mt-px shrink-0', COLORS[t.kind])} />
            <span className="min-w-0 flex-1 leading-snug">{t.text}</span>
            {t.action && (
              <button
                className="shrink-0 font-semibold text-accent hover:underline"
                onClick={() => {
                  t.action!.run();
                  dismissToast(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
            <IconButton label="Dismiss" className="-my-1 -mr-1.5 h-6 min-w-6" onClick={() => dismissToast(t.id)}>
              <X size={13} />
            </IconButton>
          </div>
        );
      })}
    </div>
  );
}
