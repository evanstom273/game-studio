/**
 * The TypeScript a visual script compiles to (read-only: the graph is the source), with the
 * problems list. Ported from Coding Studio's CodeView: selecting a node highlights the lines it
 * produced, clicking a line selects the node, and clicking a problem shows its node on the canvas.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { EditorState, StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, lineNumbers, type DecorationSet } from '@codemirror/view';
import { javascript } from '@codemirror/lang-javascript';
import { syntaxHighlighting } from '@codemirror/language';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Copy, XCircle } from 'lucide-react';
import type { Diagnostic as GraphDiagnostic } from '@cs/graph-core';
import { toast } from '@editor/store/toasts';
import { editorHighlight, editorTheme } from '../script/cm-theme';
import { IconButton, cx } from '../ui/primitives';
import { useEditor } from '@editor/store/editor';
import { describeDiagnostic, focusNode, inspect, openFunction, pickFunction, readVisualScript, useGraphSelection, useGraphUi, useVisualBuild, useVisualDoc } from './store';

const setLines = StateEffect.define<number[]>();
const lineMark = Decoration.line({ class: 'cm-node-line' });
const highlighted = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setLines)) continue;
      const doc = tr.state.doc;
      deco = Decoration.set([...new Set(e.value)].filter((l) => l >= 1 && l <= doc.lines).sort((a, b) => a - b).map((l) => lineMark.range(doc.line(l).from)));
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const codeTheme = EditorView.theme({
  '.cm-content': { paddingBottom: '24px' },
  '.cm-node-line': { backgroundColor: 'rgba(251,191,36,0.13)', boxShadow: 'inset 2px 0 0 #fbbf24' },
});

export function DiagnosticsList({ path, diagnostics, onPick }: { path: string; diagnostics: GraphDiagnostic[]; onPick?: () => void }) {
  const doc = useVisualDoc(path).doc;
  const pick = (d: GraphDiagnostic) => {
    const { fn } = describeDiagnostic(doc, d);
    if (fn && d.nodeId && fn.graph.nodes.some((n) => n.id === d.nodeId)) focusNode(path, fn.id, d.nodeId);
    else if (fn) {
      openFunction(path, fn.id);
      inspect({ path, kind: 'function', id: fn.id });
    } else if (doc) inspect({ path, kind: 'script', id: doc.id });
    onPick?.();
  };
  return (
    <div data-testid="visual-diagnostics">
      {diagnostics.map((d, i) => {
        const { where } = describeDiagnostic(doc, d);
        return (
          <button key={i} onClick={() => pick(d)} className="gs-row flex w-full items-start gap-2 border-b border-border/40 px-2.5 py-1 text-left text-[12px] hover:bg-panel-2" data-testid="visual-diagnostic">
            {d.severity === 'error' ? <XCircle size={13} className="mt-0.5 shrink-0 text-err" /> : <AlertTriangle size={13} className="mt-0.5 shrink-0 text-warn" />}
            <span className="min-w-0 flex-1 leading-snug">
              {where && <span className="text-muted">{where}: </span>}
              {d.message}
              {d.suggestion && <span className="text-faint"> {d.suggestion}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export default function CodeView({ path, onPick }: { path: string; onPick?: () => void }) {
  const build = useVisualBuild(path);
  const doc = useVisualDoc(path).doc;
  const activeFn = useGraphUi((s) => s.activeFn[path]);
  const fn = doc ? pickFunction(doc, activeFn) : undefined;
  const selection = useGraphSelection(path, fn?.id);
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const mapRef = useRef(build.sourceMap);
  mapRef.current = build.sourceMap;
  const [showProblems, setShowProblems] = useState(true);
  const errors = build.diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = build.diagnostics.length - errors;

  useEffect(() => {
    const extensions: Extension[] = [
      lineNumbers(),
      javascript({ typescript: true }),
      syntaxHighlighting(editorHighlight),
      EditorState.readOnly.of(true),
      // Not editable: phones don't open the keyboard, and text can still be selected and copied.
      EditorView.editable.of(false),
      EditorView.lineWrapping,
      editorTheme,
      codeTheme,
      highlighted,
      EditorView.domEventHandlers({
        mousedown(e, view) {
          const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
          if (pos === null) return false;
          const line = view.state.doc.lineAt(pos).number;
          const hit = mapRef.current.filter((m) => m.line === line && m.nodeId).pop();
          const d = readVisualScript(useEditor.getState().project?.scripts[path]).doc;
          const f = hit?.graphId ? d?.functions.find((x) => x.graph.id === hit.graphId) : undefined;
          if (hit?.nodeId && f) focusNode(path, f.id, hit.nodeId);
          return false;
        },
      }),
    ];
    const view = new EditorView({ state: EditorState.create({ doc: '', extensions }), parent: host.current! });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [path]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === build.code) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: build.code } });
  }, [build.code]);

  const lines = useMemo(() => {
    const set = new Set(selection.nodes);
    return build.sourceMap.filter((m) => m.nodeId && set.has(m.nodeId)).map((m) => m.line);
  }, [build.sourceMap, selection.nodes]);
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: setLines.of(lines) });
    if (lines.length) {
      const l = Math.min(Math.max(1, lines[0]), view.state.doc.lines);
      view.dispatch({ effects: EditorView.scrollIntoView(view.state.doc.line(l).from, { y: 'center' }) });
    }
  }, [lines, build.code]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel" data-testid="graph-code">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-2.5 text-[11.5px] text-muted">
        <span className="truncate font-mono text-text" data-testid="code-file">
          {build.file}
        </span>
        <span className="hidden truncate text-faint sm:inline">read-only · made from the graph</span>
        <div className="flex-1" />
        {build.code && (
          <IconButton label="Copy code" className="h-6 min-w-6" onClick={() => void navigator.clipboard?.writeText(build.code).then(() => toast('success', 'Code copied'), () => toast('error', 'Copying is not allowed here'))} data-testid="copy-code">
            <Copy size={13} />
          </IconButton>
        )}
      </div>
      <button className="flex shrink-0 items-center gap-1.5 border-b border-border px-2.5 py-1 text-left text-[12px]" onClick={() => setShowProblems(!showProblems)} aria-expanded={showProblems} data-testid="problems-toggle">
        {build.diagnostics.length ? showProblems ? <ChevronDown size={12} /> : <ChevronRight size={12} /> : <CheckCircle2 size={13} className="text-ok" />}
        {build.diagnostics.length === 0 ? (
          <span className="text-muted">No problems</span>
        ) : (
          <>
            {errors > 0 && <span className="text-err">{errors} error{errors === 1 ? '' : 's'}</span>}
            {warnings > 0 && <span className="text-warn">{warnings} warning{warnings === 1 ? '' : 's'}</span>}
          </>
        )}
      </button>
      {showProblems && build.diagnostics.length > 0 && (
        <div className="max-h-[40%] shrink-0 overflow-auto border-b border-border">
          <DiagnosticsList path={path} diagnostics={build.diagnostics} onPick={onPick} />
        </div>
      )}
      {(build.stale || (!build.ok && !build.code)) && (
        <div className={cx('shrink-0 px-2.5 py-1 text-[11.5px]', build.stale ? 'bg-amber-400/10 text-amber-200' : 'text-muted')} data-testid="code-stale">
          {build.stale ? `Out of date: fix the ${errors} error${errors === 1 ? '' : 's'} above and the code is rebuilt.` : 'No code yet: fix the errors above.'}
        </div>
      )}
      <pre className="sr-only" data-testid="code-text" aria-hidden>
        {build.code}
      </pre>
      <div ref={host} className="min-h-0 flex-1 overflow-hidden" data-testid="code-view" />
    </div>
  );
}
