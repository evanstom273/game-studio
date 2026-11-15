/**
 * The visual script editor (Blueprint-style graphs), ported from Coding Studio. Lazily loaded by
 * the centre area for `.vgraph` tabs.
 *
 *   wide       script panel | canvas | generated code (side by side, resizable)
 *   narrower   canvas, with the script panel and the code in sheets over it
 *   phones     the same, plus the bottom bar's Add button and a touch selection bar
 *
 * The graph's selected node is edited in the editor's Inspector panel (GraphInspector).
 */
import '@xyflow/react/dist/style.css';
import './visual.css';
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { ReactFlowProvider, useReactFlow } from '@xyflow/react';
import { AlertTriangle, CheckCircle2, CodeXml, CopyPlus, FileWarning, Maximize, PanelLeft, Plus, SlidersHorizontal, SquareFunction, Trash2, X, XCircle, Zap } from 'lucide-react';
import type { FunctionDecl, ScriptDoc } from '@cs/graph-core';
import { useLayout } from '@editor/lib/layout';
import { useUi } from '@editor/store/ui';
import { Button, EmptyState, IconButton, Splitter, cx } from '../ui/primitives';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { GraphCanvas } from './GraphCanvas';
import { MembersPanel } from './MembersPanel';
import CodeView from './CodeView';
import { deleteSelection, duplicateSelection, requestAddNode } from './commands';
import { functionTitle, inspect, openFunction, pickFunction, useGraphSelection, useGraphUi, useVisualBuild, useVisualDoc } from './store';

const ScriptEditor = lazy(() => import('../script/ScriptEditor'));

