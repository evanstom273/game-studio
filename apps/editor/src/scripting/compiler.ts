/**
 * Script compilation in the editor: esbuild-wasm (loaded on first use, runs in a Web Worker).
 * The compiled bundle is only ever executed inside the sandboxed player frame.
 */
import * as esbuild from 'esbuild-wasm';
import wasmURL from 'esbuild-wasm/esbuild.wasm?url';
import { checkScript, compileScripts, type CompileResult, type EsbuildLike } from '@gs/scripting';
import { expandVisualScripts, isVisualScriptPath } from '@gs/visual';
import type { Diagnostic } from '@gs/project';
import { useConsole } from '@editor/store/console';

let ready: Promise<void> | null = null;
function init() {
  return (ready ??= esbuild.initialize({ wasmURL, worker: true }).catch((e) => {
    ready = null;
    throw e;
  }));
}

const api = esbuild as unknown as EsbuildLike;
let lastKey = '';
let lastResult: Promise<CompileResult> | null = null;

/** Compiles all scripts (cached while the sources are unchanged) and publishes diagnostics. */
export async function compileProjectScripts(scripts: Record<string, string>, opts: { minify?: boolean } = {}): Promise<CompileResult> {
  const key = JSON.stringify([opts.minify ?? false, scripts]);
  if (key !== lastKey || !lastResult) {
    lastKey = key;
    lastResult = (async () => {
      // Visual scripts (.vgraph) become ordinary TypeScript first.
      const expanded = expandVisualScripts(scripts);
      await init();
      const r = await compileScripts(api, expanded.scripts, opts);
      if (expanded.ok) return { ...r, diagnostics: [...expanded.diagnostics, ...r.diagnostics] };
      return { ok: false, js: '', diagnostics: [...expanded.diagnostics, ...r.diagnostics.filter((d) => !d.file || !isVisualScriptPath(d.file))], scripts: Object.keys(scripts) };
    })();
  }
  const result = await lastResult;
  const byFile: Record<string, Diagnostic[]> = {};
  for (const path of Object.keys(scripts)) byFile[path] = [];
  for (const d of result.diagnostics) (byFile[d.file ?? '(bundle)'] ??= []).push(d);
  useConsole.getState().setScriptDiagnostics(byFile);
  return result;
}

/** Syntax check of one file while it is being edited. */
export async function checkScriptSource(path: string, source: string): Promise<Diagnostic[]> {
  if (isVisualScriptPath(path)) return expandVisualScripts({ [path]: source }).diagnostics;
  await init();
  return checkScript(api, path, source);
}
