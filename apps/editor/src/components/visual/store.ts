/**
 * Visual-script editing state shared by the graph canvas, the members panel, the inspector and the
 * code view. It is kept apart from the editor store's scene selection, and holds no document data:
 * a `.vgraph` file lives in `project.scripts[path]` as JSON text like any other script.
 *
 * Every change goes through the command layer as one `write_script` (applyVisualOps, then
 * serializeVisualScript), so undo/redo, autosave, cloud sync and the AI connection treat graph
 * edits exactly like code edits. Continuous changes (typing a value) pass a merge key and collapse
 * into one undo step.
 *
 * This module has no React Flow imports: the inspector and the shell import it directly.
 */
import { useDeferredValue, useMemo } from 'react';
import { create } from 'zustand';
import type { Diagnostic as GraphDiagnostic, FunctionDecl, ScriptDoc, Viewport } from '@cs/graph-core';
import { compileScript } from '@cs/compiler-core';
import type { SourceMapEntry } from '@cs/language-sdk';
import { EVENTS, applyVisualOps, gameStudioToolchain, isVisualScriptPath, parseVisualScript, serializeVisualScript, type EditOp } from '@gs/visual';
import { errorMessage } from '@gs/shared';
import { useEditor } from '@editor/store/editor';
import { toast } from '@editor/store/toasts';

// ---------------------------------------------------------------------------
// Reading documents (cached by source text, so unchanged graphs keep their identity)
// ---------------------------------------------------------------------------

export type ParsedScript = { doc: ScriptDoc; error?: undefined } | { doc?: undefined; error: string };

const CACHE_SIZE = 48;
const parsed = new Map<string, ParsedScript>();

function remember<V>(map: Map<string, V>, key: string, value: V) {
  map.delete(key);
  map.set(key, value);
  if (map.size > CACHE_SIZE) map.delete(map.keys().next().value!);
}

/**
 * The document for a .vgraph source. Results are cached by text: an edit made here stores the
 * structurally-shared result of applyVisualOps under its new text, and undo/redo hit the cache, so
 * unchanged nodes keep object identity and their React components don't re-render.
 */
export function readVisualScript(source: string | undefined): ParsedScript {
  if (source === undefined) return { error: 'This visual script no longer exists.' };
  const hit = parsed.get(source);
  if (hit) {
    remember(parsed, source, hit);
    return hit;
  }
  let r: ParsedScript;
  try {
    r = { doc: parseVisualScript(source) };
  } catch (e) {
    r = { error: errorMessage(e) };
  }
  remember(parsed, source, r);
  return r;
}

export function useVisualDoc(path: string): ParsedScript {
  const source = useEditor((s) => s.project?.scripts[path]);
  return useMemo(() => readVisualScript(source), [source]);
}

/** The function whose graph is shown: the remembered one, or the first event/function. */
export function pickFunction(doc: ScriptDoc, wanted?: string): FunctionDecl | undefined {
  return doc.functions.find((f) => f.id === wanted) ?? doc.functions.find((f) => f.kind !== 'lambda') ?? doc.functions[0];
}

export const isVisualPath = isVisualScriptPath;

/** The open visual script, if the active document is one. */
export function activeVisualPath(): string | null {
  const a = useEditor.getState().active;
  return a?.kind === 'script' && isVisualScriptPath(a.path) ? a.path : null;
}

export function useActiveVisualPath(): string | null {
  return useEditor((s) => (s.active?.kind === 'script' && isVisualScriptPath(s.active.path) ? s.active.path : null));
}

// ---------------------------------------------------------------------------
// UI state
// ---------------------------------------------------------------------------

export type InspectTarget = { path: string; kind: 'script' | 'function' | 'variable' | 'signal'; id: string };

interface GraphUiState {
  /** Per script path: the function whose graph is open. */
  activeFn: Record<string, string>;
  /** Selected nodes/edges of one graph (`key` = path#functionId). */
  selection: { key: string; nodes: string[]; edges: string[] };
  /** What the inspector shows when no graph node is selected. */
  inspect: InspectTarget | null;
  /** Centre the canvas on a node (diagnostics and code-view clicks). */
  focus: { path: string; fnId: string; nodeId: string; seq: number; reveal?: boolean; with?: string } | null;
  /** Viewports per graph (kept out of the document: panning is not an undoable edit). */
  viewports: Record<string, Viewport>;
  /** Wide screens: side panels shown next to the canvas. */
  membersOpen: boolean;
  codeOpen: boolean;
  /** Code panel width beside the canvas / height below it. */
  codeSize: number;
  codeHeight: number;
  /** Narrow screens: the panel shown as a sheet over the canvas. */
  sheet: 'members' | 'code' | null;
  /** Bumped to ask the canvas to open its add-node menu (bottom bar, keyboard). */
  addRequest: number;
  set(patch: Partial<Omit<GraphUiState, 'set'>>): void;
}

