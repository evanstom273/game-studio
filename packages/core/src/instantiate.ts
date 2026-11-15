/**
 * Scene documents ⇄ live node trees.
 *
 * `instantiateScene` builds nodes from a SceneDoc: types from the registry (or the attached
 * script's class when scripts are available), stored property values, nested scene instances,
 * groups and signal connections. Problems that shouldn't stop a game (a missing texture, a script
 * that failed to compile) are reported through `onProblem` and the node is created without them.
 *
 * The editor instantiates scenes without scripts (`scripts: null`) so editing never runs game code.
 */
import { GameStudioError, Vector2, Vector3, Color, jsonEqual, type Json } from '@gs/shared';
import { Node } from './node';
import { propToJson, propToRuntime, type PropContext } from './properties';
import type { NodeRegistry } from './registry';
import type { ResourceLoader } from './resources';
import type { ScriptRegistry } from './scripts';
import { walkDoc, type NodeDoc, type SceneDoc } from './scene-format';

export interface InstantiateOptions {
  registry: NodeRegistry;
  /** null = don't attach scripts (editor). */
  scripts: ScriptRegistry | null;
  resources: ResourceLoader | null;
  /** Scene documents by path, for nested instances. */
  scene(path: string): SceneDoc | undefined;
  onProblem?(message: string, nodeId?: string): void;
}

const MAX_NESTING = 32;

export function instantiateScene(doc: SceneDoc, opts: InstantiateOptions, scenePath: string | null = null): Node {
  return build(doc, opts, scenePath, '', [], null);
}

function build(doc: SceneDoc, opts: InstantiateOptions, scenePath: string | null, idPrefix: string, stack: string[], rootOverride: NodeDoc | null): Node {
  if (scenePath) {
    if (stack.includes(scenePath)) throw new GameStudioError('E_RECURSIVE_SCENE', `Scene "${scenePath}" instances itself (${[...stack, scenePath].join(' → ')})`);
    if (stack.length > MAX_NESTING) throw new GameStudioError('E_RECURSIVE_SCENE', 'Scenes are nested too deeply');
  }
  const chain = scenePath ? [...stack, scenePath] : stack;
  const ctx: PropContext = { loadResource: (kind, path) => opts.resources?.loadKind(kind, path) ?? null };
  const byDocId = new Map<string, Node>();
  const created: Node[] = [];

  const make = (nd: NodeDoc, isRoot: boolean): Node => {
    const effective = isRoot && rootOverride ? mergeOverride(nd, rootOverride) : nd;
    let node: Node;
    if (nd.instance && !isRoot) {
      const inner = opts.scene(nd.instance);
      if (!inner) {
        opts.onProblem?.(`Instanced scene "${nd.instance}" does not exist`, nd.id);
        node = new Node(nd.name);
      } else {
        node = build(inner, opts, nd.instance, idPrefix + nd.id + '/', chain, nd);
      }
      node.id = idPrefix + nd.id;
      byDocId.set(nd.id, node);
      for (const c of nd.children ?? []) node.addChild(make(c, false));
      return node;
    }
    node = construct(effective, opts);
    node.id = isRoot && rootOverride ? idPrefix.replace(/\/$/, '') : idPrefix + nd.id;
    setName(node, effective.name);
    applyProps(node, effective, opts, ctx);
    for (const g of effective.groups ?? []) node.addToGroup(g);
    byDocId.set(nd.id, node);
    created.push(node);
    for (const c of nd.children ?? []) node.addChild(make(c, false));
    return node;
  };

  const root = make(doc.root, true);
  root.sceneFilePath = scenePath;
  for (const n of created) if (n !== root) n.owner = root;

  for (const cn of doc.connections ?? []) {
    const from = byDocId.get(cn.from);
    const to = byDocId.get(cn.to);
    if (!from || !to) {
      opts.onProblem?.(`Connection ${cn.signal} → ${cn.method}: node not found`, cn.from);
      continue;
    }
    const sig = (from as unknown as Record<string, unknown>)[cn.signal];
    if (!sig || typeof (sig as { connect?: unknown }).connect !== 'function') {
      opts.onProblem?.(`${from.name} has no signal "${cn.signal}"`, cn.from);
      continue;
    }
    if (!opts.scripts) continue; // the editor doesn't wire game logic
    const target = to as unknown as Record<string, unknown>;
    (sig as { connect(fn: (...a: unknown[]) => void, o: { owner: object }): void }).connect(
      (...args: unknown[]) => {
        const fn = target[cn.method];
        if (typeof fn !== 'function') throw new GameStudioError('E_NO_METHOD', `${to.name} has no method "${cn.method}" (connected to ${from.name}.${cn.signal})`);
        (fn as (...a: unknown[]) => void).apply(to, args);
      },
      { owner: to },
    );
  }
  return root;
}

