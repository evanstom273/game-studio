/**
 * Game Studio node pack: every engine class's properties, methods and signals as nodes (generated
 * from api.ts), plus hand-written nodes for the things graphs need most (Get Node, signals, Wait,
 * scenes, vectors). Lowers to plain IR that the TypeScript printer understands, so the generated
 * code reads like a hand-written Game Studio script.
 */
import { T, type TypeRef } from '@cs/type-system';
import type { JsonValue } from '@cs/graph-core';
import type { IRExpr, IRStmt } from '@cs/intermediate-representation';
import { data, exec, type LowerContext, type NodeContext, type NodeDefinition, type PortSpec } from '@cs/node-registry';
import { typescriptNodes } from '@cs/language-typescript';
import { nodeTypes } from '@gs/core';
import { engineApi, SINGLETONS, type ApiMember } from './api';

export const LANG = 'gamestudio';
const L = [LANG];

const str = (v: JsonValue | undefined, d = ''): string => (typeof v === 'string' ? v : d);
const self: IRExpr = { k: 'self' };
const ref = (name: string): IRExpr => ({ k: 'ref', name });
const lit = (value: JsonValue, type: TypeRef = T.string): IRExpr => ({ k: 'lit', value, type });
const call = (name: string, args: IRExpr[], target?: IRExpr): IRExpr => (target ? { k: 'call', name, args, target } : { k: 'call', name, args });
const getTree: IRExpr = call('getTree', [], self);

/** camelCase / PascalCase → "Title Case". */
export function humanize(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase())
    .replace(/ (\d)D\b/g, '$1D')
    .replace(/(\d) D\b/g, '$1D');
}

const snake = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();

const STRING_DEFAULTS: Record<string, string> = { action: 'ui_accept', negX: 'ui_left', posX: 'ui_right', negY: 'ui_up', posY: 'ui_down', negative: 'ui_left', positive: 'ui_right', code: 'Space', group: 'enemies', path: 'Sprite2D', property: 'position' };

function zero(t: TypeRef, name = ''): JsonValue | undefined {
  if (t.nullable) return undefined;
  switch (t.kind) {
    case 'int':
    case 'float':
      return 0;
    case 'bool':
      return false;
    case 'string':
      return STRING_DEFAULTS[name] ?? '';
    case 'named':
      if (t.name === 'Vector2') return { x: 0, y: 0 };
      if (t.name === 'Vector3') return { x: 0, y: 0, z: 0 };
      if (t.name === 'Color') return { r: 1, g: 1, b: 1, a: 1 };
      return undefined;
    default:
      return undefined;
  }
}

const INLINE_NAMED = new Set(['Vector2', 'Vector3', 'Color']);

function category(cls: string) {
  if (cls === 'InputManager') return 'Input';
  if (cls === 'SceneTree') return 'Scene';
  if (cls === 'Vector2' || cls === 'Vector3' || cls === 'Color') return `Math/${cls}`;
  if (nodeTypes.has(cls)) return `Nodes/${cls}`;
  return cls;
}

const idPart = (cls: string) => (cls === 'InputManager' ? 'input' : cls.toLowerCase());

/** Target pin of object members. Unconnected = self (or this node's tree, for SceneTree). */
function targetPort(a: ApiMember): PortSpec[] {
  if (SINGLETONS[a.cls]) return [];
  if (a.cls === 'SceneTree') return [data.in('target', 'Tree', T.named('SceneTree'), { connectionOnly: true, description: "Unconnected = this node's scene tree" })];
  return [data.in('target', a.valueType ? a.cls : `${a.cls} (self)`, T.named(a.cls), { connectionOnly: true, required: !!a.valueType, ...(a.valueType ? {} : { description: 'Unconnected = self' }) })];
}

function target(lc: LowerContext, a: ApiMember): IRExpr {
  const single = SINGLETONS[a.cls];
  if (single) return ref(single);
  if (lc.isConnected('target') || a.valueType) return lc.input('target');
  if (a.cls === 'SceneTree') return getTree;
  const st = lc.ctx.selfType();
  if (!st || st.kind !== 'named' || !lc.ctx.isSubclass(st.name, a.cls)) {
    lc.error('E_TARGET_REQUIRED', `This script extends ${st && st.kind === 'named' ? st.name : 'nothing'}, which isn't a ${a.cls}. Connect a ${a.cls} to the target pin.`, { port: 'target', suggestion: `Use Get Node (set its type to ${a.cls}), a ${a.cls} variable, or change what the script extends.` });
  }
  return self;
}

