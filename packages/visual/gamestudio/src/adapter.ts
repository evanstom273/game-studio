/**
 * The Game Studio language: visual scripts compile to the same TypeScript a person would write by
 * hand — `export default class Player extends CharacterBody2D { … }` with lifecycle methods,
 * `static exports` for inspector fields and Signal fields — so they run through the normal script
 * pipeline and can be "ejected" to code at any time.
 */
import * as core from '@gs/core';
import * as shared from '@gs/shared';
import type { Diagnostic } from '@cs/graph-core';
import { stmtExprs, walkStmts, type IRExpr, type IRModule, type IRStmt } from '@cs/intermediate-representation';
import { allCapabilities, type EventTemplate, type LanguageAdapter, type ScriptTemplate, type SourceMapEntry } from '@cs/language-sdk';
import { TSPrinter, typescriptAdapter } from '@cs/language-typescript';
import { gameStudioTypes } from './types';
import { engineApi } from './api';
import { gameStudioNodes, LANG } from './nodes';

/** Names scripts can import from "gamestudio". */
export const ENGINE_EXPORTS: ReadonlySet<string> = new Set([...Object.keys(shared), ...Object.keys(core)].filter((n) => /^[A-Za-z_$][\w$]*$/.test(n) && n !== 'default'));

const JS_RESERVED = 'break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public await async of undefined NaN Infinity arguments eval'.split(' ');

export const EVENTS: EventTemplate[] = [
  { id: '_ready', name: '_ready', title: 'Ready', description: 'Runs once, when the node and all its children are in the scene. Set things up here.', params: [], returnType: 'void' },
  { id: '_process', name: '_process', title: 'Every Frame', description: 'Runs every frame. Delta is the time since the last frame, in seconds.', params: [{ name: 'delta', type: 'float' }], returnType: 'void' },
  { id: '_physicsProcess', name: '_physicsProcess', title: 'Every Physics Tick', description: 'Runs 60 times a second, in step with physics. Move characters (Move And Slide) here.', params: [{ name: 'delta', type: 'float' }], returnType: 'void' },
  { id: '_input', name: '_input', title: 'On Input', description: 'Runs for each key press, click, touch or gamepad button.', params: [{ name: 'event', type: 'InputEvent' }], returnType: 'void' },
  { id: '_enterTree', name: '_enterTree', title: 'Enter Tree', description: 'Runs when the node is added to the scene (before Ready).', params: [], returnType: 'void' },
  { id: '_exitTree', name: '_exitTree', title: 'Exit Tree', description: 'Runs when the node leaves the scene (it was removed or freed).', params: [], returnType: 'void' },
];

export const TEMPLATES: ScriptTemplate[] = [
  { id: 'node', name: 'Node script', description: 'Ready and Every Frame events.', settings: { extends: 'Node2D' }, events: ['_ready', '_process'] },
  { id: 'character', name: 'Character', description: 'Ready and Every Physics Tick, for a CharacterBody.', settings: { extends: 'CharacterBody2D' }, events: ['_ready', '_physicsProcess'] },
  { id: 'empty', name: 'Empty', description: 'No events yet.', settings: { extends: 'Node' }, events: [] },
];

/** Members of an engine class and its bases (names a script may not reuse for its own variables). */
function engineMembers(cls: string): Set<string> {
  const chain = core.nodeTypes.chain(cls);
  const out = new Set<string>();
  for (const a of engineApi()) if (chain.includes(a.cls)) out.add(a.name);
  for (const p of core.nodeTypes.properties(cls)) out.add(p.name);
  // Whatever the class actually has at runtime (methods and fields set in constructors).
  const ctor = core.nodeTypes.get(cls)?.ctor;
  if (ctor) {
    for (let p = ctor.prototype; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) for (const k of Object.getOwnPropertyNames(p)) if (!k.startsWith('_') && k !== 'constructor') out.add(k);
    try {
      for (const k of Object.keys(new ctor())) if (!k.startsWith('_')) out.add(k);
    } catch {
      /* a constructor that needs the engine: prototype names are enough */
    }
  }
  return out;
}

/** Whether `stmts` await anything (not counting nested functions, which are marked themselves). */
function markAsync(stmts: IRStmt[]): boolean {
  let found = false;
  const visit = (e: IRExpr) => {
    if (e.k === 'await') found = true;
    if (e.k === 'lambda') {
      if (markAsync(e.body)) e.isAsync = true;
      return; // its awaits are its own
    }
    for (const child of childExprs(e)) visit(child);
  };
  walkStmts(stmts, (s) => {
    for (const e of stmtExprs(s)) visit(e);
  });
  return found;
}