const KEY = 'game-studio:graph-ui';
const PERSISTED = ['membersOpen', 'codeOpen', 'codeSize', 'codeHeight'] as const;

function load(): Partial<GraphUiState> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}');
  } catch {
    return {};
  }
}

export const useGraphUi = create<GraphUiState>()((set, get) => ({
  activeFn: {},
  selection: { key: '', nodes: [], edges: [] },
  inspect: null,
  focus: null,
  viewports: {},
  membersOpen: true,
  codeOpen: false,
  codeSize: 380,
  codeHeight: 240,
  sheet: null,
  addRequest: 0,
  ...load(),
  set(patch) {
    set(patch);
    if (PERSISTED.some((k) => k in patch)) {
      try {
        const s = get();
        localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(PERSISTED.map((k) => [k, s[k]]))));
      } catch {
        /* storage unavailable */
      }
    }
  },
}));

export const graphKey = (path: string, fnId: string | undefined) => `${path}#${fnId ?? ''}`;

const NO_SELECTION = { nodes: [] as string[], edges: [] as string[] };

/** The selection of one graph (empty when another graph's selection is stored). */
export function useGraphSelection(path: string, fnId: string | undefined) {
  const key = graphKey(path, fnId);
  return useGraphUi((s) => (s.selection.key === key ? s.selection : NO_SELECTION));
}

export function selectInGraph(path: string, fnId: string | undefined, nodes: string[], edges: string[] = []) {
  const key = graphKey(path, fnId);
  const cur = useGraphUi.getState().selection;
  if (cur.key === key && cur.nodes.join() === nodes.join() && cur.edges.join() === edges.join()) return;
  useGraphUi.getState().set({ selection: { key, nodes, edges } });
}

/** Open a function's graph (and show it in the inspector when nothing is selected). */
export function openFunction(path: string, fnId: string) {
  const s = useGraphUi.getState();
  s.set({ activeFn: { ...s.activeFn, [path]: fnId }, selection: { key: graphKey(path, fnId), nodes: [], edges: [] } });
}

/** Select a node in a graph and centre the canvas on it. */
export function focusNode(path: string, fnId: string, nodeId: string) {
  const s = useGraphUi.getState();
  s.set({ activeFn: { ...s.activeFn, [path]: fnId }, selection: { key: graphKey(path, fnId), nodes: [nodeId], edges: [] }, focus: { path, fnId, nodeId, seq: Date.now() } });
}

/** Pan the canvas to a node only if it is out of view (e.g. one just added off-screen), keeping `with` (the node it was wired to) in view too. */
export function revealNode(path: string, fnId: string, nodeId: string, withNode?: string) {
  useGraphUi.getState().set({ focus: { path, fnId, nodeId, seq: Date.now(), reveal: true, ...(withNode ? { with: withNode } : {}) } });
}

