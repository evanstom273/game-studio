/** Game and editor output. Repeated lines are collapsed with a count. */
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Info, Trash2, XCircle } from 'lucide-react';
import { useConsole, type ConsoleEntry } from '@editor/store/console';
import { IconButton, cx } from '../ui/primitives';

const ICON = { error: XCircle, warn: AlertTriangle, info: Info, log: null } as const;
const COLOR = { error: 'text-err', warn: 'text-warn', info: 'text-accent', log: 'text-text' } as const;

export function ConsoleView() {
  const entries = useConsole((s) => s.entries);
  const clear = useConsole((s) => s.clear);
  const [filter, setFilter] = useState<'all' | 'error' | 'warn'>('all');
  const end = useRef<HTMLDivElement>(null);
  const shown = entries.filter((e) => filter === 'all' || e.level === filter);
  useEffect(() => {
    // (scrollIntoView returns a Promise in recent Chromium; an effect must not return it.)
    end.current?.scrollIntoView({ block: 'end' });
  }, [shown.length]);
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-7 shrink-0 items-center gap-1 border-b border-border px-2 text-[11px]">
        {(['all', 'error', 'warn'] as const).map((f) => (
          <button key={f} onClick={() => setFilter(f)} className={cx('rounded px-2 py-0.5', filter === f ? 'bg-panel-3 text-text' : 'text-muted hover:text-text')}>
            {f === 'all' ? 'All' : f === 'error' ? 'Errors' : 'Warnings'}
          </button>
        ))}
        <div className="flex-1" />
        <IconButton label="Clear console" className="h-6 min-w-6" onClick={clear}>
          <Trash2 size={13} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-auto font-mono text-[12px]" data-testid="console" role="log">
        {shown.length === 0 && <div className="p-2 text-[12px] text-faint">Output from print(), errors and warnings appear here when you run the game.</div>}
        {shown.map((e) => (
          <Row key={e.id} e={e} />
        ))}
        <div ref={end} />
      </div>
    </div>
  );
}

function Row({ e }: { e: ConsoleEntry }) {
  const Icon = ICON[e.level];
  const [open, setOpen] = useState(false);
  return (
    <div className={cx('border-b border-border/40 px-2 py-0.5', e.level === 'error' && 'bg-err/5')} data-level={e.level}>
      <div className="flex items-start gap-1.5">
        <span className="w-3.5 shrink-0 pt-0.5">{Icon && <Icon size={12} className={COLOR[e.level]} />}</span>
        <span className={cx('min-w-0 flex-1 whitespace-pre-wrap break-words', COLOR[e.level])}>
          {e.message}
          {e.source && <span className="ml-2 text-faint">{e.source}</span>}
        </span>
        {e.repeat > 1 && <span className="shrink-0 rounded-full bg-panel-3 px-1.5 text-[10px] text-muted">{e.repeat}</span>}
        <span className="shrink-0 text-[10px] text-faint">{e.origin === 'game' ? 'game' : 'editor'}</span>
        {e.stack && (
          <button className="shrink-0 text-[10px] text-accent" onClick={() => setOpen(!open)}>
            {open ? 'hide' : 'stack'}
          </button>
        )}
      </div>
      {open && e.stack && <pre className="ml-5 overflow-auto text-[11px] text-muted">{e.stack}</pre>}
    </div>
  );
}
