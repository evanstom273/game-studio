/**
 * Property metadata: the single description of every editable property, used by
 *  - the runtime (turning stored JSON into live values and back),
 *  - the command layer (validating edits from the UI and from MCP),
 *  - the inspector (choosing a control),
 *  - MCP's node-type schemas.
 *
 * Values are stored in scene files as plain JSON: vectors as arrays, colours as '#rrggbb[aa]',
 * resources as project paths, and inline resources (shapes, meshes, materials) as small objects.
 */
import { Color, Vector2, Vector3, parseHexColor, isPlainObject, type Json } from '@gs/shared';
import type { Resource } from './resources';

export type ResourceKind = 'texture' | 'audio' | 'scene' | 'model' | 'font';

export type PropType =
  | 'bool'
  | 'int'
  | 'float'
  | 'string'
  | 'multiline'
  | 'vector2'
  | 'vector3'
  | 'color'
  | 'enum'
  | 'resource'
  | 'nodepath'
  | 'shape2d'
  | 'shape3d'
  | 'mesh'
  | 'material'
  | 'vector2[]';

export interface PropDef {
  name: string;
  type: PropType;
  /** Default value in its stored (JSON) form. */
  default: Json;
  label?: string;
  /** One-line description (inspector tooltip, MCP schema). */
  hint?: string;
  /** Inspector section. */
  group?: string;
  min?: number;
  max?: number;
  step?: number;
  /** Stored in radians, edited in degrees. */
  degrees?: boolean;
  /** For 'enum'. */
  options?: readonly string[];
  /** For 'resource'. */
  resource?: ResourceKind;
  /** Optional (e.g. a texture or a material may be null). */
  nullable?: boolean;
}

// --- inline resources ---------------------------------------------------------------------------

export type Shape2DData = { type: 'rectangle'; size: [number, number] } | { type: 'circle'; radius: number } | { type: 'capsule'; radius: number; height: number };

export type Shape3DData = { type: 'box'; size: [number, number, number] } | { type: 'sphere'; radius: number } | { type: 'capsule'; radius: number; height: number } | { type: 'cylinder'; radius: number; height: number };

export type MeshData =
  | { type: 'box'; size: [number, number, number] }
  | { type: 'sphere'; radius: number }
  | { type: 'plane'; size: [number, number] }
  | { type: 'cylinder'; radius: number; height: number }
  | { type: 'capsule'; radius: number; height: number }
  | { type: 'model'; path: string };

export interface MaterialData {
  albedo: string;
  albedoTexture: string | null;
  metallic: number;
  roughness: number;
  emission: string;
  emissionEnergy: number;
  unshaded: boolean;
  transparent: boolean;
}

export const DEFAULT_MATERIAL: MaterialData = { albedo: '#ffffff', albedoTexture: null, metallic: 0, roughness: 0.8, emission: '#000000', emissionEnergy: 0, unshaded: false, transparent: false };

const SHAPE2D_TYPES = ['rectangle', 'circle', 'capsule'] as const;
const SHAPE3D_TYPES = ['box', 'sphere', 'capsule', 'cylinder'] as const;
const MESH_TYPES = ['box', 'sphere', 'plane', 'cylinder', 'capsule', 'model'] as const;

// --- validation -----------------------------------------------------------------------------------

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isVec = (v: unknown, n: number) => Array.isArray(v) && v.length === n && v.every(isNum);
const positive = (v: unknown) => isNum(v) && v > 0;

function validateShape2D(v: unknown): string | null {
  if (!isPlainObject(v) || !SHAPE2D_TYPES.includes(v.type as never)) return `must be {type: ${SHAPE2D_TYPES.join('|')}, …}`;
  if (v.type === 'rectangle') return isVec(v.size, 2) && (v.size as number[]).every((n) => n > 0) ? null : 'rectangle needs size [width, height] (> 0)';
  if (v.type === 'circle') return positive(v.radius) ? null : 'circle needs radius > 0';
  return positive(v.radius) && positive(v.height) ? null : 'capsule needs radius > 0 and height > 0';
}

function validateShape3D(v: unknown): string | null {
  if (!isPlainObject(v) || !SHAPE3D_TYPES.includes(v.type as never)) return `must be {type: ${SHAPE3D_TYPES.join('|')}, …}`;
  if (v.type === 'box') return isVec(v.size, 3) && (v.size as number[]).every((n) => n > 0) ? null : 'box needs size [x, y, z] (> 0)';
  if (v.type === 'sphere') return positive(v.radius) ? null : 'sphere needs radius > 0';
  return positive(v.radius) && positive(v.height) ? null : `${v.type} needs radius > 0 and height > 0`;
}

function validateMesh(v: unknown): string | null {
  if (!isPlainObject(v) || !MESH_TYPES.includes(v.type as never)) return `must be {type: ${MESH_TYPES.join('|')}, …}`;
  switch (v.type) {
    case 'box':
      return isVec(v.size, 3) && (v.size as number[]).every((n) => n > 0) ? null : 'box needs size [x, y, z] (> 0)';
    case 'plane':
      return isVec(v.size, 2) && (v.size as number[]).every((n) => n > 0) ? null : 'plane needs size [width, depth] (> 0)';
    case 'sphere':
      return positive(v.radius) ? null : 'sphere needs radius > 0';
    case 'model':
      return typeof v.path === 'string' && v.path.length > 0 ? null : 'model needs a path to a .glb/.gltf asset';
    default:
      return positive(v.radius) && positive(v.height) ? null : `${v.type} needs radius > 0 and height > 0`;
  }
}