function childExprs(e: IRExpr): IRExpr[] {
  switch (e.k) {
    case 'bin':
      return [e.left, e.right];
    case 'un':
      return [e.operand];
    case 'call':
      return [...(e.target ? [e.target] : []), ...e.args];
    case 'builtin':
      return e.args;
    case 'prop':
    case 'optional_prop':
      return [e.target];
    case 'index':
      return [e.target, e.index];
    case 'new':
      return [...(e.callee ? [e.callee] : []), ...e.args];
    case 'array':
      return e.items;
    case 'map':
      return e.entries.flatMap((x) => [x.key, x.value]);
    case 'ternary':
      return [e.cond, e.then, e.else];
    case 'cast':
    case 'instanceof':
      return [e.expr];
    case 'await':
      return [e.expr];
    case 'template':
      return e.parts.filter((p): p is IRExpr => typeof p !== 'string');
    case 'object':
      return e.entries.map((x) => x.value);
    case 'invoke':
      return [e.callee, ...e.args];
    case 'jsx':
      return [...(typeof e.tag === 'string' ? [] : [e.tag]), ...e.attrs.map((a) => a.value), ...e.children];
    case 'lang':
      return e.args;
    default:
      return [];
  }
}

/** Identifiers the module declares itself (they must not be imported over). */
function declaredNames(module: IRModule): Set<string> {
  const out = new Set<string>([module.name]);
  const visitStmts = (stmts: IRStmt[]) =>
    walkStmts(stmts, (s) => {
      if (s.k === 'var') out.add(s.name);
      if (s.k === 'var_tuple') s.names.forEach((n) => out.add(n));
      if (s.k === 'for_each' || s.k === 'for_range') out.add(s.var);
      if (s.k === 'try' && s.catchVar) out.add(s.catchVar);
    });
  for (const m of module.members) {
    out.add(m.name);
    if (m.k === 'function') {
      m.params.forEach((p) => out.add(p.name));
      visitStmts(m.body);
    }
  }
  return out;
}

/** Adds `import { … } from 'gamestudio'` for the engine names the generated code uses. */
function addEngineImports(content: string, module: IRModule): { content: string; added: number } {
  // Blank out strings and comments so names inside them don't count.
  const code = content.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g, (m) => ' '.repeat(m.length));
  const declared = declaredNames(module);
  const already = new Set<string>();
  for (const m of content.matchAll(/^import\s*\{([^}]*)\}\s*from\s*'gamestudio';$/gm)) m[1].split(',').forEach((x) => already.add(x.trim().split(/\s+as\s+/).pop()!));
  const used = new Set<string>();
  for (const m of code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)/g)) {
    const name = m[1];
    if (ENGINE_EXPORTS.has(name) && !declared.has(name) && !already.has(name)) used.add(name);
  }
  if (!used.size) return { content, added: 0 };
  const lines = content.split('\n');
  let at = 0;
  while (at < lines.length && (lines[at].startsWith('//') || lines[at] === '')) at++;
  // Keep one blank line after the header comment.
  const insert = [`import { ${[...used].sort().join(', ')} } from 'gamestudio';`];
  if (!lines[at]?.startsWith('import ')) insert.push('');
  lines.splice(at, 0, ...insert);
  return { content: lines.join('\n'), added: insert.length };
}

