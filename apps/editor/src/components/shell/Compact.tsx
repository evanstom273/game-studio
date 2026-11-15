/**
 * Phone layout pieces: a bottom navigation bar and a bottom sheet that holds one panel at a
 * time over the full-screen viewport. The sheet has three heights (peek, half, full) and is
 * resized or dismissed by dragging its handle.
 */
import { useRef } from 'react';
import { FolderTree, ListTree, Plus, SlidersHorizontal, Terminal } from 'lucide-react';
import { useUi, type Sheet } from '@editor/store/ui';
import { useEditor } from '@editor/store/editor';
import { useConsole } from '@editor/store/console';
import { cx } from '../ui/primitives';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { SceneTreePanel } from '../tree/SceneTreePanel';
import { Inspector } from '../inspector/Inspector';
import { FileBrowser } from '../files/FileBrowser';
import { BottomPanel } from './BottomPanel';
import { isVisualPath } from '../visual/store';
import { requestAddNode } from '../visual/commands';

const ITEMS: [Exclude<Sheet, null>, string, typeof ListTree][] = [
  ['scene', 'Scene', ListTree],
  ['inspector', 'Inspector', SlidersHorizontal],
  ['files', 'Files', FolderTree],
  ['console', 'Console', Terminal],
];

export function BottomNav() {
  const sheet = useUi((s) => s.sheet);
  const set = useUi((s) => s.set);
  const errors = useConsole((s) => s.entries.filter((e) => e.level === 'error').length);
  const sceneActive = useEditor((s) => s.active?.kind === 'scene');
  // A visual script is open: Add opens its add-node menu.
  const graphActive = useEditor((s) => s.active?.kind === 'script' && isVisualPath(s.active.path));
  return (
    <nav className="safe-bottom safe-x flex shrink-0 items-stretch border-t border-border bg-panel" data-testid="bottom-nav">
      {ITEMS.map(([id, label, Icon]) => (
        <button
          key={id}
          onClick={() => set({ sheet: sheet === id ? null : id, sheetSize: sheet === null ? 'half' : useUi.getState().sheetSize })}
          aria-pressed={sheet === id}
          className={cx('relative flex min-h-[52px] flex-1 flex-col items-center justify-center gap-0.5 text-[10px]', sheet === id ? 'text-accent' : 'text-muted')}
          data-testid={`nav-${id}`}
        >
          <Icon size={19} />
          {label}
          {id === 'console' && errors > 0 && <span className="absolute right-[calc(50%-18px)] top-1.5 h-2 w-2 rounded-full bg-err" />}
        </button>
      ))}
      <button onClick={() => (graphActive ? (set({ sheet: null }), requestAddNode()) : set({ dialog: 'add-node' }))} disabled={!sceneActive && !graphActive} className="flex min-h-[52px] flex-1 flex-col items-center justify-center gap-0.5 text-[10px] text-muted disabled:opacity-40" data-testid="nav-add">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent text-white">
          <Plus size={17} />
        </span>
        Add
      </button>
    </nav>
  );
}

const HEIGHTS = { peek: 0.34, half: 0.55, full: 0.94 } as const;

export function BottomSheet() {
  const sheet = useUi((s) => s.sheet);
  const size = useUi((s) => s.sheetSize);
  const set = useUi((s) => s.set);
  const ref = useRef<HTMLDivElement>(null);
  if (!sheet) return null;
  const onDragStart = (e: React.PointerEvent) => {
    const el = ref.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;
    e.preventDefault();
    const total = parent.clientHeight;
    const startY = e.clientY;
    const startH = el.clientHeight;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      el.style.height = `${Math.max(60, Math.min(total, startH - (ev.clientY - startY)))}px`;
    };
    const up = (ev: PointerEvent) => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      const frac = (startH - (ev.clientY - startY)) / total;
      el.style.height = '';
      if (frac < 0.2) set({ sheet: null });
      else set({ sheetSize: frac < 0.45 ? 'peek' : frac < 0.75 ? 'half' : 'full' });
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  };
  return (
    <div ref={ref} className="absolute inset-x-0 bottom-0 z-20 flex flex-col rounded-t-xl border-t border-border bg-panel shadow-[0_-12px_32px_rgba(0,0,0,0.45)]" style={{ height: `${HEIGHTS[size] * 100}%` }} data-testid="bottom-sheet" data-sheet={sheet}>
      <div className="flex h-6 shrink-0 cursor-grab touch-none items-center justify-center" onPointerDown={onDragStart} aria-label="Resize panel" role="separator">
        <div className="h-1 w-10 rounded-full bg-border-strong" />
      </div>
      <div className="min-h-0 flex-1">
        <ErrorBoundary label={sheet}>{sheet === 'scene' ? <SceneTreePanel /> : sheet === 'inspector' ? <Inspector /> : sheet === 'files' ? <FileBrowser /> : <BottomPanel />}</ErrorBoundary>
      </div>
    </div>
  );
}
