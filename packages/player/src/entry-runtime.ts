/**
 * The runtime bundle (runtime/gs-runtime.js), loaded as a classic script by exported games and by
 * the editor's player frame. It defines `globalThis.GameStudio`, the API scripts import as
 * "gamestudio", and then either waits for the editor (player frame) or loads game.json (export).
 */
import * as shared from '@gs/shared';
import * as core from '@gs/core';
import { WebAudioServer } from '@gs/audio';
import { bootGame, type GameHandle, type RuntimeModules } from './boot';
import { EDITOR_SOURCE, PLAYER_SOURCE, type EditorToPlayer, type PlayerToEditor, type WithoutSource } from './protocol';
import type { GameData, RuntimeModuleName } from './game-data';

const scripts = new core.ScriptRegistry();
const modules: RuntimeModules = {};

const api = {
  ...shared,
  ...core,
  WebAudioServer,
  version: '0.1.0',
  /** Called by the compiled game scripts bundle. */
  registerScript(path: string, cls: unknown) {
    scripts.register(path, cls);
  },
  /** Called by the compiled bundle when a script throws while loading. */
  scriptLoadError(path: string, error: unknown) {
    scripts.loadErrors.set(path, `${path}: ${shared.errorMessage(error)}`);
  },
  scripts,
  modules,
  boot: bootGame,
  __modules: { '@gs/shared': shared, '@gs/core': core },
};

declare global {
  // eslint-disable-next-line no-var
  var GameStudio: typeof api;
}
globalThis.GameStudio = api;

function loadScript(src: string) {
  return new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(s);
  });
}

const MODULE_FILES: Record<RuntimeModuleName, string> = {
  render2d: 'runtime/gs-render2d.js',
  render3d: 'runtime/gs-render3d.js',
  physics2d: 'runtime/gs-physics2d.js',
  physics3d: 'runtime/gs-physics3d.js',
};

/** Player frame: driven by the editor over postMessage. */
function runAsFrame() {
  const post = (msg: WithoutSource<PlayerToEditor>) => window.parent.postMessage({ source: PLAYER_SOURCE, ...msg }, '*');
  const logEntry = (level: core.LogLevel, message: string, source?: string, stack?: string) => post({ type: 'log', entry: { level, message, source, stack, time: Date.now() } });
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      orig(...args);
      logEntry(level, args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : safe(a))).join(' '));
    };
  }
  window.addEventListener('error', (e) => logEntry('error', e.message, e.filename ? `${e.filename}:${e.lineno}` : undefined, e.error?.stack));
  window.addEventListener('unhandledrejection', (e) => logEntry('error', `Unhandled promise rejection: ${shared.errorMessage(e.reason)}`, undefined, e.reason?.stack));

  let game: GameHandle | null = null;
  let statsTimer = 0;
  window.addEventListener('message', async (e: MessageEvent<EditorToPlayer>) => {
    if (e.source !== window.parent || e.data?.source !== EDITOR_SOURCE) return;
    const msg = e.data;
    try {
      if (msg.type === 'boot') {
        for (const m of msg.modules) await loadScript(MODULE_FILES[m]);
        await loadScript(URL.createObjectURL(new Blob([msg.scriptsJs], { type: 'text/javascript' })));
        const urls = new Map(Object.entries(msg.assets).map(([p, b]) => [p, URL.createObjectURL(b)]));
        const container = document.getElementById('game')!;
        game = await bootGame({ container, data: msg.data, assetUrl: (p) => urls.get(p) ?? null, scripts, modules, onLog: (entry) => post({ type: 'log', entry }), debugShapes: msg.debugShapes });
        post({ type: 'started', modules: msg.modules });
        statsTimer = window.setInterval(() => game && post({ type: 'stats', fps: game.engine.fps, nodes: game.nodeCount(), time: game.engine.time }), 1000);
      } else if (msg.type === 'describe') {
        await loadScript(URL.createObjectURL(new Blob([msg.scriptsJs], { type: 'text/javascript' })));
        post({ type: 'described', scripts: msg.paths.map((p) => scripts.describe(p, core.nodeTypes)) });
      } else if (msg.type === 'pause') game?.pause();
      else if (msg.type === 'resume') game?.resume();
    } catch (err) {
      post({ type: 'fatal', message: shared.errorMessage(err), stack: err instanceof Error ? err.stack : undefined });
    }
  });
  window.addEventListener('pagehide', () => {
    clearInterval(statsTimer);
    game?.stop();
  });
  post({ type: 'ready' });
}

/** Exported game: <body data-gs-game="game.json">. */
async function runExported(dataUrl: string) {
  const container = document.getElementById('game') ?? document.body;
  try {
    const data = (await (await fetch(dataUrl)).json()) as GameData;
    document.title = data.name;
    await bootGame({ container, data, assetUrl: (p) => (data.assets[p] ? `assets/${p.split('/').map(encodeURIComponent).join('/')}` : null), scripts, modules, onLog: (e) => (e.level === 'error' ? console.error(e.source ? `${e.message} (${e.source})` : e.message) : undefined) });
  } catch (e) {
    container.innerHTML = '';
    const p = document.createElement('pre');
    p.style.cssText = 'color:#f87171;font:14px monospace;padding:16px;white-space:pre-wrap';
    p.textContent = `The game could not start: ${shared.errorMessage(e)}${location.protocol === 'file:' ? '\n\nExported games must be served over http(s) — open them through a web server (e.g. "npx serve" in this folder) or upload them to a host.' : ''}`;
    container.appendChild(p);
  }
}

function safe(v: unknown) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function start() {
  const body = document.body;
  if (body.dataset.gsPlayerFrame !== undefined) runAsFrame();
  else if (body.dataset.gsGame) void runExported(body.dataset.gsGame);
}
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
}
