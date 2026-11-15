/**
 * @gs/visual — visual scripting for Game Studio (Blueprint-style graphs), built on Coding Studio's
 * graph packages (copied into packages/visual/*). A visual script is a `.vgraph` file holding a
 * ScriptDoc as JSON; before the game is built each one is compiled to an ordinary TypeScript
 * script, so the runtime, exports and the AI tools treat both kinds the same.
 */
import type { Diagnostic as GraphDiagnostic, ScriptDoc } from '@cs/graph-core';
import { compileScript, type Toolchain } from '@cs/compiler-core';
import { NodeRegistry } from '@cs/node-registry';
import { CORE_NODES } from '@cs/node-registry/core-nodes';
import { applyOps, createEventFunction, createScript, OpError, PROJECT_FORMAT, PROJECT_SCHEMA_VERSION, type EditOp, type Project } from '@cs/project-format';
import { DEFAULT_COMPILER_SETTINGS } from '@cs/language-sdk';
import type { Diagnostic } from '@gs/project';
import { gameStudioAdapter } from './adapter';

export { gameStudioAdapter, ENGINE_EXPORTS, EVENTS } from './adapter';
export { gameStudioNodes, humanize } from './nodes';
export { engineApi, type ApiMember } from './api';
export { gameStudioTypes } from './types';

export const VISUAL_SCRIPT_EXT = '.vgraph';
export const VISUAL_FORMAT = 'gamestudio-visual-script';

export function isVisualScriptPath(path: string) {
  return path.endsWith(VISUAL_SCRIPT_EXT);
}

let toolchain: { size: number; tc: Toolchain } | null = null;

/** Core nodes + the Game Studio pack (rebuilt when new engine node types were registered). */
export function gameStudioToolchain(): Toolchain {
  const size = gameStudioAdapter.types.pickerTypes().length;
  if (toolchain && toolchain.size === size) return toolchain.tc;
  const registry = new NodeRegistry();
  registry.registerAll(CORE_NODES);
  gameStudioAdapter.registerNodes(registry);
  toolchain = { size, tc: { adapter: gameStudioAdapter, registry } };
  return toolchain.tc;
}

/** Reads a .vgraph file. Throws with a readable message when it isn't one. */
export function parseVisualScript(source: string): ScriptDoc {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (e) {
    throw new Error(`Not a visual script (invalid JSON: ${e instanceof Error ? e.message : String(e)})`, { cause: e });
  }
  const o = raw as Partial<ScriptDoc> & { format?: string };
  if (!o || typeof o !== 'object' || !Array.isArray(o.functions) || typeof o.name !== 'string') throw new Error('Not a visual script (missing name or functions)');
  const { format: _f, ...doc } = o;
  void _f;
  return { variables: [], signals: [], enums: [], settings: {}, ...doc } as ScriptDoc;
}

export function serializeVisualScript(doc: ScriptDoc): string {
  return JSON.stringify({ format: VISUAL_FORMAT, ...doc }, null, 1) + '\n';
}

/** A new visual script for a node type, with the usual events. */
export function newVisualScript(className: string, baseType: string, events?: string[]): ScriptDoc {
  const doc = createScript(gameStudioAdapter, className, { template: 'empty' });
  doc.settings = { extends: baseType };
  const physics = /^(CharacterBody|RigidBody)/.test(baseType);
  for (const e of events ?? ['_ready', physics ? '_physicsProcess' : '_process']) doc.functions.push(createEventFunction(gameStudioAdapter, e));
  return doc;
}

/** "Player" from "scripts/player_controller.vgraph" → "PlayerController". */
export function classNameFor(path: string) {
  const base = path.split('/').pop()!.replace(/\.[^.]+$/, '');
  const name = base.replace(/(^|[^A-Za-z0-9]+)([A-Za-z0-9])/g, (_m, _s, c: string) => c.toUpperCase()).replace(/^\d+/, '');
  return name || 'Script';
}

