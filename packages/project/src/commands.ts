/**
 * The command layer: every change to a project — from the editor UI, from MCP, from tests — is a
 * list of commands applied by `applyCommands`. Commands are validated (shape with zod, meaning
 * against the node registry and the project) and applied atomically: either the whole batch
 * succeeds and a new project document comes back, or nothing changes and a coded error explains
 * which command failed and why.
 *
 * Documents are treated as immutable. Scenes a batch doesn't touch keep their identity, so undo
 * history (snapshots) stays cheap and change detection is a reference comparison.
 *
 * Nodes are addressed by id, by path from the scene root ("Player/Sprite", "." for the root), or
 * by "$ref" for nodes created earlier in the same batch (`ref` on add_node / duplicate_node /
 * create_scene).
 */
import { z } from 'zod';
import { GameStudioError, Signal, degToRad, extname, isPlainObject, jsonEqual, newId, normalizePath, type Json } from '@gs/shared';
import { Node as CoreNode, assetKindForPath, docNodeByPath, nodeTypes, validatePropValue, walkDoc, type NodeDoc, type NodeRegistry, type PropDef, type SceneDoc } from '@gs/core';
import { AssetInfoSchema, InputBindingSchema, LIMITS, SettingsSchema, type ProjectDoc, type ProjectSettings } from './schema';
import { instancedScenes, resourceExists } from './validate';
import { docChain, keepGlobalProps } from './transforms';

// --- schemas -------------------------------------------------------------------------------------------------------

const scene = z.string().min(1).max(LIMITS.pathLength).describe('Scene path, e.g. "scenes/main.scene"');
const nodeRef = z.string().min(1).max(512).describe('Node id, path from the scene root ("Player/Sprite", "." = root) or "$ref"');
const ref = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/)
  .optional()
  .describe('Name to refer to the created node later in the same batch as "$name"');
const props = z.record(z.string(), z.unknown()).describe('Property values in stored form: vectors as [x, y(, z)], colours as "#rrggbb", resources as project paths. rotation is radians (or pass rotationDegrees).');
const method = z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/, 'must be a valid method name');

export const CommandSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('create_scene'), path: scene, rootType: z.string().default('Node2D'), rootName: z.string().optional(), ref }),
  z.object({ op: z.literal('delete_scene'), path: scene }),
  z.object({ op: z.literal('duplicate_scene'), from: scene, to: scene }),
  z.object({
    op: z.literal('add_node'),
    scene,
    parent: nodeRef.optional().describe('Defaults to the scene root'),
    type: z.string().optional().describe('Node type, e.g. "Sprite2D". Not needed with instance.'),
    name: z.string().optional(),
    props: props.optional(),
    script: z.string().optional(),
    scriptProps: z.record(z.string(), z.unknown()).optional(),
    instance: z.string().optional().describe('Instance another scene here (its path)'),
    groups: z.array(z.string()).optional(),
    index: z.number().int().min(0).optional(),
    ref,
  }),
  z.object({ op: z.literal('set_props'), scene, node: nodeRef, props }),
  z.object({ op: z.literal('reset_props'), scene, node: nodeRef, props: z.array(z.string()).min(1) }),
  z.object({ op: z.literal('set_script_props'), scene, node: nodeRef, values: z.record(z.string(), z.unknown()).describe('Exported script property values; null removes one') }),
  z.object({ op: z.literal('rename_node'), scene, node: nodeRef, name: z.string() }),
  z.object({ op: z.literal('remove_node'), scene, node: nodeRef }),
  z.object({ op: z.literal('reparent_node'), scene, node: nodeRef, parent: nodeRef, index: z.number().int().min(0).optional(), keepGlobalTransform: z.boolean().default(false) }),
  z.object({ op: z.literal('move_node'), scene, node: nodeRef, index: z.number().int().min(0) }),
  z.object({ op: z.literal('duplicate_node'), scene, node: nodeRef, name: z.string().optional(), ref }),
  z.object({ op: z.literal('attach_script'), scene, node: nodeRef, script: z.string().nullable() }),
  z.object({ op: z.literal('set_groups'), scene, node: nodeRef, groups: z.array(z.string().min(1).max(64)).max(64) }),
  z.object({ op: z.literal('connect_signal'), scene, from: nodeRef, signal: z.string().min(1).max(64), to: nodeRef, method }),
  z.object({ op: z.literal('disconnect_signal'), scene, from: nodeRef, signal: z.string(), to: nodeRef, method: z.string() }),
  z.object({ op: z.literal('write_script'), path: z.string(), source: z.string().max(LIMITS.scriptBytes) }),
  z.object({ op: z.literal('delete_script'), path: z.string() }),
  z.object({ op: z.literal('rename_path'), from: z.string(), to: z.string() }),
  z.object({ op: z.literal('add_asset'), path: z.string(), info: AssetInfoSchema.omit({ path: true }), replace: z.boolean().default(false) }),
  z.object({ op: z.literal('delete_asset'), path: z.string() }),
  z.object({ op: z.literal('set_main_scene'), path: scene.nullable() }),
  z.object({ op: z.literal('update_settings'), patch: z.record(z.string(), z.unknown()).describe('Partial settings, merged deeply') }),
  z.object({ op: z.literal('set_input_action'), name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), bindings: z.array(InputBindingSchema).max(32) }),
  z.object({ op: z.literal('remove_input_action'), name: z.string() }),
  z.object({ op: z.literal('rename_project'), name: z.string().min(1).max(LIMITS.nameLength) }),
]);

