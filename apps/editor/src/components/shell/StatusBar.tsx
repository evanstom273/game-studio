import { AlertTriangle, XCircle } from 'lucide-react';
import { useEditor } from '@editor/store/editor';
import { useConsole } from '@editor/store/console';
import { usePlay } from '@editor/play/player-host';
import { useSaveStatus } from '@editor/services/autosave';
import { useUi } from '@editor/store/ui';
import { useLayout } from '@editor/lib/layout';

export function StatusBar() {
  const active = useEditor((s) => s.active);
  const selection = useEditor((s) => s.selection.length);
  const errors = useConsole((s) => s.entries.filter((e) => e.level === 'error').length);
  const warns = useConsole((s) => s.entries.filter((e) => e.level === 'warn').length);
  const play = usePlay((s) => s);
  const save = useSaveStatus((s) => s);
  const layout = useLayout();
  const set = useUi((s) => s.set);
  return (
    <footer className="safe-x safe-bottom flex h-6 shrink-0 items-center gap-3 border-t border-border bg-panel px-2.5 text-[11px] text-muted" data-testid="status-bar">
      <span className="truncate">{active ? active.path : 'No document'}</span>
      {selection > 0 && <span>{selection} selected</span>}
      <div className="flex-1" />
      {play.status !== 'stopped' && (
        <span className={play.status === 'failed' ? 'text-err' : 'text-ok'}>
          {play.status === 'running' ? `▶ ${play.scene} · ${play.fps} fps · ${play.nodes} nodes` : play.status === 'failed' ? 'Game failed' : play.status}
        </span>
      )}
      <button className="flex items-center gap-1 hover:text-text" onClick={() => set({ bottomOpen: true, bottomTab: 'console' })}>
        <XCircle size={12} className={errors ? 'text-err' : undefined} /> {errors}
        <AlertTriangle size={12} className={warns ? 'text-warn' : undefined} /> {warns}
      </button>
      <span>{save.state === 'saved' ? 'Saved' : save.state === 'error' ? 'Not saved' : 'Saving…'}</span>
      <span className="hidden sm:inline" title="Layout chosen from the available space">
        {layout.mode} · {layout.width}×{layout.height}
      </span>
    </footer>
  );
}