export interface VisualCompileResult {
  ok: boolean;
  /** Generated TypeScript (empty when there are errors). */
  code: string;
  diagnostics: Diagnostic[];
  /** The graph-level problems, with node/graph ids (for highlighting in the graph editor). */
  graphDiagnostics: GraphDiagnostic[];
}

function describe(doc: ScriptDoc | null, d: GraphDiagnostic): string {
  if (!doc) return d.message;
  const fn = doc.functions.find((f) => f.id === d.functionId || f.graph.id === d.graphId);
  const node = fn && d.nodeId ? fn.graph.nodes.find((n) => n.id === d.nodeId) : undefined;
  const where = fn ? `${fn.kind === 'event' ? fn.name : `${fn.name}()`}${node ? ` › ${node.type.split('.').pop()} node` : ''}: ` : '';
  return `${where}${d.message}${d.suggestion ? ` ${d.suggestion}` : ''}`;
}

/** Compiles one .vgraph source to TypeScript. */
export function compileVisualScript(path: string, source: string): VisualCompileResult {
  let doc: ScriptDoc;
  try {
    doc = parseVisualScript(source);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, code: '', diagnostics: [{ severity: 'error', message, file: path, source: 'script' }], graphDiagnostics: [{ severity: 'error', code: 'E_PARSE', message }] };
  }
  const result = compileScript(gameStudioToolchain(), { ...doc, path: path.replace(/\.vgraph$/, '') });
  const diagnostics: Diagnostic[] = result.diagnostics.filter((d) => d.severity !== 'info').map((d) => ({ severity: d.severity === 'error' ? 'error' : 'warning', message: describe(doc, d), file: path, source: 'script' }));
  return { ok: result.ok, code: result.ok ? (result.files[0]?.content ?? '') : '', diagnostics, graphDiagnostics: result.diagnostics };
}

/**
 * Replaces every .vgraph script with its generated TypeScript (same path), ready for the normal
 * script compiler. Scripts with errors are left out and reported.
 */
export function expandVisualScripts(scripts: Record<string, string>): { scripts: Record<string, string>; diagnostics: Diagnostic[]; ok: boolean } {
  const out: Record<string, string> = {};
  const diagnostics: Diagnostic[] = [];
  let ok = true;
  for (const [path, source] of Object.entries(scripts)) {
    if (!isVisualScriptPath(path)) {
      out[path] = source;
      continue;
    }
    const r = compileVisualScript(path, source);
    diagnostics.push(...r.diagnostics);
    if (r.ok) out[path] = r.code;
    else ok = false;
  }
  return { scripts: out, diagnostics, ok };
}

export type { EditOp } from '@cs/project-format';
export { OpError } from '@cs/project-format';

const SCRIPT_LEVEL = new Set(['update_project', 'add_script', 'delete_script']);

/**
 * Applies Coding Studio graph edit operations (add_node, connect, add_variable…) to one visual
 * script. Atomic: throws OpError and changes nothing when any operation is invalid.
 */
export function applyVisualOps(doc: ScriptDoc, ops: EditOp[], defaults: { functionId?: string } = {}): { doc: ScriptDoc; created: Record<string, string>; createdIds: string[]; warnings: string[] } {
  ops.forEach((o, i) => {
    if (SCRIPT_LEVEL.has(o.op)) throw new OpError(`"${o.op}" isn't available inside one visual script`, i);
  });
  const project: Project = { format: PROJECT_FORMAT, schemaVersion: PROJECT_SCHEMA_VERSION, id: 'visual', name: doc.name, language: gameStudioAdapter.id, languageVersion: gameStudioAdapter.defaultVersion, compilerSettings: { ...DEFAULT_COMPILER_SETTINGS }, scripts: [doc], createdAt: 0, updatedAt: 0 };
  const r = applyOps(project, ops, gameStudioToolchain(), { scriptId: doc.id, ...defaults });
  return { doc: r.project.scripts[0], created: r.created, createdIds: r.createdIds, warnings: r.warnings };
}
