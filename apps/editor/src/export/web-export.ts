/**
 * Web export: a standalone playable build as a zip.
 *
 *   index.html            loads the runtime, the modules this game uses, and game.js
 *   runtime/*.js          the engine (only the modules the game needs)
 *   game.js               the compiled scripts (minified)
 *   game.json             scenes, settings and the asset list
 *   assets/<path>         the project's files
 *
 * No editor code is included. Upload the folder (or zip) to any static host — itch.io,
 * Cloudflare, GitHub Pages — or serve it locally with any web server.
 */
import { strToU8, zipSync, type Zippable } from 'fflate';
import { GameStudioError } from '@gs/shared';
import { requiredModules, type GameData } from '@gs/player';
import { projectDiagnostics, type ProjectDoc } from '@gs/project';
import { compileProjectScripts } from '@editor/scripting/compiler';
import { assetBlobByHash } from '@editor/services/assets';

const MODULE_FILE = { render2d: 'gs-render2d.js', render3d: 'gs-render3d.js', physics2d: 'gs-physics2d.js', physics3d: 'gs-physics3d.js' } as const;

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export interface WebExport {
  zip: Uint8Array;
  files: { path: string; size: number }[];
  modules: string[];
}

export async function buildWebExport(project: ProjectDoc): Promise<WebExport> {
  const main = project.settings.mainScene;
  if (!main || !project.scenes[main]) throw new GameStudioError('E_NO_MAIN_SCENE', 'Set a main scene before exporting (Project → Settings).');
  const blocking = projectDiagnostics(project).filter((d) => d.severity === 'error');
  if (blocking.length) throw new GameStudioError('E_PROJECT_ERRORS', `Fix these problems first: ${blocking.slice(0, 3).map((d) => d.message).join(' · ')}`, { diagnostics: blocking });
  const compiled = await compileProjectScripts(project.scripts, { minify: true });
  if (!compiled.ok) throw new GameStudioError('E_COMPILE', `Scripts have errors: ${compiled.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.file}:${d.line} ${d.message}`).join(' · ')}`);
  const modules = requiredModules(project.scenes);
  const runtimeFiles = ['gs-runtime.js', ...modules.map((m) => MODULE_FILE[m])];
  const files: Zippable = {};
  for (const name of runtimeFiles) {
    const res = await fetch(`/runtime/${name}`);
    if (!res.ok) throw new GameStudioError('E_RUNTIME_MISSING', `Could not fetch the runtime file ${name} (${res.status}). Are you offline with an old cache?`);
    files[`runtime/${name}`] = [new Uint8Array(await res.arrayBuffer()), { level: 9 }];
  }
  const data: GameData = { name: project.name, settings: project.settings, scenes: project.scenes, assets: project.assets, startScene: main };
  files['game.json'] = strToU8(JSON.stringify(data));
  files['game.js'] = strToU8(compiled.js);
  for (const a of Object.values(project.assets)) {
    const blob = assetBlobByHash(a.hash);
    if (!blob) throw new GameStudioError('E_MISSING_ASSETS', `The data of "${a.path}" is missing`);
    files[`assets/${a.path}`] = [new Uint8Array(await blob.arrayBuffer()), { level: 0 }];
  }
  const bg = project.settings.display.background;
  files['index.html'] = strToU8(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
<meta name="theme-color" content="${escapeHtml(bg)}">
<title>${escapeHtml(project.name)}</title>
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden;touch-action:none;-webkit-user-select:none;user-select:none}#game{position:fixed;inset:0}</style>
${runtimeFiles.map((f) => `<script src="runtime/${f}"></script>`).join('\n')}
<script src="game.js"></script>
</head>
<body data-gs-game="game.json">
<div id="game"></div>
</body>
</html>
`);
  files['README.txt'] = strToU8(`${project.name} — made with Game Studio.

Upload this folder to any static web host (itch.io "HTML" project, Cloudflare, GitHub Pages, Netlify…)
or run a local web server in it, e.g.  npx serve .   then open the address it prints.
Opening index.html directly from disk (file://) does not work: browsers block loading game data that way.
`);
  const zip = zipSync(files);
  const list = Object.entries(files).map(([path, v]) => ({ path, size: (Array.isArray(v) ? (v[0] as Uint8Array) : (v as Uint8Array)).length }));
  return { zip, files: list, modules };
}