export type Command = z.input<typeof CommandSchema>;
type ParsedCommand = z.output<typeof CommandSchema>;
export type CommandOp = Command['op'];
export const COMMAND_OPS = CommandSchema.options.map((o) => o.shape.op.value);

export interface CommandResult {
  op: CommandOp;
  /** Created node id (add_node, duplicate_node, create_scene root). */
  id?: string;
  name?: string;
  path?: string;
  /** Extra information (e.g. how many references a deletion cleared). */
  note?: string;
}

export interface ApplyResult {
  project: ProjectDoc;
  results: CommandResult[];
  refs: Record<string, string>;
  /** Scenes whose documents changed (new identity). */
  changedScenes: string[];
}

export interface ApplyOptions {
  registry?: NodeRegistry;
  now?: number;
  /** Id generator (tests). */
  newId?: () => string;
}

export const MAX_BATCH = 500;

// --- applying ----------------------------------------------------------------------------------------------------

const fail = (code: string, message: string, details?: unknown): never => {
  throw new GameStudioError(code, message, details);
};

const NAME_RE = /^[^/:.@%"]+$/;
const SCRIPT_EXT = ['.ts', '.js'];

class Draft {
  scenes: Record<string, SceneDoc>;
  scripts: Record<string, string>;
  assets: ProjectDoc['assets'];
  settings: ProjectSettings;
  name: string;
  private ownScenes = new Set<string>();
  private ownSettings = false;
  constructor(readonly base: ProjectDoc) {
    this.scenes = { ...base.scenes };
    this.scripts = { ...base.scripts };
    this.assets = { ...base.assets };
    this.settings = base.settings;
    this.name = base.name;
  }
  read(path: string): SceneDoc {
    const s = this.scenes[path];
    if (!s) fail('E_NOT_FOUND', `No scene "${path}". Scenes: ${Object.keys(this.scenes).join(', ') || '(none)'}`);
    return s;
  }
  write(path: string): SceneDoc {
    this.read(path);
    if (!this.ownScenes.has(path)) {
      this.scenes[path] = structuredClone(this.scenes[path]);
      this.ownScenes.add(path);
    }
    return this.scenes[path];
  }
  adopt(path: string, doc: SceneDoc) {
    this.scenes[path] = doc;
    this.ownScenes.add(path);
  }
  writeSettings(): ProjectSettings {
    if (!this.ownSettings) {
      this.settings = structuredClone(this.settings);
      this.ownSettings = true;
    }
    return this.settings;
  }
  taken(path: string) {
    return path in this.scenes || path in this.scripts || path in this.assets;
  }
  kindOf(path: string) {
    return path in this.scenes ? 'scene' : path in this.scripts ? 'script' : path in this.assets ? 'asset' : null;
  }
  asProject(): ProjectDoc {
    return { ...this.base, name: this.name, settings: this.settings, scenes: this.scenes, scripts: this.scripts, assets: this.assets };
  }
}

interface Ctx {
  draft: Draft;
  registry: NodeRegistry;
  refs: Record<string, string>;
  makeId: () => string;
}

function findNode(sceneDoc: SceneDoc, id: string): { node: NodeDoc; parent: NodeDoc | null } | null {
  let hit: { node: NodeDoc; parent: NodeDoc | null } | null = null;
  walkDoc(sceneDoc.root, (n, p) => {
    if (hit) return false;
    if (n.id === id) hit = { node: n, parent: p };
  });
  return hit;
}

function resolve(ctx: Ctx, path: string, sceneDoc: SceneDoc, refStr: string): { node: NodeDoc; parent: NodeDoc | null } {
  let id = refStr;
  if (refStr.startsWith('$')) {
    id = ctx.refs[refStr.slice(1)] ?? fail('E_BAD_REF', `"${refStr}" was not defined earlier in this batch`);
  }
  const byId = findNode(sceneDoc, id);
  if (byId) return byId;
  const byPath = docNodeByPath(sceneDoc, refStr);
  if (byPath) return findNode(sceneDoc, byPath.id)!;
  return fail('E_NOT_FOUND', `No node "${refStr}" in ${path}. Use a node id or a path like "Player/Sprite" (see get_scene).`);
}

function countNodes(n: NodeDoc): number {
  return 1 + (n.children ?? []).reduce((a, c) => a + countNodes(c), 0);
}
function depthOf(sceneDoc: SceneDoc, id: string) {
  return (docChain(sceneDoc, id)?.length ?? 1) - 1;
}

function uniqueName(parent: NodeDoc, want: string, except?: NodeDoc) {
  const taken = new Set((parent.children ?? []).filter((c) => c !== except).map((c) => c.name));
  if (!taken.has(want)) return want;
  const base = want.replace(/\d+$/, '');
  let i = 2;
  while (taken.has(`${base}${i}`)) i++;
  return `${base}${i}`;
}

function checkName(name: string) {
  const n = name.trim();
  if (!n || n.length > LIMITS.nameLength || !NAME_RE.test(n)) fail('E_BAD_NAME', `"${name}" is not a valid node name (1–${LIMITS.nameLength} characters, no / : . @ % or quotes)`);
  return n;
}

function scenePath(p: string) {
  const path = normalizePath(p);
  if (extname(path) !== '.scene') fail('E_BAD_PATH', `Scene paths end in ".scene" (got "${p}")`);
  return path;
}

function scriptPath(p: string) {
  const path = normalizePath(p);
  if (!SCRIPT_EXT.includes(extname(path))) fail('E_BAD_PATH', `Script paths end in ".ts" or ".js" (got "${p}")`);
  return path;
}

/** Validates (and normalises) property values for a node type. */
function checkProps(ctx: Ctx, type: string, input: Record<string, unknown>): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const [rawKey, value] of Object.entries(input)) {
    let key = rawKey;
    let v = value;
    // Convenience alias (Godot has rotation_degrees too).
    if (rawKey === 'rotationDegrees' && ctx.registry.property(type, 'rotation')) {
      key = 'rotation';
      v = typeof value === 'number' ? degToRad(value) : Array.isArray(value) ? value.map((x) => (typeof x === 'number' ? degToRad(x) : x)) : value;
    }
    const def = ctx.registry.property(type, key);
    if (!def) fail('E_UNKNOWN_PROPERTY', `${type} has no property "${rawKey}". Properties: ${ctx.registry.properties(type).map((p) => p.name).join(', ')}`);
    const problem = validatePropValue(def!, v);
    if (problem) fail('E_INVALID_VALUE', `${type}.${key} ${problem} (got ${JSON.stringify(v)?.slice(0, 120)})`);
    checkResourceRefs(ctx, def!, v);
    out[key] = structuredClone(v) as Json;
  }
  return out;
}

