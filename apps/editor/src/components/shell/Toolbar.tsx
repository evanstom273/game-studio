/** Top bar: projects, project name and save state, tools, undo/redo, play controls, menu. */
import { useState } from 'react';
import { Archive, Bot, ChevronLeft, Download, Keyboard, MoreVertical, MousePointer2, Move, Pause, Play, PlaySquare, Redo2, RotateCw, Scaling, Settings, Square, Undo2 } from 'lucide-react';
import { navigate } from '@editor/lib/router';
import { useEditor } from '@editor/store/editor';
import { useUi, type Tool } from '@editor/store/ui';
import { useSaveStatus } from '@editor/services/autosave';
import { usePlay } from '@editor/play/player-host';
import { useBridge } from '@editor/bridge/client';
import { pause, play, redo, setTool, stop, undo } from '@editor/lib/actions';
import { IconButton, cx } from '../ui/primitives';

const TOOLS: [Tool, string, typeof Move, string][] = [
  ['select', 'Select (Q)', MousePointer2, 'tool-select'],
  ['move', 'Move (W)', Move, 'tool-move'],
  ['rotate', 'Rotate (E)', RotateCw, 'tool-rotate'],
  ['scale', 'Scale (R)', Scaling, 'tool-scale'],
];

export function ToolButtons({ className }: { className?: string }) {
  const tool = useUi((s) => s.tool);
  return (
    <div className={cx('flex items-center gap-0.5', className)} role="toolbar" aria-label="Transform tools">
      {TOOLS.map(([id, label, Icon, testId]) => (
        <IconButton key={id} label={label} active={tool === id} onClick={() => setTool(id)} data-testid={testId}>
          <Icon size={15} />
        </IconButton>
      ))}
    </div>
  );
}

export function PlayButtons() {
  const status = usePlay((s) => s.status);
  const playing = status === 'running' || status === 'paused' || status === 'starting';
  return (
    <div className="flex items-center gap-0.5" role="toolbar" aria-label="Play">
      <IconButton label="Play the main scene (F5)" onClick={() => void play('main')} active={playing} data-testid="play-main">
        <Play size={15} className={playing ? undefined : 'text-ok'} />
      </IconButton>
      <IconButton label="Play this scene (F6)" onClick={() => void play('current')} data-testid="play-current">
        <PlaySquare size={15} />
      </IconButton>
      <IconButton label={status === 'paused' ? 'Resume' : 'Pause'} onClick={pause} disabled={status !== 'running' && status !== 'paused'} active={status === 'paused'} data-testid="pause">
        <Pause size={15} />
      </IconButton>
      <IconButton label="Stop (F8)" onClick={stop} disabled={status === 'stopped'} data-testid="stop">
        <Square size={14} className={status !== 'stopped' ? 'text-err' : undefined} />
      </IconButton>
    </div>
  );
}

function SaveDot() {
  const state = useSaveStatus((s) => s.state);
  const label = state === 'saved' ? 'All changes saved' : state === 'error' ? 'Saving failed' : 'Saving…';
  return <span title={label} aria-label={label} data-testid="save-state" data-state={state} className={cx('inline-block h-2 w-2 shrink-0 rounded-full', state === 'saved' ? 'bg-ok/70' : state === 'error' ? 'bg-err' : 'bg-warn')} />;
}

export function Toolbar({ compact }: { compact: boolean }) {
  const name = useEditor((s) => s.project?.name ?? '');
  const canUndo = useEditor((s) => s.history.past.length > 0);
  const canRedo = useEditor((s) => s.history.future.length > 0);
  const sceneActive = useEditor((s) => s.active?.kind === 'scene');
  const set = useUi((s) => s.set);
  const bridge = useBridge((s) => s.status);
  const [menu, setMenu] = useState(false);
  const item = (Icon: typeof Move, label: string, fn: () => void, testId?: string) => (
    <button role="menuitem" className="touch-target flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12px] hover:bg-panel-3" onClick={() => (setMenu(false), fn())} data-testid={testId}>
      <Icon size={14} className="text-muted" /> {label}
    </button>
  );
  return (
    <header className="safe-top safe-x relative flex h-11 shrink-0 items-center gap-1 border-b border-border bg-panel px-1.5" data-testid="toolbar">
      <IconButton label="Projects" onClick={() => navigate({ name: 'dashboard' })} data-testid="back-to-projects">
        <ChevronLeft size={16} />
      </IconButton>
      <div className="flex min-w-0 items-center gap-1.5 px-1">
        <span className="truncate text-[13px] font-semibold" data-testid="project-title">
          {name}
        </span>
        <SaveDot />
      </div>
      {!compact && sceneActive && (
        <>
          <div className="mx-1.5 h-5 w-px bg-border" />
          <ToolButtons />
        </>
      )}
      <div className="mx-1 h-5 w-px bg-border" />
      <IconButton label="Undo (Ctrl+Z)" onClick={undo} disabled={!canUndo} data-testid="undo">
        <Undo2 size={15} />
      </IconButton>
      <IconButton label="Redo (Ctrl+Shift+Z)" onClick={redo} disabled={!canRedo} data-testid="redo">
        <Redo2 size={15} />
      </IconButton>
      <div className="flex-1" />
      <PlayButtons />
      <IconButton label="AI connection" onClick={() => set({ dialog: 'mcp' })} data-testid="toolbar-mcp">
        <Bot size={16} className={bridge === 'connected' ? 'text-ok' : bridge === 'off' ? undefined : 'text-warn'} />
      </IconButton>
      <IconButton label="Menu" onClick={() => setMenu((m) => !m)} data-testid="menu">
        <MoreVertical size={16} />
      </IconButton>
      {menu && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setMenu(false)} />
          <div className="absolute right-1.5 top-10 z-40 w-56 overflow-hidden rounded-md border border-border bg-panel-2 py-1 shadow-2xl" role="menu">
            {item(Settings, 'Project settings', () => set({ dialog: 'settings' }), 'menu-settings')}
            {item(Download, 'Export…', () => set({ dialog: 'export' }), 'menu-export')}
            {item(Archive, 'Backups', () => set({ dialog: 'backups' }))}
            {item(Bot, 'AI connection (MCP)', () => set({ dialog: 'mcp' }))}
            {item(Keyboard, 'Keyboard shortcuts', () => set({ dialog: 'shortcuts' }))}
          </div>
        </>
      )}
    </header>
  );
}
