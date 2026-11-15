/**
 * The editor's state: the open project, its undo history, open documents and the selection.
 *
 * `dispatch(commands)` is the only way the project changes — mouse, keyboard, inspector, script
 * editor and MCP all go through it, and through it the shared command layer (@gs/project).
 */
import { create } from 'zustand';
import { applyCommands, describeCommands, type ApplyResult, type Command, type ProjectDoc } from '@gs/project';
import { findDocNode } from '@gs/core';
import { emptyHistory, pushHistory, redoHistory, undoHistory, type ChangeSource, type HistoryState } from './history';

export type DocRef = { kind: 'scene'; path: string } | { kind: 'script'; path: string };

const sameDoc = (a: DocRef | null, b: DocRef | null) => !!a && !!b && a.kind === b.kind && a.path === b.path;

export interface DispatchOptions {
  label?: string;
  source?: ChangeSource;
  mergeKey?: string;
}

interface EditorState {
  project: ProjectDoc | null;
  history: HistoryState<ProjectDoc>;
  /** The document as last written to storage (dirty = project !== saved). */
  saved: ProjectDoc | null;
  openDocs: DocRef[];
  active: DocRef | null;
  /** Selected node ids in the active scene. */
  selection: string[];
  /** Problems found while loading (shown once). */
  loadIssues: string[];

  open(project: ProjectDoc, issues?: string[]): void;
  close(): void;
  dispatch(commands: Command[], opts?: DispatchOptions): ApplyResult;
  /** Replace the whole document (restore a backup, reload). Undoable. */
  replace(next: ProjectDoc, label: string, source?: ChangeSource): void;
  undo(): string | null;
  redo(): string | null;
  markSaved(doc: ProjectDoc): void;
  openDoc(ref: DocRef): void;
  closeDoc(ref: DocRef): void;
  select(ids: string[]): void;
}

/** Keep open docs / selection pointing at things that still exist. */
function reconcile(state: Pick<EditorState, 'openDocs' | 'active' | 'selection'>, project: ProjectDoc) {
  const exists = (d: DocRef) => (d.kind === 'scene' ? !!project.scenes[d.path] : project.scripts[d.path] !== undefined);
  const openDocs = state.openDocs.filter(exists);
  let active = state.active && exists(state.active) ? state.active : (openDocs[0] ?? null);
  if (!active) {
    const main = project.settings.mainScene ?? Object.keys(project.scenes)[0];
    if (main && project.scenes[main]) {
      active = { kind: 'scene', path: main };
      openDocs.push(active);
    }
  }
  const scene = active?.kind === 'scene' ? project.scenes[active.path] : null;
  const selection = scene ? state.selection.filter((id) => findDocNode(scene, id)) : [];
  return { openDocs, active, selection };
}

export const useEditor = create<EditorState>()((set, get) => ({
  project: null,
  history: emptyHistory(),
  saved: null,
  openDocs: [],
  active: null,
  selection: [],
  loadIssues: [],

  open(project, issues = []) {
    set({ project, saved: project, history: emptyHistory(), loadIssues: issues, ...reconcile({ openDocs: [], active: null, selection: [] }, project) });
  },
  close() {
    set({ project: null, saved: null, history: emptyHistory(), openDocs: [], active: null, selection: [], loadIssues: [] });
  },

  dispatch(commands, opts = {}) {
    const s = get();
    if (!s.project) throw new Error('No project is open');
    const result = applyCommands(s.project, commands);
    if (result.project !== s.project) {
      const label = opts.label ?? describeCommands(commands);
      set({
        project: result.project,
        history: pushHistory(s.history, { before: s.project, after: result.project, label: opts.source === 'mcp' ? `AI: ${label}` : label, source: opts.source ?? 'user', mergeKey: opts.mergeKey }),
        ...reconcile(s, result.project),
      });
    }
    return result;
  },

  replace(next, label, source = 'user') {
    const s = get();
    if (!s.project) return;
    set({ project: next, history: pushHistory(s.history, { before: s.project, after: next, label, source }), ...reconcile(s, next) });
  },

  undo() {
    const s = get();
    const r = undoHistory(s.history);
    if (!r) return null;
    set({ project: r.state, history: r.history, ...reconcile(s, r.state) });
    return r.entry.label;
  },
  redo() {
    const s = get();
    const r = redoHistory(s.history);
    if (!r) return null;
    set({ project: r.state, history: r.history, ...reconcile(s, r.state) });
    return r.entry.label;
  },

  markSaved(doc) {
    set({ saved: doc });
  },

  openDoc(ref) {
    const s = get();
    const openDocs = s.openDocs.some((d) => sameDoc(d, ref)) ? s.openDocs : [...s.openDocs, ref];
    set({ openDocs, active: ref, selection: sameDoc(s.active, ref) ? s.selection : [] });
  },
  closeDoc(ref) {
    const s = get();
    const i = s.openDocs.findIndex((d) => sameDoc(d, ref));
    if (i < 0) return;
    const openDocs = s.openDocs.filter((_, j) => j !== i);
    const active = sameDoc(s.active, ref) ? (openDocs[Math.min(i, openDocs.length - 1)] ?? null) : s.active;
    set({ openDocs, active, selection: sameDoc(s.active, active) ? s.selection : [] });
  },
  select(ids) {
    set({ selection: [...new Set(ids)] });
  },
}));

/** The active scene path, if a scene tab is active. */
export const activeScenePath = (s: EditorState) => (s.active?.kind === 'scene' ? s.active.path : null);
export const isDirty = (s: EditorState) => s.project !== null && s.project !== s.saved;