export function inspect(target: InspectTarget | null) {
  const s = useGraphUi.getState();
  s.set({ inspect: target, ...(target ? { selection: { key: s.selection.key, nodes: [], edges: [] } } : {}) });
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

export interface EditOptions {
  /** Repeated edits with the same key within a second become one undo step. */
  mergeKey?: string;
  /** Graph used by operations that don't name one (defaults to the open graph). */
  functionId?: string;
  /** Don't show a toast when the edit is refused. */
  quiet?: boolean;
}

export type EditResult = ReturnType<typeof applyVisualOps>;

/** Strip the "Operation 2 (connect): " prefix from op errors: people see the message only. */
export const cleanOpError = (e: unknown) => errorMessage(e).replace(/^Operation \d+ \([a-z_]+\): /, '');

/**
 * Apply graph edit operations to the visual script at `path` as one undoable `write_script`.
 * Returns the result (ids of created things in `created`), or null when the edit was refused.
 */
export function editVisualScript(path: string, ops: EditOp[], label: string, opts: EditOptions = {}): EditResult | null {
  const st = useEditor.getState();
  const source = st.project?.scripts[path];
  const cur = readVisualScript(source);
  if (!cur.doc) {
    if (!opts.quiet) toast('error', cur.error);
    return null;
  }
  try {
    const functionId = opts.functionId ?? pickFunction(cur.doc, useGraphUi.getState().activeFn[path])?.id;
    const r = applyVisualOps(cur.doc, ops, { functionId });
    for (const w of r.warnings) toast('warning', w);
    if (r.doc !== cur.doc) {
      const text = serializeVisualScript(r.doc);
      if (text !== source) {
        remember(parsed, text, { doc: r.doc });
        st.dispatch([{ op: 'write_script', path, source: text }], { label, mergeKey: opts.mergeKey ? `vgraph:${path}:${opts.mergeKey}` : undefined });
      }
    }
    return r;
  } catch (e) {
    if (!opts.quiet) toast('error', cleanOpError(e));
    return null;
  }
}

/** A name not used by any member of the script: speed, speed2, speed3… */
export function uniqueMemberName(doc: ScriptDoc, base: string) {
  const taken = new Set([...doc.variables, ...doc.functions, ...doc.signals, ...doc.enums, ...(doc.interfaces ?? [])].map((x) => x.name));
  let n = base;
  for (let i = 2; taken.has(n); i++) n = `${base}${i}`;
  return n;
}

/** "Ready" for `_ready`; the function's own name otherwise. */
export function functionTitle(fn: FunctionDecl) {
  if (fn.kind === 'event') return EVENTS.find((e) => e.id === fn.event)?.title ?? fn.name;
  return fn.name;
}

// ---------------------------------------------------------------------------
// Compiling (the same compiler compileVisualScript runs before play, plus its source map)
// ---------------------------------------------------------------------------

export interface VisualBuild {
  ok: boolean;
  /** Generated TypeScript; when there are errors, the last good code (see `stale`). */
  code: string;
  sourceMap: SourceMapEntry[];
  /** The code shown is from before the current errors. */
  stale: boolean;
  diagnostics: GraphDiagnostic[];
  doc?: ScriptDoc;
  /** Generated file name, e.g. scripts/player.ts. */
  file: string;
}

const builds = new Map<string, VisualBuild>();
const lastGood = new Map<string, { code: string; sourceMap: SourceMapEntry[] }>();

export function buildVisualScript(path: string, source: string | undefined): VisualBuild {
  const file = path.replace(/\.vgraph$/, '.ts');
  const key = `${path}\u0000${source ?? ''}`;
  const hit = builds.get(key);
  if (hit) return hit;
  const r = readVisualScript(source);
  let out: VisualBuild;
  if (!r.doc) {
    const good = lastGood.get(path);
    out = { ok: false, code: good?.code ?? '', sourceMap: good?.sourceMap ?? [], stale: !!good, diagnostics: [{ severity: 'error', code: 'E_PARSE', message: r.error }], file };
  } else {
    let result: ReturnType<typeof compileScript>;
    try {
      result = compileScript(gameStudioToolchain(), { ...r.doc, path: path.replace(/\.vgraph$/, '') });
    } catch (e) {
      result = { scriptId: r.doc.id, ok: false, files: [], diagnostics: [{ severity: 'error', code: 'E_INTERNAL', message: `The compiler failed: ${errorMessage(e)}` }] };
    }
    const diagnostics = result.diagnostics.filter((d) => d.severity !== 'info');
    const f = result.ok ? result.files[0] : undefined;
    if (f) lastGood.set(path, { code: f.content, sourceMap: f.sourceMap });
    const good = lastGood.get(path);
    out = { ok: result.ok, code: f?.content ?? good?.code ?? '', sourceMap: f?.sourceMap ?? good?.sourceMap ?? [], stale: !f && !!good, diagnostics, doc: r.doc, file };
  }
  remember(builds, key, out);
  return out;
}

/** The compile result for a visual script, recomputed after typing pauses (deferred render). */
export function useVisualBuild(path: string): VisualBuild {
  const source = useEditor((s) => s.project?.scripts[path]);
  const deferred = useDeferredValue(source);
  return useMemo(() => buildVisualScript(path, deferred), [path, deferred]);
}

/** "Ready › Print node: message" for lists outside the canvas. */
export function describeDiagnostic(doc: ScriptDoc | undefined, d: GraphDiagnostic): { where: string; fn?: FunctionDecl } {
  const fn = doc?.functions.find((f) => f.id === d.functionId || (d.graphId && f.graph.id === d.graphId));
  if (!fn) return { where: '' };
  const node = d.nodeId ? fn.graph.nodes.find((n) => n.id === d.nodeId) : undefined;
  const def = node ? gameStudioToolchain().registry.get(node.type) : undefined;
  return { where: `${functionTitle(fn)}${node ? ` › ${def?.title ?? node.type}` : ''}`, fn };
}
