/**
 * Script compilation in the editor: esbuild-wasm (loaded on first use, runs in a Web Worker).
 * The compiled bundle is only ever executed inside the sandboxed player frame.
 */
import * as esbuild from 'esbuild-wasm';
import wasmURL from 'esbuild-wasm/esbuild.wasm?url';
import { checkScript, compileScripts, type CompileResult, type EsbuildLike } from '@gs/scripting';
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
      await init();
      return compileScripts(api, scripts, opts);
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
  await init();
  return checkScript(api, path, source);
}
