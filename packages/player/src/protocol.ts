/**
 * Messages between the editor and the sandboxed player frame (postMessage).
 *
 * The frame runs with `sandbox="allow-scripts"` (no allow-same-origin): an opaque origin with no
 * access to the editor's storage, cookies or DOM. Both sides therefore check `event.source`
 * (the window object) rather than the origin, which is "null" for the frame.
 */
import type { LogEntry, ScriptInfo } from '@gs/core';
import type { GameData, RuntimeModuleName } from './game-data';

export const PLAYER_SOURCE = 'gs-player';
export const EDITOR_SOURCE = 'gs-editor';

export type EditorToPlayer =
  | { source: typeof EDITOR_SOURCE; type: 'boot'; data: GameData; assets: Record<string, Blob>; scriptsJs: string; modules: RuntimeModuleName[]; debugShapes?: boolean }
  | { source: typeof EDITOR_SOURCE; type: 'describe'; scriptsJs: string; paths: string[] }
  | { source: typeof EDITOR_SOURCE; type: 'pause' | 'resume' };

export type PlayerToEditor =
  | { source: typeof PLAYER_SOURCE; type: 'ready' }
  | { source: typeof PLAYER_SOURCE; type: 'started'; modules: RuntimeModuleName[] }
  | { source: typeof PLAYER_SOURCE; type: 'log'; entry: LogEntry }
  | { source: typeof PLAYER_SOURCE; type: 'fatal'; message: string; stack?: string }
  | { source: typeof PLAYER_SOURCE; type: 'stats'; fps: number; nodes: number; time: number }
  | { source: typeof PLAYER_SOURCE; type: 'described'; scripts: ScriptInfo[] };

/** Omit that keeps a union a union. */
export type WithoutSource<T> = T extends unknown ? Omit<T, 'source'> : never;