function checkResourceRefs(ctx: Ctx, def: PropDef, v: unknown) {
  const project = ctx.draft.asProject();
  const need = (kind: string, path: string) => {
    if (!resourceExists(project, kind, path)) fail('E_NOT_FOUND', `${kind} "${path}" is not in the project${kind === 'scene' ? '' : '. Import it first (import_asset)'}.`);
  };
  if (v === null) return;
  if (def.type === 'resource') need(def.resource!, v as string);
  if (def.type === 'mesh' && (v as { type: string }).type === 'model') need('model', (v as { path: string }).path);
  if (def.type === 'material' && typeof (v as { albedoTexture?: unknown }).albedoTexture === 'string') need('texture', (v as { albedoTexture: string }).albedoTexture);
}

function setStoredProps(ctx: Ctx, n: NodeDoc, values: Record<string, Json>) {
  const next = { ...n.props };
  for (const [k, v] of Object.entries(values)) {
    const def = ctx.registry.property(n.type, k)!;
    if (!n.instance && jsonEqual(v, def.default)) delete next[k];
    else next[k] = v;
  }
  if (Object.keys(next).length) n.props = next;
  else delete n.props;
}

function checkScriptProps(values: Record<string, unknown>): Record<string, Json | null> {
  const out: Record<string, Json | null> = {};
  for (const [k, v] of Object.entries(values)) {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k)) fail('E_BAD_NAME', `"${k}" is not a valid property name`);
    const s = JSON.stringify(v);
    if (s === undefined || s.length > 100_000) fail('E_INVALID_VALUE', `${k} must be a JSON value (≤ 100 kB)`);
    out[k] = v as Json | null;
  }
  return out;
}