export const gameStudioAdapter: LanguageAdapter = {
  id: LANG,
  name: 'Game Studio',
  extensions: ['.vgraph'],
  versions: [{ id: 'es2022', label: 'ES2022' }],
  defaultVersion: 'es2022',
  capabilities: {
    ...allCapabilities(false),
    classes: true,
    inheritance: true,
    exceptions: true,
    async: true,
    modules: true,
    imports: true,
    typeInference: true,
    generics: true,
    memberVariables: true,
    exportedVariables: true,
    lifecycleEvents: true,
    signals: true,
    enums: true,
    match: true,
    nullable: true,
    dynamicTyping: true,
    closures: true,
    interfaces: true,
  },
  types: gameStudioTypes,
  identifiers: {
    isValid: (n) => /^[A-Za-z_$][\w$]*$/.test(n),
    reserved: new Set([...JS_RESERVED, ...ENGINE_EXPORTS]),
    description: 'Use letters, digits and _, not starting with a digit, and not an engine name like Node2D or Input (camelCase is conventional: jumpSpeed).',
  },
  scriptSettings: [
    {
      key: 'extends',
      label: 'Node type',
      kind: 'select',
      default: 'Node2D',
      options: core.nodeTypes.all().map((t) => ({ value: t.name, label: t.name })),
      description: 'The kind of node this script goes on (CharacterBody2D for a player, Area2D for a pickup…). Its properties and functions are available on Self.',
    },
  ],
  events: EVENTS,
  templates: TEMPLATES,
  registerNodes(registry) {
    registry.registerAll(gameStudioNodes());
  },
  literal(value, type) {
    return typescriptAdapter.literal?.(value, type);
  },
  validateScript(script, report) {
    const ext = typeof script.settings.extends === 'string' ? script.settings.extends : '';
    if (!ext) report({ severity: 'error', code: 'E_INVALID_SETTING', message: 'Choose the node type this script is for (Script settings → Node type).' });
    else if (!core.nodeTypes.has(ext)) report({ severity: 'error', code: 'E_INVALID_SETTING', message: `"${ext}" isn't a Game Studio node type.`, suggestion: 'Pick one from the list, e.g. Node2D, CharacterBody2D or Node3D.' });
    for (const k of Object.keys(script.settings)) if (k !== 'extends') report({ severity: 'warning', code: 'W_UNKNOWN_SETTING', message: `Unknown script setting "${k}" is ignored.` });
    if (!/^[A-Z][\w$]*$/.test(script.name)) report({ severity: 'error', code: 'E_INVALID_NAME', message: `The script's class name "${script.name}" should start with a capital letter and use only letters, digits and _ (e.g. Player, EnemySpawner).` });
    else if (ENGINE_EXPORTS.has(script.name)) report({ severity: 'error', code: 'E_INVALID_NAME', message: `"${script.name}" is already an engine name; call the script something else (e.g. My${script.name}).` });
    if (script.functions.some((f) => f.component)) report({ severity: 'error', code: 'E_UNSUPPORTED', message: 'Game scripts have no React components.' });
    const ctor = script.functions.find((f) => f.name === 'constructor');
    if (ctor) report({ severity: 'error', code: 'E_INVALID_NAME', message: 'Use the Ready event instead of a constructor: the engine creates script nodes itself.', functionId: ctor.id });
    if (ext && core.nodeTypes.has(ext)) {
      const taken = engineMembers(ext);
      for (const v of script.variables) if (taken.has(v.name)) report({ severity: 'error', code: 'E_SHADOWED_IDENTIFIER', message: `"${v.name}" is already part of ${ext} (use Get/Set ${v.name} nodes for it). Give your variable another name.` });
      for (const f of script.functions) if (f.kind !== 'event' && taken.has(f.name)) report({ severity: 'error', code: 'E_SHADOWED_IDENTIFIER', message: `"${f.name}" is already a ${ext} function; name yours something else.`, functionId: f.id });
      for (const s of script.signals) if (taken.has(s.name)) report({ severity: 'error', code: 'E_SHADOWED_IDENTIFIER', message: `${ext} already has "${s.name}"; name the signal something else.` });
    }
    for (const v of script.variables) if (v.attributes?.state) report({ severity: 'error', code: 'E_UNSUPPORTED', message: `${v.name}: React state isn't available in game scripts.` });
  },
  validate(module, ctx) {
    const asClass = { ...module, settings: { ...module.settings, kind: 'class' } };
    return typescriptAdapter.validate(asClass, ctx).filter((d: Diagnostic) => d.code !== 'E_HOOK_RULES' && d.code !== 'E_SET_STATE_IN_RENDER');
  },
  generate(module, ctx) {
    const m: IRModule = { ...module, settings: { kind: 'class', output: 'ts', extends: module.settings.extends ?? 'Node', extendsFrom: '' } };
    for (const f of m.members) if (f.k === 'function' && markAsync(f.body)) f.isAsync = true;
    const header = `Generated by Game Studio from the visual script "${module.name}".\nEdit the graph: this code is rebuilt from it each time.`;
    const printer = new TSPrinter(m, 'ts', { defaultExport: true, staticExports: true, signals: true });
    const out = printer.render(ctx, header);
    const { content, added } = addEngineImports(out.content, m);
    const insertedAt = out.content.split('\n').findIndex((l) => !(l.startsWith('//') || l === ''));
    const sourceMap: SourceMapEntry[] = out.sourceMap.map((e) => (e.line > insertedAt ? { ...e, line: e.line + added } : e));
    return [{ path: `${module.path}.ts`, content, sourceMap }];
  },
};
