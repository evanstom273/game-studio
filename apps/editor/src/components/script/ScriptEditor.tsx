/**
 * TypeScript script editor (CodeMirror 6 — chosen over Monaco because it works well on phones
 * and tablets). Highlighting, engine-aware autocomplete, live diagnostics from esbuild, and an
 * accessory bar of code symbols on touch screens.
 *
 * Typing updates the project through the command layer (write_script), merged into one undo step
 * per pause; changes made elsewhere (undo, MCP) flow back into the editor.
 */
import { useEffect, useRef, useState } from 'react';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { bracketMatching, indentOnInput, syntaxHighlighting, HighlightStyle, foldGutter } from '@codemirror/language';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { linter, lintGutter, setDiagnostics, type Diagnostic as CmDiagnostic } from '@codemirror/lint';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { tags as t } from '@lezer/highlight';
import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { nodeTypes } from '@gs/core';
import { API_COMPLETIONS, type ApiEntry } from '@gs/scripting';
import type { Diagnostic } from '@gs/project';
import { useEditor } from '@editor/store/editor';
import { useLayout } from '@editor/lib/layout';
import { checkScriptSource, compileProjectScripts } from '@editor/scripting/compiler';
import { useConsole } from '@editor/store/console';
import { toast } from '@editor/store/toasts';
import { errorMessage } from '@gs/shared';

const theme = EditorView.theme(
  {
    '&': { color: '#e3e6ec', backgroundColor: '#11141a' },
    '.cm-content': { caretColor: '#4f8cff', paddingBottom: '40vh' },
    '.cm-cursor': { borderLeftColor: '#4f8cff' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'rgba(79,140,255,0.28) !important' },
    '.cm-gutters': { backgroundColor: '#11141a', color: '#5b6372', border: 'none' },
    '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.03)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#8b93a4' },
    '.cm-tooltip': { backgroundColor: '#1c212b', border: '1px solid #2a303c', color: '#e3e6ec' },
    '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'rgba(79,140,255,0.3)' },
    '.cm-completionDetail': { color: '#8b93a4', fontStyle: 'normal', marginLeft: '8px' },
    '.cm-panels': { backgroundColor: '#161a22', color: '#e3e6ec' },
  },
  { dark: true },
);

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword], color: '#c792ea' },
  { tag: [t.typeName, t.className], color: '#ffcb6b' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#82aaff' },
  { tag: [t.string, t.special(t.string)], color: '#c3e88d' },
  { tag: [t.number, t.bool, t.null], color: '#f78c6c' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: '#5f6b80', fontStyle: 'italic' },
  { tag: [t.propertyName], color: '#b2ccd6' },
  { tag: [t.definition(t.variableName)], color: '#e3e6ec' },
  { tag: [t.operator, t.punctuation], color: '#89ddff' },
]);

/** Engine-aware completions: globals, imports, and members after `this.` / `Input.` / known classes. */
function engineCompletions(ctx: CompletionContext): CompletionResult | null {
  const word = ctx.matchBefore(/[\w$]*/);
  if (!word || (word.from === word.to && !ctx.explicit && ctx.state.sliceDoc(word.from - 1, word.from) !== '.')) return null;
  const before = ctx.state.sliceDoc(Math.max(0, word.from - 40), word.from);
  const toOption = (e: ApiEntry) => ({ label: e.label, type: e.type, detail: e.detail, info: e.info });
  const classes = nodeTypes.all().map((n) => n.name);
  const member = /([\w$]+)\.$/.exec(before);
  if (member) {
    const target = member[1];
    let cls: string | null = null;
    if (target === 'this') cls = /extends\s+(\w+)/.exec(ctx.state.doc.toString())?.[1] ?? 'Node';
    else if (target === 'Input') cls = 'InputManager';
    else if (/^(Vector2|Vector3|Color)$/.test(target)) return { from: word.from, options: [...(target === 'Vector2' ? ['ZERO', 'ONE', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'fromAngle'] : target === 'Vector3' ? ['ZERO', 'ONE', 'UP', 'DOWN', 'FORWARD', 'BACK', 'LEFT', 'RIGHT'] : ['fromHex', 'WHITE', 'BLACK', 'TRANSPARENT']).map((label) => ({ label, type: 'constant' }))] };
    else if (/^(velocity|position|scale|globalPosition|offset|zoom|linearVelocity)$/.test(target)) cls = /3D/.test(ctx.state.doc.toString()) && !/2D/.test(ctx.state.doc.toString()) ? 'Vector3' : 'Vector2';
    else if (target === 'getTree()' || target === 'tree') cls = 'SceneTree';
    if (!cls) return null;
    const options: ReturnType<typeof toOption>[] = [];
    const chain = nodeTypes.has(cls) ? nodeTypes.chain(cls) : [cls];
    for (const c of chain) {
      for (const e of API_COMPLETIONS.members[c] ?? []) options.push(toOption(e));
      if (nodeTypes.has(c)) for (const p of nodeTypes.get(c)!.properties) options.push({ label: p.name, type: 'property', detail: p.type, info: p.hint });
    }
    return { from: word.from, options, validFor: /^[\w$]*$/ };
  }
  return { from: word.from, options: [...API_COMPLETIONS.globals.map(toOption), ...classes.map((c) => ({ label: c, type: 'class', detail: nodeTypes.get(c)?.category, info: nodeTypes.get(c)?.description })), ...['_ready', '_process', '_physicsProcess', '_input', '_enterTree', '_exitTree'].map((label) => ({ label, type: 'method' }))], validFor: /^[\w$]*$/ };
}

