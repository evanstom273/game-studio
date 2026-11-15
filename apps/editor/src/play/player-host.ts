/**
 * Play mode: runs the game in a sandboxed iframe (/player.html, `sandbox="allow-scripts"` — an
 * opaque origin with no access to the editor's storage or DOM) using the same runtime bundles as
 * exported games. The editor compiles scripts, sends the game data and asset blobs, and receives
 * console output and stats back.
 */
import { create } from 'zustand';
import { GameStudioError, errorMessage } from '@gs/shared';
import type { ScriptInfo } from '@gs/core';
import { EDITOR_SOURCE, PLAYER_SOURCE, requiredModules, type EditorToPlayer, type GameData, type PlayerToEditor, type RuntimeModuleName, type WithoutSource } from '@gs/player';
import type { ProjectDoc } from '@gs/project';
import { compileProjectScripts } from '@editor/scripting/compiler';
import { assetBlobByHash } from '@editor/services/assets';
import { logEditor, useConsole } from '@editor/store/console';

export type PlayStatus = 'stopped' | 'starting' | 'running' | 'paused' | 'failed';

interface PlayState {
  status: PlayStatus;
  scene: string | null;
  fps: number;
  nodes: number;
  time: number;
  error: string | null;
  /** Increments per run so the view mounts a fresh frame. */
  run: number;
  /** Scripts compiled and boot data ready: the view may create the frame. */
  compiled: boolean;
  debugShapes: boolean;
}

export const usePlay = create<PlayState>()(() => ({ status: 'stopped', scene: null, fps: 0, nodes: 0, time: 0, error: null, run: 0, compiled: false, debugShapes: false }));

let pendingBoot: { data: GameData; assets: Record<string, Blob>; scriptsJs: string; modules: RuntimeModuleName[] } | null = null;
let frame: HTMLIFrameElement | null = null;
let startWaiters: { resolve(): void; reject(e: Error): void }[] = [];

function settleStart(error?: Error) {
  for (const w of startWaiters.splice(0)) error ? w.reject(error) : w.resolve();
}

function post(msg: WithoutSource<EditorToPlayer>) {
  frame?.contentWindow?.postMessage({ source: EDITOR_SOURCE, ...msg }, '*');
}

window.addEventListener('message', (e: MessageEvent<PlayerToEditor>) => {
  if (!frame || e.source !== frame.contentWindow || e.data?.source !== PLAYER_SOURCE) return;
  const msg = e.data;
  switch (msg.type) {
    case 'ready':
      if (pendingBoot) {
        post({ type: 'boot', ...pendingBoot, debugShapes: usePlay.getState().debugShapes });
        pendingBoot = null;
      }
      break;
    case 'started':
      usePlay.setState({ status: 'running' });
      settleStart();
      break;
    case 'log':
      useConsole.getState().add(msg.entry, 'game');
      break;
    case 'stats':
      usePlay.setState({ fps: msg.fps, nodes: msg.nodes, time: msg.time });
      break;
    case 'fatal':
      useConsole.getState().add({ level: 'error', message: `The game stopped: ${msg.message}`, stack: msg.stack, time: Date.now() }, 'game');
      usePlay.setState({ status: 'failed', error: msg.message });
      settleStart(new GameStudioError('E_GAME_FAILED', msg.message));
      break;
  }
});

/** Called by the play view when its iframe element exists. */
export function attachFrame(el: HTMLIFrameElement | null) {
  frame = el;
}

