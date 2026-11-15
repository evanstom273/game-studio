/**
 * Snapshot undo/redo (the approach GUI Studio and Coding Studio use). Project documents are
 * immutable and structurally shared by the command layer, so a few hundred snapshots are cheap.
 * A drag or typing in a field passes a `mergeKey`, and repeated edits within a second collapse
 * into one undo step.
 */
export type ChangeSource = 'user' | 'mcp' | 'system';

export interface HistoryEntry<T> {
  before: T;
  after: T;
  label: string;
  source: ChangeSource;
  mergeKey?: string;
  time: number;
}

export interface HistoryState<T> {
  past: HistoryEntry<T>[];
  future: HistoryEntry<T>[];
}

export const HISTORY_LIMIT = 300;
export const MERGE_WINDOW_MS = 1000;

export const emptyHistory = <T,>(): HistoryState<T> => ({ past: [], future: [] });

export function pushHistory<T>(h: HistoryState<T>, e: Omit<HistoryEntry<T>, 'time'>, now = Date.now()): HistoryState<T> {
  if (e.before === e.after) return h;
  const last = h.past[h.past.length - 1];
  if (e.mergeKey && last && last.mergeKey === e.mergeKey && now - last.time < MERGE_WINDOW_MS) {
    return { past: [...h.past.slice(0, -1), { ...last, after: e.after, time: now }], future: [] };
  }
  const past = [...h.past, { ...e, time: now }];
  if (past.length > HISTORY_LIMIT) past.splice(0, past.length - HISTORY_LIMIT);
  return { past, future: [] };
}

export function undoHistory<T>(h: HistoryState<T>) {
  const entry = h.past[h.past.length - 1];
  if (!entry) return null;
  return { history: { past: h.past.slice(0, -1), future: [entry, ...h.future] }, state: entry.before, entry };
}

export function redoHistory<T>(h: HistoryState<T>) {
  const entry = h.future[0];
  if (!entry) return null;
  return { history: { past: [...h.past, { ...entry, mergeKey: undefined }], future: h.future.slice(1) }, state: entry.after, entry };
}