function toCm(view: EditorView, d: Diagnostic): CmDiagnostic {
  const doc = view.state.doc;
  const line = doc.line(Math.min(Math.max(1, d.line ?? 1), doc.lines));
  const from = Math.min(line.from + Math.max(0, (d.column ?? 1) - 1), line.to);
  return { from, to: Math.min(line.to, from + 1) === from ? from : line.to, severity: d.severity === 'error' ? 'error' : 'warning', message: d.message };
}

const SYMBOLS = ['{', '}', '(', ')', '[', ']', ';', '.', '=', '=>', "'", '<', '>', '+', '-', '*', '/', '!', '&&', '||', ':'];

export default function ScriptEditor({ path }: { path: string }) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const layout = useLayout();
  const [diags, setDiags] = useState<Diagnostic[]>([]);

  useEffect(() => {
    const source = useEditor.getState().project?.scripts[path] ?? '';
    let lastWritten = source;
    let pushTimer: ReturnType<typeof setTimeout> | null = null;
    let session = Date.now();
    const push = (text: string) => {
      lastWritten = text;
      try {
        useEditor.getState().dispatch([{ op: 'write_script', path, source: text }], { label: `Edit ${path}`, mergeKey: `script:${path}:${session}` });
      } catch (e) {
        toast('error', errorMessage(e));
      }
    };
    const lint = linter(
      async (view) => {
        const text = view.state.doc.toString();
        const quick = await checkScriptSource(path, text);
        let all = quick;
        if (!quick.some((d) => d.severity === 'error')) {
          // Full compile catches bad imports between scripts.
          const scripts = { ...useEditor.getState().project!.scripts, [path]: text };
          const r = await compileProjectScripts(scripts);
          all = r.diagnostics.filter((d) => d.file === path);
        }
        setDiags(all);
        return all.map((d) => toCm(view, d));
      },
      { delay: 500 },
    );
    const extensions: Extension[] = [
      lineNumbers(),
      foldGutter(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      drawSelection(),
      history(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      highlightSelectionMatches(),
      javascript({ typescript: path.endsWith('.ts') }),
      syntaxHighlighting(highlight),
      autocompletion({ override: [engineCompletions], activateOnTyping: true }),
      lint,
      lintGutter(),
      keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
      EditorView.lineWrapping,
      theme,
      EditorView.updateListener.of((u) => {
        if (!u.docChanged || u.transactions.some((tr) => tr.isUserEvent('gs.external'))) return;
        if (pushTimer) clearTimeout(pushTimer);
        const text = u.state.doc.toString();
        pushTimer = setTimeout(() => push(text), 350);
      }),
    ];
    const view = new EditorView({ state: EditorState.create({ doc: source, extensions }), parent: host.current! });
    viewRef.current = view;

    // Changes from elsewhere (undo/redo, AI edits, renames) flow back in.
    const unsub = useEditor.subscribe((s) => {
      const text = s.project?.scripts[path];
      if (text === undefined || text === lastWritten) return;
      if (text === view.state.doc.toString()) {
        lastWritten = text;
        return;
      }
      lastWritten = text;
      session = Date.now();
      if (pushTimer) clearTimeout(pushTimer);
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, userEvent: 'gs.external' });
    });
    return () => {
      unsub();
      if (pushTimer) {
        clearTimeout(pushTimer);
        const text = view.state.doc.toString();
        if (text !== lastWritten) push(text);
      }
      view.destroy();
      viewRef.current = null;
    };
  }, [path]);

  // Errors from the last full build (e.g. after Play) also show here.
  const built = useConsole((s) => s.scriptDiagnostics[path]);
  useEffect(() => {
    const view = viewRef.current;
    if (view && built) view.dispatch(setDiagnostics(view.state, built.map((d) => toCm(view, d))));
  }, [built]);

  const insert = (text: string) => {
    const view = viewRef.current;
    if (!view) return;
    const { from, to } = view.state.selection.main;
    view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, userEvent: 'input' });
    view.focus();
  };
  const errors = diags.filter((d) => d.severity === 'error').length;
  const warnings = diags.length - errors;
  return (
    <div className="flex h-full flex-col" data-testid="script-editor">
      <div ref={host} className="min-h-0 flex-1 overflow-hidden" />
      {layout.touch && (
        <div className="flex shrink-0 gap-1 overflow-x-auto border-t border-border bg-panel px-1 py-1" aria-label="Code symbols">
          <button className="touch-target shrink-0 rounded bg-panel-3 px-2.5 font-mono text-[13px]" onMouseDown={(e) => e.preventDefault()} onClick={() => insert('  ')}>
            ⇥
          </button>
          {SYMBOLS.map((s) => (
            <button key={s} className="touch-target shrink-0 rounded bg-panel-3 px-2.5 font-mono text-[14px]" onMouseDown={(e) => e.preventDefault()} onClick={() => insert(s)}>
              {s}
            </button>
          ))}
        </div>
      )}
      <div className="flex h-6 shrink-0 items-center gap-3 border-t border-border bg-panel px-2 text-[11px] text-muted" data-testid="script-status">
        <span className="truncate font-mono">{path}</span>
        <div className="flex-1" />
        {errors + warnings === 0 ? (
          <span className="flex items-center gap-1">
            <CheckCircle2 size={12} className="text-ok" /> No problems
          </span>
        ) : (
          <span className="flex items-center gap-2">
            <span className="flex items-center gap-1">
              <XCircle size={12} className="text-err" /> {errors}
            </span>
            <span className="flex items-center gap-1">
              <AlertTriangle size={12} className="text-warn" /> {warnings}
            </span>
          </span>
        )}
        <span className="hidden sm:inline">TypeScript · syntax checked (types are not checked)</span>
      </div>
    </div>
  );
}
