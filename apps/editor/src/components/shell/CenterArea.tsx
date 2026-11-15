/** Document tabs plus the active document (scene viewport or script editor), or the running game. */
import { lazy, Suspense } from 'react';
import { Clapperboard, FileCode2, Plus, X } from 'lucide-react';
import { basename } from '@gs/shared';
import { useEditor, type DocRef } from '@editor/store/editor';
import { useUi } from '@editor/store/ui';
import { usePlay } from '@editor/play/player-host';
import { Button, EmptyState, IconButton, cx } from '../ui/primitives';
import { PlayView } from '../play/PlayView';

const Viewport = lazy(() => import('../viewport/Viewport'));
const ScriptEditor = lazy(() => import('../script/ScriptEditor'));

function Tabs() {
  const docs = useEditor((s) => s.openDocs);
  const active = useEditor((s) => s.active);
  const mainScene = useEditor((s) => s.project?.settings.mainScene);
  const dirtyScripts = useEditor((s) => s.project?.scripts);
  void dirtyScripts;
  const { openDoc, closeDoc } = useEditor.getState();
  const isActive = (d: DocRef) => active?.kind === d.kind && active.path === d.path;
  return (
    <div className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-border bg-panel" role="tablist" data-testid="doc-tabs">
      {docs.map((d) => {
        const Icon = d.kind === 'scene' ? Clapperboard : FileCode2;
        return (
          <div key={`${d.kind}:${d.path}`} className={cx('group flex shrink-0 items-center border-r border-border', isActive(d) ? 'bg-bg text-text' : 'text-muted hover:text-text')}>
            <button role="tab" aria-selected={isActive(d)} className="touch-target flex h-full items-center gap-1.5 pl-3 pr-1 text-[12px]" onClick={() => openDoc(d)} title={d.path} data-testid={`tab-${d.path}`}>
              <Icon size={13} className={d.kind === 'scene' ? 'text-accent' : 'text-node-audio'} />
              {basename(d.path)}
              {d.kind === 'scene' && d.path === mainScene && <span className="text-[10px] text-faint">main</span>}
            </button>
            <IconButton label={`Close ${basename(d.path)}`} className="mr-1 h-6 min-w-6 opacity-60 group-hover:opacity-100" onClick={() => closeDoc(d)}>
              <X size={12} />
            </IconButton>
          </div>
        );
      })}
      <IconButton label="New scene" className="m-1" onClick={() => useUi.getState().set({ dialog: 'new-scene' })} data-testid="new-scene-tab">
        <Plus size={14} />
      </IconButton>
    </div>
  );
}

export function CenterArea() {
  const active = useEditor((s) => s.active);
  const status = usePlay((s) => s.status);
  const playing = status !== 'stopped';
  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      {!playing && <Tabs />}
      <div className="relative min-h-0 flex-1">
        {playing ? (
          <PlayView />
        ) : !active ? (
          <EmptyState icon={<Clapperboard size={28} className="text-faint" />} title="Nothing open">
            Open a scene or script from Files, or
            <div className="mt-3">
              <Button variant="primary" onClick={() => useUi.getState().set({ dialog: 'new-scene' })}>
                <Plus size={14} /> New scene
              </Button>
            </div>
          </EmptyState>
        ) : (
          <Suspense fallback={<div className="flex h-full items-center justify-center text-muted">Loading…</div>}>{active.kind === 'scene' ? <Viewport key={active.path} scenePath={active.path} /> : <ScriptEditor key={active.path} path={active.path} />}</Suspense>
        )}
      </div>
    </div>
  );
}