function paramPorts(a: ApiMember, ctx: NodeContext): PortSpec[] {
  return a.params.map(([name, type, def]) => {
    const t = ctx.type(type);
    const d = def ?? zero(t, name);
    const objectType = t.kind === 'named' && !INLINE_NAMED.has(t.name);
    return data.in(name, humanize(name), t, d !== undefined && !objectType ? { default: d } : { required: def === undefined, connectionOnly: objectType || t.kind === 'any' });
  });
}

function apiNodes(a: ApiMember): NodeDefinition[] {
  const id = `gs.${idPart(a.cls)}`;
  const cat = category(a.cls);
  const keywords = [a.cls, a.name, humanize(a.name).toLowerCase()];
  if (a.kind === 'signal') return []; // presets of Connect Signal / Await Signal
  if (a.kind === 'property') {
    const get: NodeDefinition = {
      type: `${id}.get.${snake(a.name)}`,
      title: `Get ${humanize(a.name)}`,
      category: cat,
      description: `${a.cls}.${a.name}${a.description && a.description !== `${a.cls}.${a.name}` ? ` — ${a.description}` : ''}${a.options ? ` (one of: ${a.options.join(', ')})` : ''}`,
      keywords: [...keywords, 'get'],
      flavor: 'pure',
      languages: L,
      props: [],
      ports: (_n, ctx) => [...targetPort(a), data.out('value', humanize(a.name), ctx.type(a.type))],
      lowerExpr: (_p, lc) => ({ k: 'prop', target: target(lc, a), name: a.name }),
    };
    if (a.readonly) return [get];
    const set: NodeDefinition = {
      type: `${id}.set.${snake(a.name)}`,
      title: `Set ${humanize(a.name)}`,
      category: cat,
      description: `Change ${a.cls}.${a.name}${a.description && a.description !== `${a.cls}.${a.name}` ? ` — ${a.description}` : ''}${a.options ? ` (one of: ${a.options.join(', ')})` : ''}`,
      keywords: [...keywords, 'set', 'change'],
      flavor: 'exec',
      languages: L,
      props: [],
      ports: (_n, ctx) => {
        const t = ctx.type(a.type);
        const d = a.options?.[0] ?? zero(t, a.name);
        return [exec.in(), ...targetPort(a), data.in('value', humanize(a.name), t, d !== undefined ? { default: d } : { required: !t.nullable, connectionOnly: t.kind === 'named' && !INLINE_NAMED.has(t.name) }), exec.out()];
      },
      check: (n, _ctx, report) => {
        const v = n.inputs.value;
        if (a.options && typeof v === 'string' && !a.options.includes(v)) report('E_INVALID_VALUE', `${a.name} must be one of: ${a.options.join(', ')}.`, { port: 'value' });
      },
      lowerExec: (lc) => ({ stmts: [{ k: 'assign', target: { k: 'prop', target: target(lc, a), name: a.name }, value: lc.input('value') }], next: 'then' }),
    };
    return [get, set];
  }
  const callExpr = (lc: LowerContext): IRExpr => call(a.name, a.params.map(([name]) => lc.input(name)), a.kind === 'function' ? undefined : target(lc, a));
  const base = {
    type: `${id}.${snake(a.name)}`,
    title: humanize(a.name),
    category: cat,
    description: a.description,
    keywords,
    languages: L,
    props: [],
  };
  if (a.pure) {
    return [{ ...base, flavor: 'pure', ports: (_n, ctx) => [...targetPort(a), ...paramPorts(a, ctx), data.out('result', 'Result', ctx.type(a.type))], lowerExpr: (_p, lc) => callExpr(lc) }];
  }
  return [
    {
      ...base,
      flavor: 'exec',
      ports: (_n, ctx) => {
        const rt = ctx.type(a.type);
        return [exec.in(), ...targetPort(a), ...paramPorts(a, ctx), exec.out(), ...(rt.kind === 'void' ? [] : [data.out('result', 'Result', rt)])];
      },
      lowerExec: (lc) => {
        const rt = lc.ctx.type(a.type);
        const c = callExpr(lc);
        if (a.awaits) return { stmts: [{ k: 'expr', expr: { k: 'await', expr: c } }], next: 'then' };
        if (rt.kind === 'void') return { stmts: [{ k: 'expr', expr: c }], next: 'then' };
        return { stmts: lc.bind('result', c, { type: rt, nameHint: a.name.replace(/^(get|create)/, '').replace(/^./, (x) => x.toLowerCase()) || 'result', sideEffect: true }), next: 'then' };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Hand-written nodes
// ---------------------------------------------------------------------------

const nodeTypeOptions = () => nodeTypes.all().map((t) => t.name);

const getNode: NodeDefinition = {
  type: 'gs.get_node',
  title: 'Get Node',
  category: 'Scene',
  description: 'A node in the scene by its path from this node ("Sprite", "../Player", "UI/Score"). Set its type to use that type’s nodes on it.',
  keywords: ['$', 'find', 'child', 'node path', 'reference', 'get child'],
  flavor: 'pure',
  languages: L,
  props: [
    { key: 'path', label: 'Node path', kind: 'string', default: 'Sprite2D', description: 'Relative to this node (or to the From node): "Child", "Child/Grandchild", "../Sibling".' },
    { key: 'type', label: 'Node type', kind: 'type', default: 'Node', typeOptions: [] },
  ],
  displayTitle: (n) => `Get ${str(n.props.path, '?')}`,
  ports: (n, ctx) => [data.in('from', 'From (self)', T.named('Node'), { connectionOnly: true, description: 'Unconnected = this node' }), data.out('node', str(n.props.type, 'Node') || 'Node', ctx.type(str(n.props.type, 'Node') || 'Node'))],
  check: (n, ctx, report) => {
    if (!str(n.props.path).trim()) report('E_EMPTY_PATH', 'Node path is empty.');
    const t = ctx.type(str(n.props.type, 'Node') || 'Node');
    if (t.kind !== 'named' || !ctx.isSubclass(t.name, 'Node')) report('E_INVALID_PROPERTY', 'Node type must be Node or a node type (Sprite2D, Timer…).');
  },
  lowerExpr: (_p, lc) => {
    const t = lc.ctx.type(str(lc.node.props.type, 'Node') || 'Node');
    return { k: 'cast', expr: call('getNode', [lit(str(lc.node.props.path))], lc.isConnected('from') ? lc.input('from') : self), type: t };
  },
};

const emitSignal: NodeDefinition = {
  type: 'gs.emit_signal',
  title: 'Emit Signal',
  category: 'Signals',
  description: "Emit one of this script's signals; everything connected to it runs.",
  keywords: ['signal', 'emit', 'event', 'notify', 'broadcast', 'fire'],
  flavor: 'exec',
  languages: L,
  props: [{ key: 'signal', label: 'Signal', kind: 'signal', default: '' }],
  displayTitle: (n, ctx) => `Emit ${ctx.signal(n.props.signal)?.name ?? '(pick a signal)'}`,
  ports: (n, ctx) => [exec.in(), ...(ctx.signal(n.props.signal)?.params ?? []).map((p) => data.in(p.id, p.name, ctx.type(p.type), { required: true })), exec.out()],
  check: (n, ctx, report) => {
    if (!ctx.signal(n.props.signal)) report('E_UNDEFINED_SIGNAL', 'Pick which of this script’s signals to emit.', { suggestion: 'Add a signal to the script first (Signals panel).' });
  },
  lowerExec: (lc) => {
    const s = lc.ctx.signal(lc.node.props.signal);
    return { stmts: [{ k: 'expr', expr: call('emit', (s?.params ?? []).map((p) => lc.input(p.id)), { k: 'prop', target: self, name: s?.name ?? '__missing' }) }], next: 'then' };
  },
};

const IDENT = /^[A-Za-z_$][\w$]*$/;

function signalPresets(): NonNullable<NodeDefinition['presets']> {
  return engineApi()
    .filter((a) => a.kind === 'signal')
    .map((a) => ({ title: `On ${humanize(a.name)} (${a.cls})`, category: 'Signals', description: a.description, keywords: [a.cls, a.name, 'signal', 'event', 'on'], props: { signal: a.name } }));
}

const connectSignal = (): NodeDefinition => ({
  type: 'gs.connect_signal',
  title: 'Connect Signal',
  category: 'Signals',
  description: 'Call one of this script’s functions whenever a signal fires (a Timer’s timeout, an Area’s bodyEntered, a button press…). Usually done once, in Ready.',
  keywords: ['signal', 'connect', 'listen', 'subscribe', 'handler', 'on', 'event', 'when'],
  flavor: 'exec',
  languages: L,
  props: [
    { key: 'signal', label: 'Signal name', kind: 'string', default: 'timeout', description: 'The signal on the source: an engine signal ("timeout", "bodyEntered") or one of the source script’s own.' },
    { key: 'method', label: 'Call function', kind: 'function', default: '' },
  ],
  presets: signalPresets(),
  displayTitle: (n, ctx) => `On ${str(n.props.signal, '?')} → ${ctx.func(n.props.method)?.name ?? '?'}`,
  ports: () => [exec.in(), data.in('source', 'Source (self)', T.named('Object'), { connectionOnly: true, description: 'The node whose signal it is. Unconnected = this node' }), exec.out()],
  check: (n, ctx, report) => {
    const sig = str(n.props.signal);
    if (!IDENT.test(sig)) report('E_INVALID_IDENTIFIER', 'Signal name must be a plain name like "timeout" or "bodyEntered".');
    const f = ctx.func(n.props.method);
    if (!f) report('E_UNDEFINED_FUNCTION', 'Choose the function to call when the signal fires.', { suggestion: 'Make a function (Functions panel), then pick it here.' });
    const own = ctx.script.signals.find((s) => s.name === sig);
    if (own && f && own.params.length !== f.params.length) report('E_SIGNAL_ARITY', `${sig} passes ${own.params.length} value(s) but ${f.name} takes ${f.params.length}.`);
  },
  lowerExec: (lc) => {
    const f = lc.ctx.func(lc.node.props.method);
    const params = (f?.params ?? []).map((p) => ({ name: p.name, type: lc.ctx.type(p.type) }));
    const src = lc.isConnected('source') ? lc.input('source') : self;
    const handler: IRExpr = { k: 'lambda', params, returnType: T.void, body: [{ k: 'expr', expr: call(f?.name ?? '__missing', params.map((p) => ref(p.name)), self) }] };
    const owner: IRExpr = { k: 'object', entries: [{ key: 'owner', value: self }] };
    return { stmts: [{ k: 'expr', expr: call('connect', [handler, owner], { k: 'prop', target: src, name: str(lc.node.props.signal) }) }], next: 'then' };
  },
});

const awaitSignal = (): NodeDefinition => ({
  type: 'gs.await_signal',
  title: 'Wait For Signal',
  category: 'Signals',
  description: 'Pause this function until a signal fires (e.g. an AnimatedSprite2D’s animationFinished), then carry on.',
  keywords: ['await', 'wait', 'until', 'signal', 'yield'],
  flavor: 'exec',
  languages: L,
  props: [{ key: 'signal', label: 'Signal name', kind: 'string', default: 'timeout' }],
  presets: signalPresets().map((p) => ({ ...p, title: p.title.replace(/^On /, 'Wait For '), keywords: [...(p.keywords ?? []), 'await', 'wait'] })),
  displayTitle: (n) => `Wait for ${str(n.props.signal, '?')}`,
  ports: () => [exec.in(), data.in('source', 'Source (self)', T.named('Object'), { connectionOnly: true, description: 'Unconnected = this node' }), exec.out()],
  check: (n, _ctx, report) => {
    if (!IDENT.test(str(n.props.signal))) report('E_INVALID_IDENTIFIER', 'Signal name must be a plain name like "timeout".');
  },
  lowerExec: (lc) => {
    const src = lc.isConnected('source') ? lc.input('source') : self;
    const once = call('once', [{ k: 'lambda', params: [], returnType: T.void, body: [{ k: 'expr', expr: { k: 'invoke', callee: ref('resolve'), args: [] } }] }], { k: 'prop', target: src, name: str(lc.node.props.signal) });
    const promise: IRExpr = { k: 'new', type: T.named('Promise'), callee: ref('Promise'), args: [{ k: 'lambda', params: [{ name: 'resolve', type: T.any }], returnType: T.void, body: [{ k: 'expr', expr: once }] }] };
    return { stmts: [{ k: 'expr', expr: { k: 'await', expr: promise } }], next: 'then' };
  },
});

const wait: NodeDefinition = {
  type: 'gs.wait',
  title: 'Wait (seconds)',
  category: 'Time',
  description: 'Pause this function for a number of seconds, then carry on. The rest of the game keeps running.',
  keywords: ['delay', 'sleep', 'timer', 'await', 'seconds', 'later', 'pause'],
  flavor: 'exec',
  languages: L,
  props: [],
  ports: () => [exec.in(), data.in('seconds', 'Seconds', T.float, { default: 1 }), exec.out()],
  lowerExec: (lc) => ({ stmts: [{ k: 'expr', expr: { k: 'await', expr: call('wait', [lc.input('seconds')], getTree) } }], next: 'then' }),
};

const loadResource: NodeDefinition = {
  type: 'gs.load',
  title: 'Load',
  category: 'Resources',
  description: 'Load a texture, sound or scene from the project by path ("art/coin.png", "scenes/enemy.scene").',
  keywords: ['load', 'resource', 'texture', 'sound', 'scene', 'asset', 'preload'],
  flavor: 'pure',
  languages: L,
  props: [{ key: 'type', label: 'Resource type', kind: 'select', default: 'Texture', options: ['Texture', 'AudioStream', 'PackedScene', 'ModelResource', 'FontResource'].map((v) => ({ value: v, label: v })) }],
  ports: (n, ctx) => [data.in('path', 'Path', T.string, { default: '' }), data.out('resource', str(n.props.type, 'Texture'), ctx.type(str(n.props.type, 'Texture') || 'Texture'))],
  lowerExpr: (_p, lc) => ({ k: 'cast', expr: call('load', [lc.input('path')]), type: lc.ctx.type(str(lc.node.props.type, 'Texture') || 'Texture') }),
};

const instantiate: NodeDefinition = {
  type: 'gs.instantiate',
  title: 'Instantiate Scene',
  category: 'Scene',
  description: 'Make a new copy of a scene (an enemy, a bullet, a coin). Add it to the game with Add Child.',
  keywords: ['spawn', 'instance', 'create', 'clone', 'prefab', 'scene'],
  flavor: 'exec',
  languages: L,
  props: [{ key: 'type', label: 'Root node type', kind: 'type', default: 'Node', typeOptions: [] }],
  ports: (n, ctx) => [exec.in(), data.in('path', 'Scene path', T.string, { default: 'scenes/main.scene' }), exec.out(), data.out('instance', 'Instance', ctx.type(str(n.props.type, 'Node') || 'Node'))],
  lowerExec: (lc) => {
    const ty = lc.ctx.type(str(lc.node.props.type, 'Node') || 'Node');
    const expr: IRExpr = { k: 'cast', expr: call('instantiate', [], { k: 'cast', expr: call('load', [lc.input('path')]), type: T.named('PackedScene') }), type: ty };
    return { stmts: lc.bind('instance', expr, { type: ty, nameHint: 'instance', sideEffect: true }), next: 'then' };
  },
};

const spawn: NodeDefinition = {
  type: 'gs.spawn',
  title: 'Spawn Scene',
  category: 'Scene',
  description: 'Instantiate a scene and add it as a child (of this node, or of Parent) at a position, in one step.',
  keywords: ['spawn', 'instance', 'create', 'add child', 'bullet', 'enemy'],
  flavor: 'exec',
  languages: L,
  props: [{ key: 'type', label: 'Root node type', kind: 'type', default: 'Node2D', typeOptions: [] }],
  ports: (n, ctx) => {
    const t = ctx.type(str(n.props.type, 'Node2D') || 'Node2D');
    const is3d = t.kind === 'named' && ctx.isSubclass(t.name, 'Node3D');
    const is2d = t.kind === 'named' && ctx.isSubclass(t.name, 'Node2D');
    return [
      exec.in(),
      data.in('path', 'Scene path', T.string, { default: 'scenes/main.scene' }),
      data.in('parent', 'Parent (self)', T.named('Node'), { connectionOnly: true, description: 'Unconnected = this node' }),
      ...(is2d || is3d ? [data.in('position', 'Position', T.named(is3d ? 'Vector3' : 'Vector2'), { default: is3d ? { x: 0, y: 0, z: 0 } : { x: 0, y: 0 } })] : []),
      exec.out(),
      data.out('instance', 'Instance', t),
    ];
  },
  lowerExec: (lc) => {
    const ty = lc.ctx.type(str(lc.node.props.type, 'Node2D') || 'Node2D');
    const name = lc.uniqueName('spawned');
    const stmts: IRStmt[] = [{ k: 'var', name, type: ty, constant: true, init: { k: 'cast', expr: call('instantiate', [], { k: 'cast', expr: call('load', [lc.input('path')]), type: T.named('PackedScene') }), type: ty } }];
    const positional = ty.kind === 'named' && (lc.ctx.isSubclass(ty.name, 'Node2D') || lc.ctx.isSubclass(ty.name, 'Node3D'));
    if (positional) stmts.push({ k: 'assign', target: { k: 'prop', target: ref(name), name: 'position' }, value: lc.input('position') });
    stmts.push({ k: 'expr', expr: call('addChild', [ref(name)], lc.isConnected('parent') ? lc.input('parent') : self) });
    lc.provide('instance', ref(name));
    return { stmts, next: 'then' };
  },
};

function makeVec(name: string, fields: string[]): NodeDefinition {
  return {
    type: `gs.make_${name.toLowerCase()}`,
    title: `Make ${name}`,
    category: `Math/${name}`,
    description: `Build a ${name} from its parts.`,
    keywords: [name, 'vector', 'new', 'construct', 'make'],
    flavor: 'pure',
    languages: L,
    allocates: true,
    props: [],
    ports: () => [...fields.map((f) => data.in(f, f.toUpperCase(), T.float, { default: name === 'Color' ? 1 : 0 })), data.out('result', name, T.named(name))],
    lowerExpr: (_p, lc) => ({ k: 'new', type: T.named(name), args: fields.map((f) => lc.input(f)) }),
  };
}

function breakVec(name: string, fields: string[]): NodeDefinition {
  return {
    type: `gs.break_${name.toLowerCase()}`,
    title: `Break ${name}`,
    category: `Math/${name}`,
    description: `Split a ${name} into its parts.`,
    keywords: [name, 'vector', 'split', 'components', ...fields],
    flavor: 'pure',
    languages: L,
    props: [],
    ports: () => [data.in('value', name, T.named(name), { required: true, connectionOnly: true }), ...fields.map((f) => data.out(f, f.toUpperCase(), T.float))],
    lowerExpr: (port, lc) => ({ k: 'prop', target: lc.input('value'), name: port }),
  };
}

function vecOp(name: string, op: 'add' | 'sub' | 'scale', title: string): NodeDefinition {
  const other = op === 'scale' ? T.float : T.named(name);
  return {
    type: `gs.${name.toLowerCase()}_${op}_op`,
    title: `${name} ${title}`,
    category: `Math/${name}`,
    description: op === 'scale' ? `Multiply every part of a ${name} by a number.` : `${title} two ${name}s.`,
    keywords: [name, 'vector', op, op === 'add' ? '+' : op === 'sub' ? '-' : '*', title.toLowerCase()],
    flavor: 'pure',
    languages: L,
    props: [],
    ports: () => [data.in('a', 'A', T.named(name), { default: name === 'Vector3' ? { x: 0, y: 0, z: 0 } : { x: 0, y: 0 } }), data.in('b', 'B', other, { default: op === 'scale' ? 1 : name === 'Vector3' ? { x: 0, y: 0, z: 0 } : { x: 0, y: 0 } }), data.out('result', 'Result', T.named(name))],
    lowerExpr: (_p, lc) => call(op, [lc.input('b')], lc.input('a')),
  };
}

const CONSTANTS: { value: string; type: string }[] = [
  ...['ZERO', 'ONE', 'UP', 'DOWN', 'LEFT', 'RIGHT'].map((c) => ({ value: `Vector2.${c}`, type: 'Vector2' })),
  ...['ZERO', 'ONE', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'FORWARD', 'BACK'].map((c) => ({ value: `Vector3.${c}`, type: 'Vector3' })),
  ...['WHITE', 'BLACK', 'RED', 'GREEN', 'BLUE', 'TRANSPARENT'].map((c) => ({ value: `Color.${c}`, type: 'Color' })),
  { value: 'Math.PI', type: 'float' },
  { value: 'Infinity', type: 'float' },
];

const constant: NodeDefinition = {
  type: 'gs.constant',
  title: 'Constant',
  category: 'Math',
  description: 'A built-in value: Vector2.UP, Vector3.FORWARD, Color.RED, π…',
  keywords: ['constant', 'pi', 'zero', 'up', 'down', 'left', 'right', 'forward', 'vector', 'color', 'white', 'black'],
  flavor: 'pure',
  languages: L,
  props: [{ key: 'constant', label: 'Constant', kind: 'select', default: 'Vector2.ZERO', options: CONSTANTS.map(({ value }) => ({ value, label: value })) }],
  presets: CONSTANTS.map((c) => ({ title: c.value, category: c.type === 'float' ? 'Math' : `Math/${c.type}`, props: { constant: c.value } })),
  displayTitle: (n) => str(n.props.constant, 'Constant'),
  ports: (n, ctx) => [data.out('value', 'Value', ctx.type(CONSTANTS.find((c) => c.value === n.props.constant)?.type ?? 'any'))],
  check: (n, _ctx, report) => {
    if (!CONSTANTS.some((c) => c.value === n.props.constant)) report('E_INVALID_PROPERTY', 'Unknown constant.');
  },
  lowerExpr: (_p, lc) => {
    const [a, b] = str(lc.node.props.constant).split('.');
    return b ? { k: 'prop', target: ref(a), name: b } : ref(a);
  },
};

const GLOBALS: ApiMember[] = [
  { cls: 'global', name: 'moveToward', kind: 'function', params: [['from', 'float'], ['to', 'float'], ['delta', 'float']], type: 'float', pure: true, description: 'Move a number toward a target by at most delta (never overshoots).' },
  { cls: 'global', name: 'degToRad', kind: 'function', params: [['degrees', 'float']], type: 'float', pure: true, description: 'Degrees → radians.' },
  { cls: 'global', name: 'radToDeg', kind: 'function', params: [['radians', 'float']], type: 'float', pure: true, description: 'Radians → degrees.' },
  { cls: 'global', name: 'printErr', kind: 'function', params: [['message', 'any']], type: 'void', description: 'Print an error to the console.' },
  { cls: 'global', name: 'pushWarning', kind: 'function', params: [['message', 'any']], type: 'void', description: 'Print a warning to the console.' },
];

function globalNodes(): NodeDefinition[] {
  return GLOBALS.flatMap((g) => apiNodes(g)).map((d) => ({ ...d, type: d.type.replace('gs.global.', 'gs.'), category: g(d.type) }));
  function g(type: string) {
    return type.includes('print') || type.includes('push_warning') ? 'Debug' : 'Math';
  }
}

/** Coding Studio's TypeScript nodes that make sense in a game script (no React or browser APIs). */
function tsNodes(): NodeDefinition[] {
  const drop = new Set(['ts.element', 'ts.classes', 'ts.super']);
  return typescriptNodes()
    .filter((d) => !drop.has(d.type))
    .map((d) => ({
      ...d,
      languages: L,
      ...(d.presets ? { presets: d.presets.filter((p) => p.category !== 'Web' && p.category !== 'React') } : {}),
    }));
}

export function gameStudioNodes(): NodeDefinition[] {
  const nodes = [
    getNode,
    emitSignal,
    connectSignal(),
    awaitSignal(),
    wait,
    loadResource,
    instantiate,
    spawn,
    makeVec('Vector2', ['x', 'y']),
    breakVec('Vector2', ['x', 'y']),
    makeVec('Vector3', ['x', 'y', 'z']),
    breakVec('Vector3', ['x', 'y', 'z']),
    makeVec('Color', ['r', 'g', 'b', 'a']),
    breakVec('Color', ['r', 'g', 'b', 'a']),
    vecOp('Vector2', 'add', 'Add'),
    vecOp('Vector2', 'sub', 'Subtract'),
    vecOp('Vector2', 'scale', 'Scale'),
    vecOp('Vector3', 'add', 'Add'),
    vecOp('Vector3', 'sub', 'Subtract'),
    vecOp('Vector3', 'scale', 'Scale'),
    constant,
    ...globalNodes(),
    ...engineApi().flatMap(apiNodes),
    ...tsNodes(),
  ];
  // Type pickers list the engine's node types.
  const types = nodeTypeOptions();
  for (const n of nodes) for (const p of n.props) if (p.kind === 'type' && p.typeOptions && !p.typeOptions.length) p.typeOptions = types;
  // One definition per id (the catalogue may document a member twice).
  const seen = new Set<string>();
  return nodes.filter((n) => (seen.has(n.type) ? false : (seen.add(n.type), true)));
}
