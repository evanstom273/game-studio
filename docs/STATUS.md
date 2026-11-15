# Status

"Verified" means an automated test covers it, or it was checked by running the real thing.

## Verified

- **Core engine**: node lifecycle in Godot order, transforms (2D through Node2D parents only, 3D YXZ Euler), fixed-timestep physics ticks, timers, tweens, input actions (just-pressed works in both `_process` and `_physicsProcess`), queueFree, nested scene instances, signal connections. Scripts may extend the node's type or any ancestor, as in Godot. (unit tests)
- **Command layer**: 26 ops, atomic batches, `$ref` chaining, validation against the node registry, reference rewriting on rename and delete, no-op edits leave no undo step. (unit tests)
- **Physics (Rapier)**: characters land, slide on floors and stop at walls; rigid bodies settle; areas report enter and exit. Grounded characters move at full speed (fixed a ~14% loss caused by the controller catching on floors). (unit tests run real Rapier)
- **Scripting**: starter games compile with esbuild, load into the runtime and play end to end. Syntax errors are reported with file and line, and imports outside the project are refused. (unit tests)
- **Editor** (Playwright, Chromium): create a project, add and edit nodes, undo/redo, persistence across reload, play 2D (with keyboard input) and 3D in the sandboxed player, script errors shown in the console, web and archive export downloads.
- **Layouts** (Playwright): phone portrait and landscape (compact, bottom sheets), unfolded foldable (medium dock), folding and unfolding in the same session, dual-screen spanning (split across segments), desktop (wide).
- **MCP** (Playwright with the real MCP SDK client): the brief's scenario. Create a 3D scene with floor, light and a scripted character, check diagnostics, run it, get zero errors. Atomic batch rejection, revision conflicts, undo of AI edits, read-only permission enforced.
- **Cloudflare**: `wrangler dev` serves the build. The MCP endpoint answers through the Durable Object (401 without a key, `E_NOT_CONNECTED` with no editor attached), the SPA fallback works, and the player gets its own CSP on both `/player.html` and `/player`.

- **Production setup**: the full e2e suite (11 tests) passes against `wrangler dev` serving the production build, with the production security headers and the Durable Object relay (`GS_E2E_URL=http://127.0.0.1:8787 npm run test:e2e`).

- **Visual scripting**: graphs compile to engine scripts, are bundled by esbuild and run in the engine (a graph-built character moves); the AI builds visual scripts over MCP with the editor closed and they run in the browser player. (unit tests, Playwright with the real MCP client)
- **GitHub**: commit, pull with merging, branches, PRs, Actions, Pages and Cloudflare deploy setup, and the 26 MCP git tools — against an in-memory fake GitHub only (unit tests). See [GITHUB.md](GITHUB.md).

## Not verified yet

- GitHub and Cloudflare deploys against the real services (only a fake GitHub so far).

- Real phones and foldables (only emulated viewports), iOS Safari, Firefox.
- An actual `wrangler deploy` and connecting claude.ai to it.
- Audio playback, glTF model import, and gamepads have code but no automated test.

## Known limitations

- Scripts are syntax-checked, not type-checked (esbuild strips types).
- npm packages can't be imported from scripts yet.
- TileMap, particles, 2D lights, AnimationPlayer, UI controls, autoloads and editable children of instances aren't implemented.
- The AI connection talks to the open editor tab. On phones, browsers pause background tabs, so keep Game Studio in front while an assistant works.
- Collision layers 1–16 only (Rapier interaction groups).
- In play mode, games run in an opaque-origin sandbox, so `localStorage` isn't available to game scripts (exported games have it).
- Desktop and mobile app exports (Tauri 2) are planned, not built.
