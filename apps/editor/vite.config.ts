import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';
import { aliases } from '../../aliases';
import { runtimeBundles } from './plugins/runtime-bundles';
import { mcpDevRelay } from './plugins/mcp-dev';

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
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,wasm}'],
        // Physics bundles are large; precache them too so play mode works offline.
        maximumFileSizeToCacheInBytes: 16 * 1024 * 1024,
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