function validateMaterial(v: unknown): string | null {
  if (!isPlainObject(v)) return 'must be a material object';
  for (const [k, val] of Object.entries(v)) {
    if (!(k in DEFAULT_MATERIAL)) return `unknown material field "${k}"`;
    const d = DEFAULT_MATERIAL[k as keyof MaterialData];
    if (k === 'albedoTexture') {
      if (val !== null && typeof val !== 'string') return 'albedoTexture must be a texture path or null';
    } else if (typeof d === 'string') {
      if (typeof val !== 'string' || !parseHexColor(val)) return `${k} must be a colour like "#ff8800"`;
    } else if (typeof d === 'number') {
      if (!isNum(val) || val < 0 || (k !== 'emissionEnergy' && val > 1)) return `${k} must be a number${k === 'emissionEnergy' ? ' ≥ 0' : ' between 0 and 1'}`;
    } else if (typeof val !== 'boolean') return `${k} must be true or false`;
  }
  return null;
}

/** Returns null when `value` is a valid stored value for `def`, otherwise a short reason. */
export function validatePropValue(def: PropDef, value: unknown): string | null {
  if (value === null && def.nullable) return null;
  switch (def.type) {
    case 'bool':
      return typeof value === 'boolean' ? null : 'must be true or false';
    case 'int':
    case 'float': {
      if (!isNum(value)) return 'must be a finite number';
      if (def.type === 'int' && !Number.isInteger(value)) return 'must be a whole number';
      if (def.min !== undefined && value < def.min) return `must be ≥ ${def.min}`;
      if (def.max !== undefined && value > def.max) return `must be ≤ ${def.max}`;
      return null;
    }
    case 'string':
    case 'multiline':
    case 'nodepath':
      return typeof value === 'string' ? (value.length > 100_000 ? 'is too long' : null) : 'must be a string';
    case 'vector2':
      return isVec(value, 2) ? null : 'must be [x, y]';
    case 'vector3':
      return isVec(value, 3) ? null : 'must be [x, y, z]';
    case 'color':
      return typeof value === 'string' && parseHexColor(value) ? null : 'must be a colour like "#ff8800" or "#ff880080"';
    case 'enum':
      return typeof value === 'string' && def.options?.includes(value) ? null : `must be one of ${def.options?.join(', ')}`;
    case 'resource':
      return typeof value === 'string' && value.length > 0 ? null : `must be a ${def.resource} path${def.nullable ? ' or null' : ''}`;
    case 'shape2d':
      return validateShape2D(value);
    case 'shape3d':
      return validateShape3D(value);
    case 'mesh':
      return validateMesh(value);
    case 'material':
      return validateMaterial(value);
    case 'vector2[]':
      return Array.isArray(value) && value.length <= 4096 && value.every((p) => isVec(p, 2)) ? null : 'must be a list of [x, y] points';
  }
}

// --- conversion -----------------------------------------------------------------------------------

export interface PropContext {
  /** Resolves a resource path to a loaded resource (null when it doesn't exist). */
  loadResource(kind: ResourceKind, path: string): Resource | null;
}

/** Stored JSON → live value. */
export function propToRuntime(def: PropDef, value: Json, ctx?: PropContext): unknown {
  if (value === null) return null;
  switch (def.type) {
    case 'vector2':
      return Vector2.fromArray(value as number[]);
    case 'vector3':
      return Vector3.fromArray(value as number[]);
    case 'color':
      return parseHexColor(value as string) ?? Color.WHITE;
    case 'resource':
      return ctx ? ctx.loadResource(def.resource!, value as string) : null;
    case 'vector2[]':
      return (value as number[][]).map((p) => Vector2.fromArray(p));
    case 'shape2d':
    case 'shape3d':
    case 'mesh':
      return structuredClone(value);
    case 'material':
      return { ...DEFAULT_MATERIAL, ...(value as object) };
    default:
      return value;
  }
}

/** Live value → stored JSON. */
export function propToJson(def: PropDef, value: unknown): Json {
  if (value === null || value === undefined) return null;
  switch (def.type) {
    case 'vector2':
      return (value as Vector2).toArray();
    case 'vector3':
      return (value as Vector3).toArray();
    case 'color':
      return (value as Color).toHex();
    case 'resource':
      return (value as Resource).resourcePath ?? null;
    case 'vector2[]':
      return (value as Vector2[]).map((p) => p.toArray());
    case 'shape2d':
    case 'shape3d':
    case 'mesh':
    case 'material':
      return structuredClone(value) as Json;
    default:
      return value as Json;
  }
}

/** Infers a property definition from a live value (for script exports declared without a type). */
export function inferPropDef(name: string, value: unknown, hints: Partial<PropDef> = {}): PropDef | null {
  let type: PropType | undefined = hints.type;
  if (!type) {
    if (typeof value === 'boolean') type = 'bool';
    else if (typeof value === 'number') type = Number.isInteger(value) && hints.step === 1 ? 'int' : 'float';
    else if (typeof value === 'string') type = 'string';
    else if (value instanceof Vector2) type = 'vector2';
    else if (value instanceof Vector3) type = 'vector3';
    else if (value instanceof Color) type = 'color';
    else return null;
  }
  const def: PropDef = { ...hints, name, type, default: null };
  def.default = value === undefined ? null : propToJson(def, value);
  return def;
}