/** Compiles and starts `scenePath`. Resolves when the game is running. */
export async function startGame(project: ProjectDoc, scenePath: string): Promise<void> {
  if (!project.scenes[scenePath]) throw new GameStudioError('E_NOT_FOUND', `No scene "${scenePath}"`);
  stopGame();
  usePlay.setState({ status: 'starting', scene: scenePath, error: null, fps: 0, nodes: 0, time: 0, compiled: false });
  logEditor('info', `Running ${scenePath}…`);
  const compiled = await compileProjectScripts(project.scripts);
  if (!compiled.ok) {
    const first = compiled.diagnostics.find((d) => d.severity === 'error');
    const message = first ? `${first.file ?? ''}${first.line ? `:${first.line}` : ''} ${first.message}`.trim() : 'Scripts failed to compile';
    for (const d of compiled.diagnostics) logEditor(d.severity === 'error' ? 'error' : 'warn', d.message, d.file ? `${d.file}${d.line ? `:${d.line}:${d.column ?? 1}` : ''}` : undefined);
    usePlay.setState({ status: 'failed', error: `Scripts have errors: ${message}` });
    throw new GameStudioError('E_COMPILE', `Scripts have errors: ${message}`, { diagnostics: compiled.diagnostics });
  }
  const assets: Record<string, Blob> = {};
  for (const a of Object.values(project.assets)) {
    const b = assetBlobByHash(a.hash);
    if (b) assets[a.path] = b;
  }
  pendingBoot = {
    data: { name: project.name, settings: project.settings, scenes: project.scenes, assets: project.assets, startScene: scenePath },
    assets,
    scriptsJs: compiled.js,
    modules: requiredModules(project.scenes),
  };
  const started = new Promise<void>((resolve, reject) => startWaiters.push({ resolve, reject }));
  // The play view mounts a new iframe for this run; it says "ready" and we boot it.
  usePlay.setState((s) => ({ run: s.run + 1, compiled: true }));
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new GameStudioError('E_TIMEOUT', 'The game did not start within 30 s')), 30_000));
  try {
    await Promise.race([started, timeout]);
  } catch (e) {
    if (usePlay.getState().status === 'starting') usePlay.setState({ status: 'failed', error: errorMessage(e) });
    throw e;
  }
}

export function stopGame() {
  pendingBoot = null;
  settleStart(new GameStudioError('E_STOPPED', 'The game was stopped'));
  if (usePlay.getState().status !== 'stopped') usePlay.setState({ status: 'stopped' });
}

export function togglePause() {
  const s = usePlay.getState().status;
  if (s === 'running') {
    post({ type: 'pause' });
    usePlay.setState({ status: 'paused' });
  } else if (s === 'paused') {
    post({ type: 'resume' });
    usePlay.setState({ status: 'running' });
  }
}

// --- script metadata (exported properties) ---------------------------------------------------------------

let describeCache: { key: string; result: Promise<Record<string, ScriptInfo>> } | null = null;

/**
 * Exported properties and base types of every script. The compiled bundle is loaded in a
 * throw-away sandboxed frame (never in the editor itself).
 */
export function describeScripts(scripts: Record<string, string>): Promise<Record<string, ScriptInfo>> {
  const key = JSON.stringify(scripts);
  if (describeCache?.key === key) return describeCache.result;
  const result = (async () => {
    const compiled = await compileProjectScripts(scripts);
    if (!compiled.ok) return {};
    return new Promise<Record<string, ScriptInfo>>((resolve) => {
      const f = document.createElement('iframe');
      f.setAttribute('sandbox', 'allow-scripts');
      f.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
      f.src = '/player.html';
      const done = (r: Record<string, ScriptInfo>) => {
        window.removeEventListener('message', onMsg);
        clearTimeout(timer);
        f.remove();
        resolve(r);
      };
      const onMsg = (e: MessageEvent<PlayerToEditor>) => {
        if (e.source !== f.contentWindow || e.data?.source !== PLAYER_SOURCE) return;
        if (e.data.type === 'ready') f.contentWindow!.postMessage({ source: EDITOR_SOURCE, type: 'describe', scriptsJs: compiled.js, paths: compiled.scripts } satisfies EditorToPlayer, '*');
        else if (e.data.type === 'described') done(Object.fromEntries(e.data.scripts.map((s) => [s.path, s])));
        else if (e.data.type === 'fatal') done({});
      };
      const timer = setTimeout(() => done({}), 15_000);
      window.addEventListener('message', onMsg);
      document.body.appendChild(f);
    });
  })();
  describeCache = { key, result };
  return result;
}
