import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';
import { aliases } from '../../aliases.ts';
import { runtimeBundles } from './plugins/runtime-bundles.ts';
import { mcpDevRelay } from './plugins/mcp-dev.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    react(),
    tailwindcss(),
    runtimeBundles(repoRoot),
    mcpDevRelay(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      includeAssets: ['favicon.svg', 'icon-192.png', 'icon-512.png'],
      manifest: {
        name: 'Game Studio',
        short_name: 'Game Studio',
        description: 'Make 2D and 3D games in the browser, on any device.',
        theme_color: '#161a22',
        background_color: '#0f1218',
        display: 'standalone',
        orientation: 'any',
        icons: [
          { src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      workbox: {
        // The app shell and the core runtime are precached. The big pieces (the TypeScript
        // compiler's WebAssembly, physics) are cached the first time they are used, so the first
        // visit on a phone stays light and everything still works offline afterwards.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        globIgnores: ['**/runtime/gs-physics*.js'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        runtimeCaching: [
          { urlPattern: /\/assets\/.*\.wasm$/, handler: 'CacheFirst', options: { cacheName: 'gs-wasm', expiration: { maxEntries: 4 } } },
          { urlPattern: /\/runtime\/gs-physics(2d|3d)\.js$/, handler: 'StaleWhileRevalidate', options: { cacheName: 'gs-physics' } },
        ],
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/mcp\//, /^\/bridge\//, /^\/player\.html/, /^\/runtime\//],
      },
    }),
  ],
  resolve: { alias: aliases },
  worker: { format: 'es' },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/three')) return 'three';
          if (id.includes('node_modules/pixi.js') || id.includes('node_modules/@pixi')) return 'pixi';
          if (id.includes('node_modules/@codemirror') || id.includes('node_modules/@lezer')) return 'codemirror';
          return undefined;
        },
      },
    },
  },
  server: { port: 5173, host: true },
  preview: { port: 4173 },
});
