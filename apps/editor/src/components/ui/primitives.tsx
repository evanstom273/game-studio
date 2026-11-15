/** Small UI building blocks shared by every panel (same look as Coding Studio / GUI Studio). */
import { forwardRef, useEffect, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import { X } from 'lucide-react';

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ');
}

type Variant = 'default' | 'primary' | 'danger' | 'ghost';

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }>(function Button({ variant = 'default', className, ...p }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      {...p}
      className={cx(
        'touch-target inline-flex items-center justify-center gap-1.5 rounded px-2.5 h-7 text-[12px] font-medium transition-colors disabled:opacity-40 disabled:pointer-events-none whitespace-nowrap',
        variant === 'primary' && 'bg-accent text-white hover:bg-accent-2',
        variant === 'danger' && 'bg-red-600/90 text-white hover:bg-red-600',
        variant === 'default' && 'bg-panel-2 border border-border text-text hover:bg-panel-3',
        variant === 'ghost' && 'text-muted hover:text-text hover:bg-panel-2',
        className,
      )}
    />
  );
});

export function IconButton({ label, children, active, className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      {...p}
      className={cx(
        'touch-target inline-flex shrink-0 items-center justify-center rounded h-7 min-w-7 px-1.5 gap-1 text-muted hover:text-text hover:bg-panel-2 disabled:opacity-35 disabled:pointer-events-none',
        active && 'text-accent bg-accent/15 hover:text-accent hover:bg-accent/20',
        className,
      )}
    >
      {children}
    </button>
  );
}

export const inputCls = 'gs-input w-full min-w-0 rounded border border-border bg-bg px-2 h-7 text-[12px] text-text placeholder:text-faint focus:border-accent focus:outline-none';

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function TextInput({ className, ...p }, ref) {
  return <input ref={ref} {...p} className={cx(inputCls, className)} />;
});

export function Select({ className, children, ...p }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...p} className={cx(inputCls, 'px-1', className)}>
      {children}
    </select>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="mb-3 block">
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-muted">{hint}</span>}
    </label>
  );
}

export function SectionHeader({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-border px-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
      <span className="truncate">{children}</span>
      {right && <div className="flex items-center gap-0.5 normal-case">{right}</div>}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-border-strong bg-panel-3 px-1 font-mono text-[10px] text-muted">{children}</kbd>;
}

/** Touch screen (phone, tablet): focusing a text field there pops the keyboard up, so never do it unasked. */
export const isTouch = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

export function Dialog({ title, onClose, children, footer, width = 520 }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close.current();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  // Once, when the dialog opens: only an element marked data-autofocus, and never on touch screens.
  useEffect(() => {
    if (!isTouch()) ref.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
  }, []);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/55 sm:items-center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="safe-bottom flex max-h-[92dvh] w-full flex-col rounded-t-xl border border-border bg-panel shadow-2xl sm:max-h-[85vh] sm:rounded-lg"
        style={{ maxWidth: `min(${width}px, 100vw)` }}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <h2 className="text-[14px] font-semibold">{title}</h2>
          <IconButton label="Close" onClick={onClose}>
            <X size={15} />
          </IconButton>
        </div>
        <div className="min-h-0 overflow-auto px-4 py-3">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-border px-4 py-2.5">{footer}</div>}
      </div>
    </div>
  );
}

/** Drag handle between panels. */
export function Splitter({ onDrag, vertical }: { onDrag: (delta: number) => void; vertical?: boolean }) {
  return (
    <div
      role="separator"
      aria-orientation={vertical ? 'horizontal' : 'vertical'}
      className={cx('relative shrink-0 bg-border/70 transition-colors hover:bg-accent', vertical ? 'h-[3px] cursor-row-resize' : 'w-[3px] cursor-col-resize')}
      onPointerDown={(e) => {
        e.preventDefault();
        let last = vertical ? e.clientY : e.clientX;
        const move = (ev: PointerEvent) => {
          const cur = vertical ? ev.clientY : ev.clientX;
          onDrag(cur - last);
          last = cur;
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      }}
    >
      <div className={cx('absolute', vertical ? '-top-2 -bottom-2 inset-x-0' : '-left-2 -right-2 inset-y-0')} />
    </div>
  );
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-muted">
      {icon}
      <div className="text-[13px] font-medium text-text">{title}</div>
      {children && <div className="max-w-xs text-[12px]">{children}</div>}
    </div>
  );
}