function signalNames(registry: NodeRegistry, type: string): string[] {
  const info = registry.get(type);
  if (!info || info.abstract) return [];
  const probe = new info.ctor() as unknown as Record<string, unknown>;
  const names = Object.keys(probe).filter((k) => probe[k] instanceof Signal);
  (probe as unknown as CoreNode).free();
  return names;
}

function forEachResourceRef(sceneDoc: SceneDoc, registry: NodeRegistry, fn: (node: NodeDoc, key: string, kind: string, path: string, set: (v: Json) => void) => void) {
  walkDoc(sceneDoc.root, (n) => {
    for (const [key, value] of Object.entries(n.props ?? {})) {
      const def = registry.property(n.type, key);
      if (!def || value === null) continue;
      const set = (v: Json) => {
        n.props = { ...n.props, [key]: v };
      };
      if (def.type === 'resource') fn(n, key, def.resource!, value as string, set);
      else if (def.type === 'mesh' && isPlainObject(value) && value.type === 'model') fn(n, key, 'model', String(value.path), (p) => set(p === null ? { type: 'box', size: [1, 1, 1] } : { ...(value as object), path: p } as Json));
      else if (def.type === 'material' && isPlainObject(value) && typeof value.albedoTexture === 'string') fn(n, key, 'texture', value.albedoTexture, (p) => set({ ...(value as object), albedoTexture: p } as Json));
    }
  });
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = k in base && isPlainObject(v) && k !== 'actions' ? deepMerge(base[k], v) : v;
  return out;
}

