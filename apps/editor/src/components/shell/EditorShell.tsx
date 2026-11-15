/**
 * The editor. One set of panels, arranged per layout (see lib/layout.ts):
 *
 *   wide     toolbar · [scene tree / files | viewport + bottom panel | inspector] · status bar
 *   medium   toolbar · [viewport + bottom panel | tabbed dock: Scene / Inspector / Files]
 *   split    foldables spanning two segments: viewport on one, the tabbed dock on the other
 *   compact  phones: full-screen viewport, bottom navigation, panels in a resizable bottom sheet
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useEditor } from '@editor/store/editor';
import { useUi } from '@editor/store/ui';
import { useLayout } from '@editor/lib/layout';
import { navigate } from '@editor/lib/router';
import { openProjectById } from '@editor/services/editor-service';
import { useShortcuts } from '@editor/lib/shortcuts';
import { Button, Splitter, cx } from '../ui/primitives';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { Toolbar } from './Toolbar';
import { StatusBar } from './StatusBar';
import { CenterArea } from './CenterArea';
import { BottomPanel } from './BottomPanel';
import { BottomNav, BottomSheet } from './Compact';
import { SceneTreePanel } from '../tree/SceneTreePanel';
import { Inspector } from '../inspector/Inspector';
import { FileBrowser } from '../files/FileBrowser';
import { Dialogs } from '../dialogs/Dialogs';

function Panel({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <ErrorBoundary label={label}>{children}</ErrorBoundary>
    </div>
  );
}

function Dock() {
  const tab = useUi((s) => s.dockTab);
  const set = useUi((s) => s.set);
  const tabs = [
    ['scene', 'Scene'],
    ['inspector', 'Inspector'],
    ['files', 'Files'],
  ] as const;
  return (
    <div className="flex h-full min-h-0 flex-col border-l border-border bg-panel" data-testid="dock">
      <div className="flex h-9 shrink-0 border-b border-border" role="tablist">
        {tabs.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => set({ dockTab: id })} className={cx('touch-target flex-1 border-b-2 text-[12px] font-semibold', tab === id ? 'border-accent text-text' : 'border-transparent text-muted hover:text-text')} data-testid={`dock-tab-${id}`}>
            {label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        <ErrorBoundary label={tab}>{tab === 'scene' ? <SceneTreePanel /> : tab === 'inspector' ? <Inspector /> : <FileBrowser />}</ErrorBoundary>
      </div>
    </div>
  );
}

export default function EditorShell({ projectId }: { projectId: string }) {
  const project = useEditor((s) => s.project);
  const [error, setError] = useState<string | null>(null);
  const layout = useLayout();
  const ui = useUi();
  useShortcuts();

  useEffect(() => {
    setError(null);
    openProjectById(projectId).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [projectId]);

  useEffect(() => {
    if (project) document.title = `${project.name} — Game Studio`;
  }, [project?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <div className="text-err">{error}</div>
        <Button onClick={() => navigate({ name: 'dashboard' })}>Back to projects</Button>
      </div>
    );
  if (!project || project.id !== projectId) return <div className="flex h-full items-center justify-center text-muted">Opening project…</div>;

  const bottom = ui.bottomOpen ? (
    <>
      <Splitter vertical onDrag={(d) => ui.set({ bottomHeight: Math.max(110, Math.min(layout.height * 0.6, useUi.getState().bottomHeight - d)) })} />
      <div style={{ height: ui.bottomHeight }} className="shrink-0">
        <Panel label="Bottom panel">
          <BottomPanel />
        </Panel>
      </div>
    </>
  ) : (
    <div className="shrink-0">
      <BottomPanel collapsed />
    </div>
  );
  const center = (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <ErrorBoundary label="Editor">
        <CenterArea />
      </ErrorBoundary>
    </div>
  );

  let body: ReactNode;
  if (layout.mode === 'compact') {
    body = (
      <div className="relative flex min-h-0 flex-1 flex-col">
        {center}
        <BottomSheet />
      </div>
    );
  } else if (layout.mode === 'split' && layout.fold) {
    const f = layout.fold;
    body =
      f.axis === 'vertical' ? (
        <div className="flex min-h-0 flex-1">
          <div className="flex min-h-0 flex-col" style={{ width: f.first }}>
            {center}
            {bottom}
          </div>
          <div style={{ width: f.gap }} className="shrink-0 bg-black" />
          <div className="min-w-0 flex-1">
            <Dock />
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-col" style={{ height: f.first - 48 }}>
            {center}
          </div>
          <div style={{ height: f.gap }} className="shrink-0 bg-black" />
          <div className="flex min-h-0 flex-1">
            <div className="min-w-0 flex-1">
              <Dock />
            </div>
            <div className="w-[45%] border-l border-border">
              <Panel label="Bottom panel">
                <BottomPanel />
              </Panel>
            </div>
          </div>
        </div>
      );
  } else if (layout.mode === 'medium') {
    body = (
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {center}
          {bottom}
        </div>
        <div style={{ width: Math.min(ui.rightWidth + 30, Math.round(layout.width * 0.45)) }} className="shrink-0">
          <Dock />
        </div>
      </div>
    );
  } else {
    body = (
      <div className="flex min-h-0 flex-1">
        <div style={{ width: ui.leftWidth }} className="flex shrink-0 flex-col">
          <div className="min-h-0" style={{ height: `${ui.treeRatio * 100}%` }}>
            <Panel label="Scene tree">
              <SceneTreePanel />
            </Panel>
          </div>
          <Splitter vertical onDrag={(d) => ui.set({ treeRatio: Math.min(0.85, Math.max(0.2, useUi.getState().treeRatio + d / Math.max(200, layout.height - 80))) })} />
          <div className="min-h-0 flex-1">
            <Panel label="Files">
              <FileBrowser />
            </Panel>
          </div>
        </div>
        <Splitter onDrag={(d) => ui.set({ leftWidth: Math.max(200, Math.min(520, useUi.getState().leftWidth + d)) })} />
        <div className="flex min-w-0 flex-1 flex-col">
          {center}
          {bottom}
        </div>
        <Splitter onDrag={(d) => ui.set({ rightWidth: Math.max(240, Math.min(560, useUi.getState().rightWidth - d)) })} />
        <div style={{ width: ui.rightWidth }} className="shrink-0">
          <Panel label="Inspector">
            <Inspector />
          </Panel>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col" data-testid="editor" data-layout={layout.mode}>
      <Toolbar compact={layout.mode === 'compact'} />
      {body}
      {layout.mode === 'compact' ? <BottomNav /> : <StatusBar />}
      <Dialogs />
    </div>
  );
}
