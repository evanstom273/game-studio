import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** Package aliases shared by Vite, Vitest and esbuild. Keep in sync with tsconfig.json "paths". */
export const PACKAGES = ['shared', 'core', 'render2d', 'render3d', 'physics2d', 'physics3d', 'audio', 'project', 'scripting', 'player', 'exporter', 'mcp'] as const;

export const aliases: Record<string, string> = {
  ...Object.fromEntries(PACKAGES.map((p) => [`@gs/${p}`, r(`./packages/${p}/src/index.ts`)])),
  '@editor': r('./apps/editor/src'),
};