function apply(ctx: Ctx, c: ParsedCommand): CommandResult {
  const { draft, registry } = ctx;
  switch (c.op) {
    case 'create_scene': {
      const path = scenePath(c.path);
      if (draft.taken(path)) fail('E_EXISTS', `"${path}" already exists`);
      if (Object.keys(draft.scenes).length >= LIMITS.scenes) fail('E_LIMIT', 'Too many scenes');
      const info = registry.require(c.rootType);
      if (info.abstract) fail('E_UNKNOWN_TYPE', `${c.rootType} is abstract; pick a concrete type`);
      const id = ctx.makeId();
      draft.adopt(path, { root: { id, name: checkName(c.rootName ?? defaultRootName(path)), type: c.rootType } });
      if (c.ref) ctx.refs[c.ref] = id;
      return { op: c.op, path, id };
    }
    case 'delete_scene': {
      const path = normalizePath(c.path);
      draft.read(path);
      const users = Object.keys(draft.scenes).filter((p) => p !== path && instancedScenes(draft.asProject(), p).has(path));
      if (users.length) fail('E_IN_USE', `"${path}" is instanced by ${users.join(', ')}. Remove those instances first.`, { users });
      delete draft.scenes[path];
      if (draft.settings.mainScene === path) draft.writeSettings().mainScene = null;
      return { op: c.op, path };
    }
    case 'duplicate_scene': {
      const from = normalizePath(c.from);
      const to = scenePath(c.to);
      const src = draft.read(from);
      if (draft.taken(to)) fail('E_EXISTS', `"${to}" already exists`);
      draft.adopt(to, structuredClone(src));
      return { op: c.op, path: to };
    }
    case 'add_node': {
      const path = normalizePath(c.scene);
      const sd = draft.write(path);
      const parent = c.parent ? resolve(ctx, path, sd, c.parent).node : sd.root;
      if (countNodes(sd.root) >= LIMITS.nodesPerScene) fail('E_LIMIT', `A scene can have at most ${LIMITS.nodesPerScene} nodes`);
      if (depthOf(sd, parent.id) >= LIMITS.depth) fail('E_LIMIT', 'The tree is too deep');
      let type = c.type;
      let defaultName: string;
      const node: NodeDoc = { id: ctx.makeId(), name: '', type: '' };
      if (c.instance) {
        const inst = normalizePath(c.instance);
        const target = draft.scenes[inst] ?? fail('E_NOT_FOUND', `No scene "${inst}" to instance`);
        if (inst === path || instancedScenes(draft.asProject(), inst).has(path)) fail('E_RECURSIVE_SCENE', `Instancing "${inst}" in "${path}" would make the scene contain itself`);
        if (type && type !== target.root.type) fail('E_INVALID_VALUE', `"${inst}" has a ${target.root.type} root, not ${type}`);
        type = target.root.type;
        node.instance = inst;
        defaultName = target.root.name;
      } else {
        if (!type) fail('E_INVALID_VALUE', 'add_node needs a type (or an instance)');
        const info = registry.require(type!);
        if (info.abstract) fail('E_UNKNOWN_TYPE', `${type} is abstract; pick a concrete type`);
        defaultName = type!;
      }
      node.type = type!;
      node.name = uniqueName(parent, checkName(c.name ?? defaultName));
      if (c.props) setStoredProps(ctx, node, checkProps(ctx, node.type, c.props));
      if (c.script) {
        const sp = scriptPath(c.script);
        if (draft.scripts[sp] === undefined) fail('E_NOT_FOUND', `No script "${sp}". Create it first (write_script).`);
        node.script = sp;
      }
      if (c.scriptProps) {
        const v = checkScriptProps(c.scriptProps);
        node.scriptProps = Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null)) as Record<string, Json>;
      }
      if (c.groups?.length) node.groups = [...new Set(c.groups)];
      const children = (parent.children ??= []);
      const at = c.index === undefined ? children.length : Math.min(c.index, children.length);
      children.splice(at, 0, node);
      if (c.ref) ctx.refs[c.ref] = node.id;
      return { op: c.op, id: node.id, name: node.name, path: docChain(sd, node.id)!.slice(1).map((n) => n.name).join('/') };
    }
    case 'set_props': {
      const path = normalizePath(c.scene);
      const sd = draft.write(path);
      const { node } = resolve(ctx, path, sd, c.node);
      setStoredProps(ctx, node, checkProps(ctx, node.type, c.props));
      return { op: c.op, id: node.id };
    }
    case 'reset_props': {
      const path = normalizePath(c.scene);
      const sd = draft.write(path);
      const { node } = resolve(ctx, path, sd, c.node);
      const next = { ...node.props };
      for (const k of c.props) {
        if (!registry.property(node.type, k)) fail('E_UNKNOWN_PROPERTY', `${node.type} has no property "${k}"`);
        delete next[k];
      }
      if (Object.keys(next).length) node.props = next;
      else delete node.props;
      return { op: c.op, id: node.id };
    }
    case 'set_script_props': {
      const path = normalizePath(c.scene);
      const sd = draft.write(path);
      const { node } = resolve(ctx, path, sd, c.node);
      if (!node.script) fail('E_NO_SCRIPT', `${node.name} has no script`);
      const next: Record<string, Json> = { ...node.scriptProps };
      for (const [k, v] of Object.entries(checkScriptProps(c.values))) {
        if (v === null) delete next[k];
        else next[k] = v;
      }
      if (Object.keys(next).length) node.scriptProps = next;
      else delete node.scriptProps;
      return { op: c.op, id: node.id };
    }
    case 'rename_node': {
      const path = normalizePath(c.scene);
      const sd = draft.write(path);
      const { node, parent } = resolve(ctx, path, sd, c.node);
      const name = checkName(c.name);
      node.name = parent ? uniqueName(parent, name, node) : name;
      return { op: c.op, id: node.id, name: node.name };
    }
    case 'remove_node': {
      const path = normalizePath(c.scene);
      const sd = draft.write(path);
      const { node, parent } = resolve(ctx, path, sd, c.node);
      if (!parent) fail('E_ROOT', 'The scene root cannot be removed (delete the scene instead)');
      parent!.children = parent!.children!.filter((x) => x !== node);
      if (!parent!.children.length) delete parent!.children;
      const gone = new Set<string>();
      walkDoc(node, (n) => {
        gone.add(n.id);
      });
      if (sd.connections) {
        sd.connections = sd.connections.filter((cn) => !gone.has(cn.from) && !gone.has(cn.to));
        if (!sd.connections.length) delete sd.connections;
      }
      return { op: c.op, id: node.id, note: gone.size > 1 ? `removed ${gone.size} nodes` : undefined };
    }
    case 'reparent_node': {
      const path = normalizePath(c.scene);
      const sd = draft.write(path);
      const { node, parent } = resolve(ctx, path, sd, c.node);
      if (!parent) fail('E_ROOT', 'The scene root cannot be moved');
      const target = resolve(ctx, path, sd, c.parent).node;
      if (target === node || docChain(sd, target.id)!.includes(node)) fail('E_CYCLE', `Cannot move ${node.name} inside itself`);
      const oldChain = docChain(sd, node.id)!;
      const newParentChain = docChain(sd, target.id)!;
      const keep = c.keepGlobalTransform ? keepGlobalProps(oldChain, newParentChain, registry) : null;
      parent!.children = parent!.children!.filter((x) => x !== node);
      if (!parent!.children.length) delete parent!.children;
      node.name = uniqueName(target, node.name);
      const children = (target.children ??= []);
      children.splice(c.index === undefined ? children.length : Math.min(c.index, children.length), 0, node);
      if (keep) setStoredProps(ctx, node, keep as Record<string, Json>);
      return { op: c.op, id: node.id, name: node.name };
    }
    case 'move_node': {
      const path = normalizePath(c.scene);
      const sd = draft.write(path);
      const { node, parent } = resolve(ctx, path, sd, c.node);
      if (!parent) fail('E_ROOT', 'The scene root cannot be moved');
      const list = parent!.children!;
      list.splice(list.indexOf(node), 1);
      list.splice(Math.min(c.index, list.length), 0, node);
      return { op: c.op, id: node.id };
    }
    case 'duplicate_node': {
      const path = normalizePath(c.scene);
      const sd = draft.write(path);
      const { node, parent } = resolve(ctx, path, sd, c.node);
      if (!parent) fail('E_ROOT', 'The scene root cannot be duplicated (duplicate the scene instead)');
      if (countNodes(sd.root) + countNodes(node) > LIMITS.nodesPerScene) fail('E_LIMIT', `A scene can have at most ${LIMITS.nodesPerScene} nodes`);
      const copy = structuredClone(node);
      const map = new Map<string, string>();
      walkDoc(copy, (n) => {
        const nid = ctx.makeId();
        map.set(n.id, nid);
        n.id = nid;
      });
      copy.name = uniqueName(parent!, c.name ? checkName(c.name) : node.name);
      parent!.children!.splice(parent!.children!.indexOf(node) + 1, 0, copy);
      const inner = (sd.connections ?? []).filter((cn) => map.has(cn.from) && map.has(cn.to)).map((cn) => ({ ...cn, from: map.get(cn.from)!, to: map.get(cn.to)! }));
      if (inner.length) sd.connections = [...(sd.connections ?? []), ...inner];
      if (c.ref) ctx.refs[c.ref] = copy.id;
      return { op: c.op, id: copy.id, name: copy.name };
    }
    case 'attach_script': {
      const path = normalizePath(c.scene);
      const sd = draft.write(path);
      const { node } = resolve(ctx, path, sd, c.node);
      if (c.script === null) {
        delete node.script;
        delete node.scriptProps;
        if (node.instance) node.script = null;
      } else {
        const sp = scriptPath(c.script);
        if (draft.scripts[sp] === undefined) fail('E_NOT_FOUND', `No script "${sp}". Create it first (write_script).`);
        node.script = sp;
      }
      return { op: c.op, id: node.id };
    }
    case 'set_groups': {
      const path = normalizePath(c.scene);
      const sd = draft.write(path);
      const { node } = resolve(ctx, path, sd, c.node);
      if (c.groups.length) node.groups = [...new Set(c.groups)];
      else delete node.groups;
      return { op: c.op, id: node.id };
    }
    case 'connect_signal': {
      const path = normalizePath(c.scene);
      const sd = draft.write(path);
      const from = resolve(ctx, path, sd, c.from).node;
      const to = resolve(ctx, path, sd, c.to).node;
      if (!from.script) {
        const names = signalNames(registry, from.type);
        if (!names.includes(c.signal)) fail('E_UNKNOWN_SIGNAL', `${from.type} has no signal "${c.signal}". Signals: ${names.join(', ') || '(none)'}`);
      }
      const conn = { from: from.id, signal: c.signal, to: to.id, method: c.method };
      if (!(sd.connections ?? []).some((x) => jsonEqual(x, conn))) sd.connections = [...(sd.connections ?? []), conn];
      return { op: c.op };
    }
    case 'disconnect_signal': {
      const path = normalizePath(c.scene);
      const sd = draft.write(path);
      const from = resolve(ctx, path, sd, c.from).node;
      const to = resolve(ctx, path, sd, c.to).node;
      const before = sd.connections?.length ?? 0;
      sd.connections = (sd.connections ?? []).filter((x) => !(x.from === from.id && x.to === to.id && x.signal === c.signal && x.method === c.method));
      if (sd.connections.length === before) fail('E_NOT_FOUND', 'No such connection');
      if (!sd.connections.length) delete sd.connections;
      return { op: c.op };
    }
    case 'write_script': {
      const path = scriptPath(c.path);
      const kind = draft.kindOf(path);
      if (kind && kind !== 'script') fail('E_EXISTS', `"${path}" is a ${kind}`);
      draft.scripts[path] = c.source;
      return { op: c.op, path, note: kind ? 'updated' : 'created' };
    }
    case 'delete_script': {
      const path = normalizePath(c.path);
      if (draft.scripts[path] === undefined) fail('E_NOT_FOUND', `No script "${path}"`);
      delete draft.scripts[path];
      let detached = 0;
      for (const [sp, s] of Object.entries(draft.scenes)) {
        let uses = false;
        walkDoc(s.root, (n) => {
          if (n.script === path) uses = true;
        });
        if (!uses) continue;
        walkDoc(draft.write(sp).root, (n) => {
          if (n.script === path) {
            delete n.script;
            delete n.scriptProps;
            detached++;
          }
        });
      }
      return { op: c.op, path, note: detached ? `detached from ${detached} node(s)` : undefined };
    }
    case 'rename_path': {
      const from = normalizePath(c.from);
      const to = normalizePath(c.to);
      const kind = draft.kindOf(from) ?? fail('E_NOT_FOUND', `"${from}" does not exist`);
      if (from === to) return { op: c.op, path: to };
      if (draft.taken(to)) fail('E_EXISTS', `"${to}" already exists`);
      if (kind === 'scene') {
        scenePath(to);
        draft.scenes[to] = draft.scenes[from];
        delete draft.scenes[from];
        if (draft.settings.mainScene === from) draft.writeSettings().mainScene = to;
      } else if (kind === 'script') {
        scriptPath(to);
        draft.scripts[to] = draft.scripts[from];
        delete draft.scripts[from];
      } else {
        if (assetKindForPath(to) !== draft.assets[from].kind) fail('E_BAD_PATH', `Keep the file extension when renaming an asset (${from} → ${to})`);
        draft.assets[to] = { ...draft.assets[from], path: to };
        delete draft.assets[from];
      }
      let updated = 0;
      for (const [sp, s] of Object.entries(draft.scenes)) {
        let uses = false;
        walkDoc(s.root, (n) => {
          if (n.script === from || n.instance === from) uses = true;
        });
        forEachResourceRef(s, registry, (_n, _k, _kind, p) => {
          if (p === from) uses = true;
        });
        if (!uses) continue;
        const w = draft.write(sp);
        walkDoc(w.root, (n) => {
          if (n.script === from) (n.script = to), updated++;
          if (n.instance === from) (n.instance = to), updated++;
        });
        forEachResourceRef(w, registry, (_n, _k, _kind, p, set) => {
          if (p === from) set(to), updated++;
        });
      }
      return { op: c.op, path: to, note: updated ? `updated ${updated} reference(s)` : undefined };
    }
    case 'add_asset': {
      const path = normalizePath(c.path);
      const kind = draft.kindOf(path);
      if (kind && !(kind === 'asset' && c.replace)) fail('E_EXISTS', `"${path}" already exists${kind === 'asset' ? ' (pass replace: true to overwrite)' : ''}`);
      if (!kind && Object.keys(draft.assets).length >= LIMITS.assets) fail('E_LIMIT', 'Too many assets');
      const expected = assetKindForPath(path);
      if (expected !== c.info.kind) fail('E_INVALID_VALUE', `"${path}" looks like ${expected === 'other' ? 'an unsupported file' : `a ${expected} file`}, but the asset kind is ${c.info.kind}`);
      draft.assets[path] = { ...c.info, path };
      return { op: c.op, path };
    }
    case 'delete_asset': {
      const path = normalizePath(c.path);
      if (!draft.assets[path]) fail('E_NOT_FOUND', `No asset "${path}"`);
      delete draft.assets[path];
      let cleared = 0;
      for (const [sp, s] of Object.entries(draft.scenes)) {
        let uses = false;
        forEachResourceRef(s, registry, (_n, _k, _kind, p) => {
          if (p === path) uses = true;
        });
        if (!uses) continue;
        forEachResourceRef(draft.write(sp), registry, (_n, _k, _kind, p, set) => {
          if (p === path) set(null), cleared++;
        });
      }
      return { op: c.op, path, note: cleared ? `cleared ${cleared} reference(s)` : undefined };
    }
    case 'set_main_scene': {
      const path = c.path === null ? null : normalizePath(c.path);
      if (path) draft.read(path);
      draft.writeSettings().mainScene = path;
      return { op: c.op, path: path ?? undefined };
    }
    case 'update_settings': {
      const merged = deepMerge(draft.settings, c.patch);
      const parsed = SettingsSchema.safeParse(merged);
      if (!parsed.success) {
        const i = parsed.error.issues[0];
        fail('E_INVALID_VALUE', `settings.${i.path.join('.')}: ${i.message}`);
      }
      const s = parsed.data as ProjectSettings;
      if (s.mainScene && !draft.scenes[s.mainScene]) fail('E_NOT_FOUND', `No scene "${s.mainScene}"`);
      draft.settings = s;
      draft.writeSettings();
      return { op: c.op };
    }
    case 'set_input_action': {
      draft.writeSettings().input.actions = { ...draft.settings.input.actions, [c.name]: c.bindings };
      return { op: c.op, name: c.name };
    }
    case 'remove_input_action': {
      if (!draft.settings.input.actions[c.name]) fail('E_NOT_FOUND', `No custom input action "${c.name}"`);
      const next = { ...draft.settings.input.actions };
      delete next[c.name];
      draft.writeSettings().input.actions = next;
      return { op: c.op, name: c.name };
    }
    case 'rename_project': {
      draft.name = c.name.trim() || fail('E_BAD_NAME', 'Project names cannot be empty');
      return { op: c.op, name: draft.name };
    }
  }
}

