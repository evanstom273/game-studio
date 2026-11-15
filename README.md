# Game Studio

A Godot-inspired 2D and 3D game engine and editor that runs in the browser: phones, foldables, tablets and desktops. You script games in TypeScript, export them as standalone web games, and AI assistants can work on them through MCP.

## Run it locally

```bash
npm install
npm run dev          # http://localhost:5173 (editor, game runtime, and a local MCP endpoint)
```

To open it on your phone, use the "Network" address Vite prints (same Wi-Fi).

Production build plus a local Cloudflare Worker, the same as the deployed setup:

```bash
npm run cf:dev       # build + wrangler dev on http://localhost:8787
npm run cf:deploy    # build + wrangler deploy (run `npx wrangler login` once first)
```

## Try this first

1. **New project** → pick *2D platformer* or *3D starter*. Both are playable straight away.
2. Press ▶ (F5). Arrow keys / WASD, Space to jump. On touch screens an on-screen stick and buttons appear.
3. Select a node in the scene tree or the viewport and change it in the inspector. Drag in the viewport with the move/rotate/scale tools (Q/W/E/R). Ctrl+Z undoes.
4. Open `scripts/player.ts` and change `speed` or `jumpVelocity`, then play again.
5. **AI connection** (robot button) → switch it on and copy the link. In Claude: Settings → Connectors → Add custom connector. In Claude Code: `claude mcp add --transport http game-studio <link>`.

## What's here

| Package | What it is |
| --- | --- |
| `packages/shared` | Math (vectors, quaternions, matrices, colours), signals, ids, errors, paths |
| `packages/core` | The engine: nodes, scene tree, lifecycle, fixed-timestep loop, input, tweens, timers, resources, property registry, scene instantiation, scripts |
| `packages/project` | Project format (zod-validated, versioned, migrated), **the command layer** (every edit from the UI and from MCP), templates, `.gsproj` archives |
| `packages/render2d` | 2D renderer (PixiJS v8 as a drawing backend) |
| `packages/render3d` | 3D renderer (three.js): primitives, glTF, materials, lights and shadows |
| `packages/physics2d`, `physics3d` | Rapier physics servers: bodies, character move-and-slide, areas |
| `packages/audio` | Web Audio server |
| `packages/scripting` | TypeScript → game bundle (esbuild / esbuild-wasm), editor autocomplete data |
| `packages/player` | Boots a game: shared by play mode and exported games |
| `packages/git` | GitHub sync engine: repo ↔ project mapping, commit, pull with merging, branches, deploys (see [docs/GITHUB.md](docs/GITHUB.md)) |
| `packages/visual` | Visual scripting: Coding Studio's graph packages (`@cs/*`) plus the Game Studio language (`@gs/visual`, see [docs/VISUAL_SCRIPTING.md](docs/VISUAL_SCRIPTING.md)) |
| `packages/mcp` | MCP tools (scenes, scripts, visual scripts, GitHub), bridge protocol, relay core, cloud copy |
| `apps/editor` | The React editor (Vite, Tailwind, Dexie/IndexedDB, CodeMirror) |
| `worker` | Cloudflare Worker + Durable Object MCP relay |

## Checks

```bash
npm run typecheck && npm run lint && npm test && npm run build
npm run test:e2e     # Playwright: editor, play 2D/3D, persistence, export, phone/foldable/dual-screen layouts, MCP end to end
```

## Status

What's working and tested, what isn't, and what's next: see [docs/STATUS.md](docs/STATUS.md).