/** Size of an element, kept up to date. */
function useSize(ref: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((e) => setSize({ width: Math.round(e[0].contentRect.width), height: Math.round(e[0].contentRect.height) }));
    ro.observe(el);
    setSize({ width: el.clientWidth, height: el.clientHeight });
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/** A panel over the canvas on narrow screens: drag the handle down (or tap ×) to close. */
function PanelSheet({ title, onClose, children, testId }: { title: string; onClose: () => void; children: ReactNode; testId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const onDrag = (e: React.PointerEvent) => {
    const el = ref.current;
    if (!el) return;
    e.preventDefault();
    const startY = e.clientY;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => (el.style.transform = `translateY(${Math.max(0, ev.clientY - startY)}px)`);
    const up = (ev: PointerEvent) => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      el.style.transform = '';
      if (ev.clientY - startY > 80) onClose();
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  };
  return (
    <div ref={ref} className="absolute inset-x-0 bottom-0 z-20 flex h-[72%] flex-col rounded-t-xl border-t border-border bg-panel shadow-[0_-12px_32px_rgba(0,0,0,0.45)]" data-testid={testId}>
      <div className="flex h-9 shrink-0 cursor-grab touch-none items-center border-b border-border px-2" onPointerDown={onDrag} role="separator" aria-label="Drag down to close">
        <span className="flex-1 truncate pl-1 text-[12px] font-semibold uppercase tracking-wide text-muted">{title}</span>
        <div className="absolute left-1/2 top-1.5 h-1 w-10 -translate-x-1/2 rounded-full bg-border-strong" />
        <IconButton label={`Close ${title}`} onPointerDown={(e) => e.stopPropagation()} onClick={onClose}>
          <X size={16} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

/** The graphs of the script as tabs: events first, then functions. */
function GraphTabs({ path, doc, fn }: { path: string; doc: ScriptDoc; fn: FunctionDecl }) {
  const build = useVisualBuild(path);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [fn.id]);
  const list = [...doc.functions.filter((f) => f.kind === 'event'), ...doc.functions.filter((f) => f.kind === 'function'), ...doc.functions.filter((f) => f.kind === 'lambda' && f.id === fn.id)];
  return (
    <div ref={ref} className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-1 [scrollbar-width:none]" role="tablist" aria-label="Graphs">
      {list.map((f) => {
        const errors = build.diagnostics.filter((d) => d.functionId === f.id && d.severity === 'error').length;
        const Icon = f.kind === 'event' ? Zap : SquareFunction;
        return (
          <button
            key={f.id}
            role="tab"
            aria-selected={f.id === fn.id}
            onClick={() => {
              openFunction(path, f.id);
              inspect(null);
            }}
            className={cx('touch-target flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[12px]', f.id === fn.id ? 'border-accent/60 bg-accent/15 text-text' : 'border-border text-muted hover:text-text')}
            title={f.kind === 'event' ? `${functionTitle(f)} (${f.name})` : `${f.name}()`}
            data-testid="graph-tab"
            data-fn={f.name}
          >
            <Icon size={12} className={f.kind === 'event' ? 'text-red-300' : 'text-blue-300'} />
            {functionTitle(f)}
            {errors > 0 && <span className="rounded-full bg-err/25 px-1 text-[10px] text-err">{errors}</span>}
          </button>
        );
      })}
    </div>
  );
}

function Status({ path, onClick }: { path: string; onClick: () => void }) {
  const build = useVisualBuild(path);
  const errors = build.diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = build.diagnostics.length - errors;
  return (
    <button className="touch-target flex h-7 shrink-0 items-center gap-2 rounded px-1.5 text-[11px] text-muted hover:bg-panel-2" onClick={onClick} title="Problems and generated code" data-testid="graph-status" data-errors={errors}>
      {errors + warnings === 0 ? (
        <CheckCircle2 size={14} className="text-ok" />
      ) : (
        <>
          {errors > 0 && (
            <span className="flex items-center gap-1 text-err">
              <XCircle size={13} /> {errors}
            </span>
          )}
          {warnings > 0 && (
            <span className="flex items-center gap-1 text-warn">
              <AlertTriangle size={13} /> {warnings}
            </span>
          )}
        </>
      )}
    </button>
  );
}

/** Touch: actions for the selected nodes, floating over the canvas. */
function SelectionBar({ path, fn }: { path: string; fn: FunctionDecl }) {
  const sel = useGraphSelection(path, fn.id);
  const compact = useLayout().mode === 'compact';
  const deletable = sel.nodes.some((id) => fn.graph.nodes.find((n) => n.id === id)?.type !== 'core.entry') || sel.edges.length > 0;
  if (!sel.nodes.length && !sel.edges.length) return null;
  return (
    <div className="pointer-events-auto absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-panel-2/95 px-1.5 py-1 shadow-xl" data-testid="graph-selection-bar">
      {compact && sel.nodes.length > 0 && (
        <IconButton label="Edit in the inspector" onClick={() => useUi.getState().set({ sheet: 'inspector', sheetSize: 'half' })} data-testid="selection-inspect">
          <SlidersHorizontal size={16} />
        </IconButton>
      )}
      {sel.nodes.length > 0 && (
        <IconButton label="Duplicate" onClick={duplicateSelection} data-testid="selection-duplicate">
          <CopyPlus size={16} />
        </IconButton>
      )}
      <IconButton label="Delete" onClick={deleteSelection} disabled={!deletable} data-testid="selection-delete">
        <Trash2 size={16} className="text-err" />
      </IconButton>
    </div>
  );
}

function Editor({ path, doc }: { path: string; doc: ScriptDoc }) {
  const layout = useLayout();
  const rf = useReactFlow();
  const rootRef = useRef<HTMLDivElement>(null);
  const { width, height } = useSize(rootRef);
  const activeFn = useGraphUi((s) => s.activeFn[path]);
  const membersOpen = useGraphUi((s) => s.membersOpen);
  const codeOpen = useGraphUi((s) => s.codeOpen);
  const codeSize = useGraphUi((s) => s.codeSize);
  const codeHeight = useGraphUi((s) => s.codeHeight);
  const sheet = useGraphUi((s) => s.sheet);
  const set = useGraphUi((s) => s.set);
  const fn = pickFunction(doc, activeFn);
  const compact = layout.mode === 'compact';
  // Side panels sit next to the canvas only when there is room for all three.
  const inlineMembers = !compact && width >= 820;
  const codeBeside = !compact && width >= 980;
  const inlineCode = !compact && width >= 640;

  // Close sheets that no longer apply (e.g. after rotating to a wider screen).
  useEffect(() => {
    if ((sheet === 'members' && inlineMembers) || (sheet === 'code' && inlineCode)) set({ sheet: null });
  }, [sheet, inlineMembers, inlineCode, set]);

  // F: fit the graph in view.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.ctrlKey || e.metaKey || e.altKey || (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable))) return;
      if (e.key === 'f' || e.key === 'F') void rf.fitView({ padding: 0.2, duration: 250, maxZoom: 1.2 });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rf]);

  const toggleMembers = () => (inlineMembers ? set({ membersOpen: !membersOpen }) : set({ sheet: sheet === 'members' ? null : 'members' }));
  const toggleCode = () => (inlineCode ? set({ codeOpen: !codeOpen }) : set({ sheet: sheet === 'code' ? null : 'code' }));
  const showCode = () => (inlineCode ? set({ codeOpen: true }) : set({ sheet: 'code' }));
  const membersShown = inlineMembers ? membersOpen : sheet === 'members';
  const codeShown = inlineCode ? codeOpen : sheet === 'code';
  const closeSheet = () => set({ sheet: null });

  if (!fn)
    return (
      <EmptyState title="This script has no graphs" icon={<Zap size={26} className="text-faint" />}>
        <Button variant="primary" onClick={toggleMembers}>
          Add an event
        </Button>
      </EmptyState>
    );

  const code = <CodeView path={path} onPick={inlineCode ? undefined : closeSheet} />;
  return (
    <div ref={rootRef} className="gs-graph flex h-full min-h-0 flex-col" data-testid="graph-editor" data-path={path}>
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border bg-panel px-1" data-testid="graph-toolbar">
        <IconButton label={membersShown ? 'Hide the script panel' : 'Show the script panel (variables, functions, events)'} active={membersShown} onClick={toggleMembers} data-testid="toggle-members">
          <PanelLeft size={16} />
        </IconButton>
        <GraphTabs path={path} doc={doc} fn={fn} />
        <Status path={path} onClick={showCode} />
        {!compact && (
          <Button variant="primary" className="h-7 px-2" onClick={requestAddNode} data-testid="graph-add-node" title="Add a node (Ctrl+A or Tab)">
            <Plus size={14} /> <span className="hidden sm:inline">Node</span>
          </Button>
        )}
        <IconButton label={codeShown ? 'Hide the code' : 'Show the generated code'} active={codeShown} onClick={toggleCode} data-testid="toggle-code">
          <CodeXml size={16} />
        </IconButton>
        {!compact && (
          <IconButton label="Fit the graph in view (F)" onClick={() => void rf.fitView({ padding: 0.2, duration: 250, maxZoom: 1.2 })} data-testid="graph-fit">
            <Maximize size={15} />
          </IconButton>
        )}
      </div>
      <div className={cx('relative flex min-h-0 flex-1', !codeBeside && 'flex-col')}>
        <div className="flex min-h-0 min-w-0 flex-1">
          {inlineMembers && membersOpen && (
            <div className="w-[240px] shrink-0 border-r border-border">
              <ErrorBoundary label="Script panel">
                <MembersPanel path={path} doc={doc} fnId={fn.id} />
              </ErrorBoundary>
            </div>
          )}
          <div className="relative min-h-0 min-w-0 flex-1">
            <ErrorBoundary label="Graph">
              <GraphCanvas key={`${path}#${fn.id}`} path={path} doc={doc} fn={fn} />
            </ErrorBoundary>
            {layout.touch && <SelectionBar path={path} fn={fn} />}
          </div>
        </div>
        {inlineCode && codeOpen && (
          <>
            <Splitter vertical={!codeBeside} onDrag={(d) => (codeBeside ? set({ codeSize: Math.max(240, Math.min(width - 360, useGraphUi.getState().codeSize - d)) }) : set({ codeHeight: Math.max(120, Math.min(height - 160, useGraphUi.getState().codeHeight - d)) }))} />
            {/* Below the canvas, the code takes at most half the height so the graph stays usable. */}
            <div style={codeBeside ? { width: Math.min(codeSize, width - 360) } : { height: Math.max(120, Math.min(codeHeight, height * 0.5)) }} className="min-h-0 shrink-0">
              <ErrorBoundary label="Code">{code}</ErrorBoundary>
            </div>
          </>
        )}
        {sheet === 'members' && !inlineMembers && (
          <PanelSheet title="Script" onClose={closeSheet} testId="members-sheet">
            <MembersPanel path={path} doc={doc} fnId={fn.id} onOpened={closeSheet} />
          </PanelSheet>
        )}
        {sheet === 'code' && !inlineCode && (
          <PanelSheet title="Code" onClose={closeSheet} testId="code-sheet">
            {code}
          </PanelSheet>
        )}
      </div>
    </div>
  );
}

export default function GraphEditor({ path }: { path: string }) {
  const parsed = useVisualDoc(path);
  const [raw, setRaw] = useState(false);
  if (raw || !parsed.doc)
    return raw ? (
      <div className="flex h-full flex-col">
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-panel px-2 text-[12px]">
          <FileWarning size={14} className="text-warn" /> <span className="flex-1 truncate text-muted">Editing the raw file. Fix it, then go back to the graph.</span>
          <Button onClick={() => setRaw(false)} disabled={!parsed.doc} data-testid="back-to-graph">
            Back to the graph
          </Button>
        </div>
        <div className="min-h-0 flex-1">
          <Suspense fallback={null}>
            <ScriptEditor path={path} />
          </Suspense>
        </div>
      </div>
    ) : (
      <EmptyState icon={<FileWarning size={28} className="text-warn" />} title="This visual script can't be opened">
        <div className="mb-3 text-err">{parsed.error}</div>
        <Button onClick={() => setRaw(true)}>Edit the raw file</Button>
      </EmptyState>
    );
  return (
    <ReactFlowProvider>
      <Editor path={path} doc={parsed.doc} />
    </ReactFlowProvider>
  );
}