function defaultRootName(path: string) {
  const base = path.slice(path.lastIndexOf('/') + 1).replace(/\.scene$/, '');
  const pascal = base.replace(/(^|[-_\s]+)(\w)/g, (_m, _s, ch: string) => ch.toUpperCase()).replace(/[^A-Za-z0-9]/g, '');
  return pascal || 'Root';
}

/**
 * Applies a batch atomically. Throws a GameStudioError (code + message naming the failing
 * command) and leaves `project` untouched when any command is invalid.
 */
export function applyCommands(project: ProjectDoc, commands: readonly unknown[], opts: ApplyOptions = {}): ApplyResult {
  if (!Array.isArray(commands)) fail('E_INVALID_VALUE', 'commands must be a list');
  if (commands.length > MAX_BATCH) fail('E_LIMIT', `At most ${MAX_BATCH} commands per batch`);
  const ctx: Ctx = { draft: new Draft(project), registry: opts.registry ?? nodeTypes, refs: {}, makeId: opts.newId ?? (() => newId()) };
  const results: CommandResult[] = [];
  commands.forEach((raw, index) => {
    const parsed = CommandSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const op = isPlainObject(raw) ? String(raw.op) : '?';
      const hint = issue.code === 'invalid_union' && !COMMAND_OPS.includes(op as CommandOp) ? `unknown op "${op}". Ops: ${COMMAND_OPS.join(', ')}` : `${issue.path.join('.') || 'command'}: ${issue.message}`;
      fail('E_INVALID_COMMAND', `Command ${index + 1} (${op}): ${hint}`, { index, op });
    }
    try {
      results.push(apply(ctx, parsed.data!));
    } catch (e) {
      if (e instanceof GameStudioError) throw new GameStudioError(e.code, `Command ${index + 1} (${parsed.data!.op}): ${e.message}`, { index, op: parsed.data!.op, ...(isPlainObject(e.details) ? e.details : {}) });
      throw e;
    }
  });
  const next = ctx.draft.asProject();
  const changedScenes = Object.keys(next.scenes).filter((p) => next.scenes[p] !== project.scenes[p]);
  return { project: results.length ? { ...next, updatedAt: opts.now ?? Date.now() } : project, results, refs: ctx.refs, changedScenes };
}

/** A short undo-history label for a batch. */
export function describeCommands(commands: readonly Command[]): string {
  if (!commands.length) return 'No change';
  const first = commands[0];
  const extra = commands.length > 1 ? ` (+${commands.length - 1})` : '';
  switch (first.op) {
    case 'add_node':
      return `Add ${first.name ?? first.type ?? 'instance'}${extra}`;
    case 'set_props':
      return `Change ${Object.keys(first.props).join(', ')}${extra}`;
    case 'remove_node':
      return `Delete node${extra}`;
    case 'rename_node':
      return `Rename to ${first.name}${extra}`;
    case 'reparent_node':
      return `Move node${extra}`;
    case 'write_script':
      return `Edit ${first.path}${extra}`;
    default:
      return `${first.op.replace(/_/g, ' ')}${extra}`;
  }
}