/** An instance node's overrides on top of the instanced scene's root. */
function mergeOverride(base: NodeDoc, over: NodeDoc): NodeDoc {
  return {
    ...base,
    name: over.name,
    props: { ...base.props, ...over.props },
    script: over.script !== undefined ? over.script : base.script,
    scriptProps: { ...base.scriptProps, ...over.scriptProps },
    groups: [...new Set([...(base.groups ?? []), ...(over.groups ?? [])])],
  };
}

function construct(nd: NodeDoc, opts: InstantiateOptions): Node {
  const info = opts.registry.get(nd.type);
  if (!info || info.abstract) {
    opts.onProblem?.(`Unknown node type "${nd.type}"; created a plain Node instead`, nd.id);
    return new Node();
  }
  if (nd.script && opts.scripts) {
    try {
      const cls = opts.scripts.classFor(nd.script, nd.type, opts.registry);
      const n = new cls();
      n.scriptPath = nd.script;
      return n;
    } catch (e) {
      opts.onProblem?.(e instanceof Error ? e.message : String(e), nd.id);
    }
  }
  const n = new info.ctor();
  n.scriptPath = nd.script ?? null;
  return n;
}

function setName(node: Node, name: string) {
  try {
    node.name = name;
  } catch {
    node.name = node.typeName;
  }
}

function applyProps(node: Node, nd: NodeDoc, opts: InstantiateOptions, ctx: PropContext) {
  const target = node as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(nd.props ?? {})) {
    const def = opts.registry.property(nd.type, key);
    if (!def) {
      opts.onProblem?.(`${nd.type} has no property "${key}" (ignored)`, nd.id);
      continue;
    }
    try {
      const v = propToRuntime(def, value, ctx);
      if (def.type === 'resource' && value !== null && v === null) opts.onProblem?.(`${nd.name}.${key}: ${def.resource} "${String(value)}" not found`, nd.id);
      target[key] = v;
    } catch (e) {
      opts.onProblem?.(`${nd.name}.${key}: ${e instanceof Error ? e.message : String(e)}`, nd.id);
    }
  }
  if (!opts.scripts || !nd.scriptProps) return;
  for (const [key, value] of Object.entries(nd.scriptProps)) target[key] = scriptValue(target[key], value);
}

/** Converts a stored script property to match the field's current (initial) value type. */
function scriptValue(current: unknown, value: Json): unknown {
  if (current instanceof Vector2 && Array.isArray(value)) return Vector2.fromArray(value as number[]);
  if (current instanceof Vector3 && Array.isArray(value)) return Vector3.fromArray(value as number[]);
  if (current instanceof Color && typeof value === 'string') return Color.fromHex(value);
  return value;
}

/**
 * Live tree → scene document (Godot's PackedScene.pack). Only non-default properties are stored.
 * Nodes that came from a nested scene are stored as an instance reference.
 */
export function packScene(root: Node, registry: NodeRegistry): SceneDoc {
  const pack = (n: Node, isRoot: boolean): NodeDoc => {
    const type = registry.typeOfClass(n.constructor as new () => Node)?.name ?? 'Node';
    const doc: NodeDoc = { id: n.id.slice(n.id.lastIndexOf('/') + 1), name: n.name, type };
    const props: Record<string, Json> = {};
    for (const def of registry.properties(type)) {
      const v = propToJson(def, (n as unknown as Record<string, unknown>)[def.name]);
      if (!jsonEqual(v, def.default)) props[def.name] = v;
    }
    if (Object.keys(props).length) doc.props = props;
    if (n.scriptPath) doc.script = n.scriptPath;
    const groups = n.getGroups();
    if (groups.length) doc.groups = groups;
    if (!isRoot && n.sceneFilePath) {
      doc.instance = n.sceneFilePath;
      return doc;
    }
    if (n.children.length) doc.children = n.children.map((c) => pack(c, false));
    return doc;
  };
  return { root: pack(root, true) };
}

/** Ids used in a scene document (for uniqueness checks). */
export function collectDocIds(doc: SceneDoc): Set<string> {
  const ids = new Set<string>();
  walkDoc(doc.root, (n) => {
    ids.add(n.id);
  });
  return ids;
}
