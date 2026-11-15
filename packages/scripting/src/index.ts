/**
 * @gs/scripting — compiles a project's TypeScript scripts into one classic-script bundle
 * (game.js) that registers each script's default export with the runtime.
 *
 * It takes an esbuild instance as a parameter: esbuild-wasm in the editor (in a Web Worker),
 * native esbuild in tests and tooling. Scripts are never evaluated by the editor itself — the
 * bundle only runs inside the sandboxed player frame or an exported game (see docs/SCRIPTING.md).
 *
 * Imports a script may use:
 *   - "gamestudio"           the engine API (resolved to the runtime's global, not bundled)
 *   - "./other" / "../x/y"   other scripts of the project (.ts / .js, extension optional)
 * Anything else (npm packages, URLs) is reported as an error for now.
 */
import type { Diagnostic } from '@gs/project';

/** The subset of the esbuild API we use (identical in esbuild and esbuild-wasm). */
export interface EsbuildLike {
  build(options: Record<string, unknown>): Promise<{ outputFiles?: { text: string }[]; errors: EsbuildMessage[]; warnings: EsbuildMessage[] }>;
  transform(input: string, options: Record<string, unknown>): Promise<{ code: string; warnings: EsbuildMessage[] }>;
}

interface EsbuildMessage {
  text: string;
  location?: { file: string; line: number; column: number; lineText?: string } | null;
  notes?: { text: string }[];
}

export const ENGINE_MODULE = 'gamestudio';
const ENTRY = '__gs_entry__.ts';
const EXTS = ['', '.ts', '.js', '.vgraph', '/index.ts', '/index.js'];

export interface CompileResult {
  ok: boolean;
  /** The bundle (empty when compilation failed). */
  js: string;
  diagnostics: Diagnostic[];
  /** Script paths in the bundle. */
  scripts: string[];
}

function toDiagnostic(m: EsbuildMessage, severity: 'error' | 'warning'): Diagnostic {
  const file = m.location?.file?.replace(/^(gs:)+/, '');
  return {
    severity,
    message: m.text + (m.notes?.length ? ` (${m.notes.map((n) => n.text).join('; ')})` : ''),
    source: 'script',
    ...(file && !file.endsWith(ENTRY) ? { file } : {}),
    ...(m.location ? { line: m.location.line, column: m.location.column + 1 } : {}),
  };
}

function resolveIn(scripts: Record<string, string>, from: string, spec: string): string | null {
  const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
  const parts = dir ? dir.split('/') : [];
  for (const seg of spec.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  const base = parts.join('/');
  for (const ext of EXTS) if (scripts[base + ext] !== undefined) return base + ext;
  return null;
}

/** Bundles every script (path → source) into game.js. */
export async function compileScripts(esbuild: EsbuildLike, scripts: Record<string, string>, opts: { minify?: boolean } = {}): Promise<CompileResult> {
  const paths = Object.keys(scripts).sort();
  if (!paths.length) return { ok: true, js: '/* no scripts */', diagnostics: [], scripts: [] };
  const entry = [
    `const __gs = globalThis.GameStudio;`,
    // Read "default" dynamically: helper modules without one are fine (they are just not scripts).
    `const __default = (m: Record<string, unknown>) => m['default'];`,
    ...paths.map((p, i) => `import * as __m${i} from ${JSON.stringify('gs:' + p)};`),
    ...paths.map((p, i) => `if (typeof __default(__m${i}) === 'function') __gs.registerScript(${JSON.stringify(p)}, __default(__m${i}));`),
  ].join('\n');
  try {
    const result = await esbuild.build({
      stdin: { contents: entry, loader: 'ts', sourcefile: ENTRY, resolveDir: '/' },
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      target: 'es2022',
      minify: !!opts.minify,
      sourcemap: opts.minify ? false : 'inline',
      logLevel: 'silent',
      tsconfigRaw: { compilerOptions: { useDefineForClassFields: true, experimentalDecorators: false } },
      plugins: [
        {
          name: 'gs-project',
          setup(b: { onResolve: (o: object, cb: (a: { path: string; importer: string }) => unknown) => void; onLoad: (o: object, cb: (a: { path: string }) => unknown) => void }) {
            b.onResolve({ filter: /.*/ }, (args) => {
              if (args.path === ENGINE_MODULE) return { path: ENGINE_MODULE, namespace: 'gs-engine' };
              if (args.path.startsWith('gs:')) return { path: args.path, namespace: 'gs' };
              if (args.path.startsWith('.')) {
                const from = args.importer.replace(/^gs:/, '');
                const hit = resolveIn(scripts, from, args.path);
                if (hit) return { path: 'gs:' + hit, namespace: 'gs' };
                return { errors: [{ text: `Cannot find "${args.path}" (imported from ${from})` }] };
              }
              return { errors: [{ text: `Only "${ENGINE_MODULE}" and other project scripts can be imported (got "${args.path}"). npm packages are not supported yet.` }] };
            });
            b.onLoad({ filter: /.*/, namespace: 'gs-engine' }, () => ({ contents: 'module.exports = globalThis.GameStudio;', loader: 'js' }));
            b.onLoad({ filter: /.*/, namespace: 'gs' }, (args) => {
              const path = args.path.slice(3);
              return { contents: scripts[path], loader: path.endsWith('.js') ? 'js' : 'ts' };
            });
          },
        },
      ],
    });
    const diagnostics = [...result.errors.map((m) => toDiagnostic(m, 'error')), ...result.warnings.map((m) => toDiagnostic(m, 'warning'))];
    const js = result.outputFiles?.[0]?.text ?? '';
    return { ok: result.errors.length === 0 && !!js, js, diagnostics, scripts: paths };
  } catch (e) {
    const failure = e as { errors?: EsbuildMessage[]; warnings?: EsbuildMessage[] };
    if (failure.errors) return { ok: false, js: '', diagnostics: [...failure.errors.map((m) => toDiagnostic(m, 'error')), ...(failure.warnings ?? []).map((m) => toDiagnostic(m, 'warning'))], scripts: paths };
    return { ok: false, js: '', diagnostics: [{ severity: 'error', message: e instanceof Error ? e.message : String(e), source: 'script' }], scripts: paths };
  }
}

/** Fast syntax check of one file (used while typing). */
export async function checkScript(esbuild: EsbuildLike, path: string, source: string): Promise<Diagnostic[]> {
  try {
    const r = await esbuild.transform(source, { loader: path.endsWith('.js') ? 'js' : 'ts', sourcefile: path, logLevel: 'silent' });
    return r.warnings.map((m) => toDiagnostic(m, 'warning'));
  } catch (e) {
    const errs = (e as { errors?: EsbuildMessage[] }).errors;
    return errs ? errs.map((m) => toDiagnostic(m, 'error')) : [{ severity: 'error', message: String(e), source: 'script', file: path }];
  }
}

/** A starting point for a new script attached to a node of `baseType`. */
export function scriptTemplate(baseType: string, className: string) {
  const physics = /Body(2D|3D)$/.test(baseType);
  return `import { ${baseType}${physics ? ', Input' : ''} } from '${ENGINE_MODULE}';

export default class ${className} extends ${baseType} {
  // Fields listed here appear in the inspector.
  static exports = ['speed'];
  speed = ${baseType.endsWith('3D') ? 5 : 200};

  /** Called once when the node and its children are ready. */
  override _ready() {}

  /** Called every frame. */
  override _process(delta: number) {}
${physics ? `
  /** Called every physics tick (60 times a second by default). */
  override _physicsProcess(delta: number) {}
` : ''}}
`;
}

export { API_COMPLETIONS, type ApiEntry } from './api';
