/**
 * The engine API as a table the node pack turns into visual-script nodes.
 *
 * Most of it is read from the script editor's API catalogue (@gs/scripting's API_COMPLETIONS) and
 * the node registry's properties, so whatever the engine documents for code is available in graphs
 * too. Untyped parameters there (e.g. `(action): boolean`) get their type from the parameter name.
 */
import { nodeTypes, type PropDef } from '@gs/core';
import { API_COMPLETIONS } from '@gs/scripting';

export type ApiParam = [name: string, type: string, defaultValue?: number | string | boolean];

export interface ApiMember {
  /** Engine class (or 'Input' / 'global'). */
  cls: string;
  name: string;
  kind: 'method' | 'property' | 'function' | 'signal';
  params: ApiParam[];
  /** Return type (methods/functions) or property type. Canonical type text. */
  type: string;
  /** No side effects: a pure node (no exec pins). */
  pure?: boolean;
  readonly?: boolean;
  /** Value types (Vector2…): the target must be connected. */
  valueType?: boolean;
  /** The method returns a promise (wait): the node awaits it. */
  awaits?: boolean;
  description: string;
  /** Options for an enum property. */
  options?: readonly string[];
}

export const VALUE_CLASSES = new Set(['Vector2', 'Vector3', 'Color', 'Quaternion', 'Rect2', 'Transform2D']);
/** Catalogue class name → how scripts reach it. */
export const SINGLETONS: Record<string, string> = { InputManager: 'Input' };

const STRING_PARAMS = new Set(['action', 'negative', 'positive', 'negX', 'posX', 'negY', 'posY', 'code', 'path', 'group', 'method', 'property', 'name', 'pattern', 'animation', 'text', 'key', 'signal']);
const INT_PARAMS = new Set(['i', 'index', 'n', 'button', 'layer', 'count']);
const FLOAT_PARAMS = new Set(['radians', 'seconds', 'delta', 't', 's', 'strength', 'torque', 'fromPosition', 'max', 'degrees', 'weight', 'amount', 'speed', 'duration', 'min', 'from', 'volume']);
const BOOL_PARAMS = new Set(['on', 'recursive', 'keepGlobalTransform', 'visible', 'enabled']);
const NODE_PARAMS = new Set(['node', 'body', 'area', 'newParent', 'child', 'parent', 'other']);

/** TS type text from the catalogue → canonical type text. */
export function canonical(ts: string | undefined, cls: string): string {
  if (!ts) return 'any';
  let s = ts.trim();
  let nullable = false;
  const nul = /^(.*?)\s*\|\s*(null|undefined)$/.exec(s);
  if (nul) {
    s = nul[1].trim();
    nullable = true;
  }
  const done = (t: string) => (nullable ? `${t}?` : t);
  if (s.startsWith('readonly ')) s = s.slice(9);
  if (s === 'number') return done('float');
  if (s === 'boolean') return done('bool');
  if (s === 'string') return done('string');
  if (s === 'void' || s === '') return 'void';
  if (s === 'T') return done('Node');
  if (/^T\[\]$/.test(s)) return done('array<Node>');
  const arr = /^(\w+)\[\]$/.exec(s);
  if (arr) return done(`array<${canonical(arr[1], cls)}>`);
  const map = /^Map<(\w+),\s*(\w+)>$/.exec(s);
  if (map) return done(`map<${canonical(map[1], cls) === 'float' ? 'int' : canonical(map[1], cls)}, ${canonical(map[2], cls)}>`);
  if (/^Promise</.test(s) || /=>/.test(s) || /[{}()|&<>]/.test(s)) return 'any';
  if (/^[A-Z]\w*$/.test(s)) return done(s);
  void cls;
  return 'any';
}

