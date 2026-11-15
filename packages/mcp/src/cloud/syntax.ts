/**
 * Script checks that can run in a Cloudflare Worker (where esbuild can't): TypeScript syntax via
 * @babel/parser, plus the same import rules the real compiler enforces. Types are not checked here
 * either — the editor's compiler reports the rest when it runs the game.
 */
import { parse } from '@babel/parser';
import type { Diagnostic } from '@gs/project';

const EXTS = ['', '.ts', '.js', '/index.ts', '/index.js'];

function resolve(scripts: Record<string, string>, from: string, spec: string) {
  const parts = from.includes('/') ? from.slice(0, from.lastIndexOf('/')).split('/') : [];
  for (const seg of spec.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  const base = parts.join('/');
  return EXTS.map((e) => base + e).find((p) => scripts[p] !== undefined) ?? null;
}

interface BabelError {
  message: string;
  loc?: { line: number; column: number };
}

export function checkScripts(scripts: Record<string, string>, only?: string[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const [path, source] of Object.entries(scripts)) {
    if (only && !only.includes(path)) continue;
    let ast: ReturnType<typeof parse>;
    try {
      ast = parse(source, { sourceType: 'module', plugins: path.endsWith('.js') ? [] : ['typescript'], errorRecovery: true });
    } catch (e) {
      const err = e as BabelError;
      out.push({ severity: 'error', message: err.message.replace(/\s*\(\d+:\d+\)$/, ''), file: path, line: err.loc?.line, column: (err.loc?.column ?? 0) + 1, source: 'script' });
      continue;
    }
    for (const err of (ast.errors ?? []) as unknown as BabelError[]) out.push({ severity: 'error', message: err.message.replace(/\s*\(\d+:\d+\)$/, ''), file: path, line: err.loc?.line, column: (err.loc?.column ?? 0) + 1, source: 'script' });
    let hasDefault = false;
    for (const node of ast.program.body) {
      if (node.type === 'ExportDefaultDeclaration') hasDefault = true;
      const src = node.type === 'ImportDeclaration' || ((node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') && node.source) ? (node as { source: { value: string } }).source.value : null;
      if (!src) continue;
      const line = node.loc?.start.line;
      if (src === 'gamestudio') continue;
      if (src.startsWith('.')) {
        if (!resolve(scripts, path, src)) out.push({ severity: 'error', message: `Cannot find "${src}" (imported from ${path})`, file: path, line, source: 'script' });
      } else out.push({ severity: 'error', message: `Only "gamestudio" and other project scripts can be imported (got "${src}"). npm packages are not supported yet.`, file: path, line, source: 'script' });
    }
    void hasDefault;
  }
  return out;
}
