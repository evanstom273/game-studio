/** Whether GitHub is connected (and as whom), shared by every GitHub panel. Checked on demand. */
import { create } from 'zustand';
import type { Conflict } from '@gs/git';
import { forgetToken, tokenStatus } from './api';

interface GitHubAuth {
  /** undefined: not checked yet · null: not connected · string: the GitHub login */
  login: string | null | undefined;
  error: string | null;
  refresh(): Promise<void>;
  connected(login: string): void;
  disconnect(): Promise<void>;
}

export const useGitHubAuth = create<GitHubAuth>()((set) => ({
  login: undefined,
  error: null,
  async refresh() {
    try {
      const s = await tokenStatus();
      set({ login: s.connected ? (s.login ?? '') : null, error: null });
    } catch (e) {
      set({ login: null, error: e instanceof Error ? e.message : String(e) });
    }
  },
  connected(login) {
    set({ login, error: null });
  },
  async disconnect() {
    await forgetToken();
    set({ login: null });
  },
}));

/** Conflicts from the last pull or branch switch (shown in Changes until resolved or dismissed). */
export const useGitConflicts = create<{ projectId: string | null; conflicts: Conflict[]; set(projectId: string, conflicts: Conflict[]): void; drop(path: string): void }>()((set) => ({
  projectId: null,
  conflicts: [],
  set(projectId, conflicts) {
    set({ projectId, conflicts });
  },
  drop(path) {
    set((s) => ({ conflicts: s.conflicts.filter((c) => c.path !== path) }));
  },
}));
