/** Console output (runtime logs, editor messages) and the latest diagnostics. */
import { create } from 'zustand';
import type { LogEntry } from '@gs/core';
import type { Diagnostic } from '@gs/project';

export interface ConsoleEntry extends LogEntry {
  id: number;
  /** Where it came from: the running game or the editor. */
  origin: 'game' | 'editor';
  repeat: number;
}

const LIMIT = 1000;
let seq = 0;

interface ConsoleState {
  entries: ConsoleEntry[];
  /** Script compile diagnostics, per file. */
  scriptDiagnostics: Record<string, Diagnostic[]>;
  add(entry: LogEntry, origin: ConsoleEntry['origin']): void;
  clear(): void;
  setScriptDiagnostics(d: Record<string, Diagnostic[]>): void;
}

export const useConsole = create<ConsoleState>()((set) => ({
  entries: [],
  scriptDiagnostics: {},
  add(entry, origin) {
    set((s) => {
      const last = s.entries[s.entries.length - 1];
      if (last && last.message === entry.message && last.level === entry.level && last.source === entry.source && last.origin === origin) {
        return { entries: [...s.entries.slice(0, -1), { ...last, repeat: last.repeat + 1, time: entry.time }] };
      }
      const entries = [...s.entries, { ...entry, id: ++seq, origin, repeat: 1 }];
      return { entries: entries.length > LIMIT ? entries.slice(entries.length - LIMIT) : entries };
    });
  },
  clear() {
    set({ entries: [] });
  },
  setScriptDiagnostics(d) {
    set({ scriptDiagnostics: d });
  },
}));

export function logEditor(level: LogEntry['level'], message: string, source?: string) {
  useConsole.getState().add({ level, message, source, time: Date.now() }, 'editor');
}
