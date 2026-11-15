/**
 * Builds the game runtime as classic-script bundles (esbuild, IIFE):
 *
 *   runtime/gs-runtime.js    core + player + audio; defines globalThis.GameStudio
 *   runtime/gs-render2d.js   PixiJS renderer          (only games with 2D nodes)
 *   runtime/gs-render3d.js   three.js renderer        (only games with 3D nodes)
 *   runtime/gs-physics2d.js  Rapier 2D                (only games with 2D physics)
 *   runtime/gs-physics3d.js  Rapier 3D                (only games with 3D physics)
 *
 * The module bundles take @gs/core and @gs/shared from the runtime bundle (globalThis.GameStudio)
 * instead of including their own copies, so classes are shared (instanceof works across them).
 * The same files run the editor's play mode and exported games.
 *
 * Dev: served from memory at /runtime/*, rebuilt when package sources change.
 * Build: emitted into dist/runtime/.
 */
import { build, type Plugin as EsbuildPlugin } from 'esbuild';
import type { Plugin } from 'vite';
import { aliases } from '../../../aliases';

export const RUNTIME_BUNDLES: Record<string, { entry: string; shared: boolean }> = {
  'gs-runtime.js': { entry: 'packages/player/src/entry-runtime.ts', shared: false },
  'gs-render2d.js': { entry: 'packages/render2d/src/entry.ts', shared: true },
  'gs-render3d.js': { entry: 'packages/render3d/src/entry.ts', shared: true },
  'gs-physics2d.js': { entry: 'packages/physics2d/src/entry.ts', shared: true },
  'gs-physics3d.js': { entry: 'packages/physics3d/src/entry.ts', shared: true },
};

const SHARED = new Set(['@gs/core', '@gs/shared']);

function resolvePlugin(useGlobals: boolean): EsbuildPlugin {
  return {
    name: 'gs-resolve',
    setup(b) {
      b.onResolve({ filter: /^@gs\// }, (args) => {
        if (useGlobals && SHARED.has(args.path)) return { path: args.path, namespace: 'gs-global' };
        const target = aliases[args.path];
        return target ? { path: target } : undefined;
      });
      b.onLoad({ filter: /.*/, namespace: 'gs-global' }, (args) => ({
        contents: `module.exports = globalThis.GameStudio.__modules[${JSON.stringify(args.path)}];`,
        loader: 'js',
      }));
    },
  };
}

export async function buildRuntimeBundle(root: string, name: string, minify: boolean): Promise<string> {
  const spec = RUNTIME_BUNDLES[name];
  const result = await build({
    absWorkingDir: root,
    entryPoints: [spec.entry],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    write: false,
    minify,
    legalComments: 'none',
    sourcemap: minify ? false : 'inline',
    define: { 'process.env.NODE_ENV': JSON.stringify(minify ? 'production' : 'development') },
    plugins: [resolvePlugin(spec.shared)],
    logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}

export function runtimeBundles(root: string): Plugin {
  const cache = new Map<string, Promise<string>>();
  return {
    name: 'gs-runtime-bundles',
    configureServer(server) {
      server.watcher.on('change', (file) => {
        if (file.includes('/packages/')) cache.clear();
      });
      server.middlewares.use(async (req, res, next) => {
        const m = /^\/runtime\/([\w-]+\.js)(\?.*)?$/.exec(req.url ?? '');
        if (!m || !RUNTIME_BUNDLES[m[1]]) return next();
        try {
          let p = cache.get(m[1]);
          if (!p) cache.set(m[1], (p = buildRuntimeBundle(root, m[1], false)));
          const js = await p;
          res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.end(js);
        } catch (e) {
          cache.delete(m[1]);
          res.statusCode = 500;
          res.end(`/* runtime build failed: ${String(e).replace(/\*\//g, '* /')} */`);
        }
      });
    },
    async generateBundle() {
      for (const name of Object.keys(RUNTIME_BUNDLES)) {
        this.emitFile({ type: 'asset', fileName: `runtime/${name}`, source: await buildRuntimeBundle(root, name, true) });
      }
    },
  };
}