function paramType(name: string, explicit: string | undefined, cls: string, def: string | undefined): string {
  if (explicit) return canonical(explicit, cls);
  if (def !== undefined) {
    if (/^-?\d+$/.test(def)) return INT_PARAMS.has(name) ? 'int' : 'float';
    if (/^-?[\d.]+$/.test(def)) return 'float';
    if (def === 'true' || def === 'false') return 'bool';
    const vec = /^(Vector2|Vector3|Color)\./.exec(def);
    if (vec) return vec[1];
  }
  if (VALUE_CLASSES.has(cls) && ['v', 'to', 'c', 'other', 'b'].includes(name)) return cls;
  if (STRING_PARAMS.has(name)) return 'string';
  if (INT_PARAMS.has(name)) return 'int';
  if (FLOAT_PARAMS.has(name)) return 'float';
  if (BOOL_PARAMS.has(name)) return 'bool';
  if (NODE_PARAMS.has(name)) return 'Node';
  if (name === 'target') return 'Node';
  return 'any';
}

function defaultValue(def: string | undefined): number | string | boolean | undefined {
  if (def === undefined) return undefined;
  if (/^-?[\d.]+$/.test(def)) return Number(def);
  if (def === 'true' || def === 'false') return def === 'true';
  const q = /^['"](.*)['"]$/.exec(def);
  if (q) return q[1];
  return undefined;
}

function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if ('<([{'.includes(ch)) depth++;
    if ('>)]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** "(target: Vector3, up = Vector3.UP): Vector3" → params and return type. Null when not expressible as a node. */
export function parseSignature(detail: string, cls: string): { params: ApiParam[]; returns: string; optional: number } | null {
  let s = detail.trim().replace(/^<[^>]*>/, '');
  if (!s.startsWith('(')) return null;
  let depth = 0;
  let end = -1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    if (s[i] === ')' && --depth === 0) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  const inner = s.slice(1, end);
  s = s.slice(end + 1).trim();
  const returns = s.startsWith(':') ? s.slice(1).trim() : 'void';
  const params: ApiParam[] = [];
  let optional = 0;
  for (const raw of splitTop(inner)) {
    if (raw.startsWith('...') || raw.startsWith('{')) return null;
    const m = /^([A-Za-z_$][\w$]*)(\?)?\s*(?::\s*([^=]+?))?\s*(?:=\s*(.+))?$/.exec(raw);
    if (!m) return null;
    const [, name, opt, type, def] = m;
    const t = paramType(name, type, cls, def);
    if (/=>/.test(type ?? '') || t === 'any' && name === 'fn') return null;
    const d = defaultValue(def);
    if (opt || def !== undefined) optional++;
    params.push(d !== undefined ? [name, t, d] : [name, t]);
  }
  return { params, returns: canonical(returns, cls), optional };
}

const PURE_PREFIX = /^(get|is|has|can|to|find|overlaps|distance|angle|length|normalized|dot|cross|lerp|add|sub|mul|scale|rotated|moveToward|limitLength|clone)/;
const READONLY_PROPS = new Set(['parent', 'children', 'owner', 'timeLeft', 'currentScene', 'globalTransform', 'transform', 'quaternion']);

function fromCatalogue(): ApiMember[] {
  const out: ApiMember[] = [];
  for (const [cls, entries] of Object.entries(API_COMPLETIONS.members)) {
    if (cls === 'Signal') continue;
    for (const e of entries) {
      if (e.label.startsWith('_')) continue; // lifecycle methods are events
      const desc = e.info ?? '';
      if (e.type === 'property' && e.detail?.startsWith('Signal')) {
        const names = /<\[(.*)\]>/.exec(e.detail)?.[1] ?? '';
        const params: ApiParam[] = splitTop(names)
          .filter(Boolean)
          .map((n) => {
            const [pn, pt] = n.split(':').map((x) => x.trim());
            return [pn, pt ? canonical(pt, cls) : paramType(pn, undefined, cls, undefined)];
          });
        out.push({ cls, name: e.label, kind: 'signal', params, type: 'void', description: desc || `The ${e.label} signal of ${cls}.` });
      } else if (e.type === 'property') {
        out.push({ cls, name: e.label, kind: 'property', params: [], type: canonical(e.detail, cls), readonly: READONLY_PROPS.has(e.label), valueType: VALUE_CLASSES.has(cls), description: desc || `${cls}.${e.label}` });
      } else if (e.type === 'method') {
        const sig = parseSignature(e.detail ?? '()', cls);
        if (!sig) continue;
        const awaits = /^Promise</.test((e.detail ?? '').split('):').pop()?.trim() ?? '');
        const value = VALUE_CLASSES.has(cls);
        const pure = !awaits && sig.returns !== 'void' && (value || PURE_PREFIX.test(e.label));
        out.push({ cls, name: e.label, kind: 'method', params: sig.params, type: awaits ? 'void' : sig.returns, pure, valueType: value, awaits, description: desc || `${cls}.${e.label}${e.detail ?? ''}` });
      }
    }
  }
  return out;
}

/** Fields scripts use that aren't inspector properties. */
const EXTRAS: ApiMember[] = [
  { cls: 'CharacterBody2D', name: 'velocity', kind: 'property', params: [], type: 'Vector2', description: 'Velocity in pixels per second; moveAndSlide() moves by it.' },
  { cls: 'CharacterBody3D', name: 'velocity', kind: 'property', params: [], type: 'Vector3', description: 'Velocity in metres per second; moveAndSlide() moves by it.' },
  { cls: 'Node', name: 'ready', kind: 'signal', params: [], type: 'void', description: 'Emitted when the node is ready.' },
  { cls: 'Node', name: 'treeExiting', kind: 'signal', params: [], type: 'void', description: 'Emitted when the node is about to leave the tree.' },
];

const PROP_TYPES: Partial<Record<PropDef['type'], string>> = {
  bool: 'bool',
  int: 'int',
  float: 'float',
  string: 'string',
  multiline: 'string',
  vector2: 'Vector2',
  vector3: 'Vector3',
  color: 'Color',
  enum: 'string',
  nodepath: 'string',
  'vector2[]': 'array<Vector2>',
};
const RESOURCE_TYPES: Record<string, string> = { texture: 'Texture', audio: 'AudioStream', model: 'ModelResource', font: 'FontResource', scene: 'PackedScene' };

/** Inspector properties of every registered node type (own properties only; inherited ones belong to the base). */
function fromRegistry(): ApiMember[] {
  const out: ApiMember[] = [];
  for (const t of nodeTypes.all()) {
    for (const p of t.properties) {
      const type = p.type === 'resource' ? (RESOURCE_TYPES[p.resource ?? ''] ?? 'Resource') + (p.nullable ? '?' : '') : (PROP_TYPES[p.type] ?? 'any');
      out.push({ cls: t.name, name: p.name, kind: 'property', params: [], type, description: `${p.label ?? p.name}${p.hint ? `: ${p.hint}` : ''}${p.degrees ? ' (radians)' : ''}`, ...(p.options ? { options: p.options } : {}) });
    }
  }
  return out;
}

let cache: { size: number; list: ApiMember[] } | null = null;

/** The whole API (rebuilt if node types were registered since). */
export function engineApi(): ApiMember[] {
  const size = nodeTypes.all().length;
  if (cache && cache.size === size) return cache.list;
  const seen = new Set<string>();
  const list: ApiMember[] = [];
  const all = [...fromRegistry(), ...EXTRAS, ...fromCatalogue()];
  const methods = new Set(all.filter((a) => a.kind === 'method').map((a) => `${a.cls}.${a.name}`));
  for (const a of all) {
    const key = `${a.cls}.${a.name}.${a.kind === 'signal' ? 's' : a.kind === 'property' ? 'p' : 'm'}`;
    if (seen.has(key)) continue;
    // A read-only property with a getter method of the same name (parent / getParent): keep the method.
    if (a.kind === 'property' && a.readonly && methods.has(`${a.cls}.get${a.name[0].toUpperCase()}${a.name.slice(1)}`)) continue;
    // Vector add/sub/scale have dedicated nodes with friendlier pins (nodes.ts).
    if (a.kind === 'method' && (a.cls === 'Vector2' || a.cls === 'Vector3') && ['add', 'sub', 'scale'].includes(a.name)) continue;
    // Get Node has a hand-written node with a type picker (gs.get_node).
    if (a.kind === 'method' && a.cls === 'Node' && a.name === 'getNode') continue;
    seen.add(key);
    list.push(a);
  }
  cache = { size, list };
  return list;
}
