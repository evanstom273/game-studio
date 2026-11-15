/**
 * Game Studio types for visual scripts: the engine's class hierarchy (read from the live node
 * registry, so new node types are known automatically), its value types (Vector2, Vector3, Color…)
 * and TypeScript spelling for everything else.
 */
import { nodeTypes } from '@gs/core';
import { normalizeTsType, tsType, typescriptAdapter } from '@cs/language-typescript';
import type { LanguageTypes } from '@cs/language-sdk';
import { defaultCompatibility, formatType, T, type Compatibility, type TypeRef, type TypeUniverse } from '@cs/type-system';

/** Engine classes that aren't nodes. */
const OTHER_CLASSES: Record<string, string | undefined> = {
  Object: undefined,
  Resource: 'Object',
  Texture: 'Resource',
  AudioStream: 'Resource',
  ModelResource: 'Resource',
  FontResource: 'Resource',
  PackedScene: 'Resource',
  SceneTree: 'Object',
  SceneTreeTimer: 'Object',
  Tween: 'Object',
  PropertyTweener: 'Object',
  InputEvent: 'Object',
  InputManager: 'Object',
  SlideCollision: 'Object',
  Signal: 'Object',
  Error: 'Object',
  Promise: 'Object',
};

/** Value types; the fields build literals ({x, y} → new Vector2(x, y)). */
export const VALUE_TYPES: Record<string, { name: string; type: TypeRef }[] | null> = {
  Vector2: [
    { name: 'x', type: T.float },
    { name: 'y', type: T.float },
  ],
  Vector3: [
    { name: 'x', type: T.float },
    { name: 'y', type: T.float },
    { name: 'z', type: T.float },
  ],
  Color: [
    { name: 'r', type: T.float },
    { name: 'g', type: T.float },
    { name: 'b', type: T.float },
    { name: 'a', type: T.float },
  ],
  Rect2: null,
  Quaternion: null,
  Transform2D: null,
  Mat4: null,
};

let parentCache: { size: number; map: Record<string, string | undefined> } | null = null;

/** class → parent, including every registered node type. */
export function classParents(): Record<string, string | undefined> {
  const all = nodeTypes.all();
  if (parentCache && parentCache.size === all.length) return parentCache.map;
  const map: Record<string, string | undefined> = { ...OTHER_CLASSES };
  for (const t of all) map[t.name] = t.base ?? 'Object';
  parentCache = { size: all.length, map };
  return map;
}

export const universe: TypeUniverse = {
  parentOf: (n) => classParents()[n],
  isReferenceType: (n) => n in classParents(),
  isKnown: (n) => n in classParents() || n in VALUE_TYPES,
};

export function isNodeClass(name: string) {
  return nodeTypes.has(name);
}

function compatibility(from: TypeRef, to: TypeRef): Compatibility {
  if (from.kind === 'float' && to.kind === 'int') return 'implicit'; // both are numbers at runtime
  return defaultCompatibility(from, to, universe);
}

export const gameStudioTypes: LanguageTypes = {
  universe,
  openTypes: true,
  normalize: (text) => {
    const s = text.trim();
    if (s === 'Vector2' || s === 'Vector3' || s === 'Color') return s;
    return normalizeTsType(s);
  },
  format: tsType,
  compatibility,
  operatorResult: (op, l, r) => typescriptAdapter.types.operatorResult(op, l, r),
  structFields: (name) => VALUE_TYPES[name] ?? undefined,
  pickerTypes: () => [
    'bool',
    'int',
    'float',
    'string',
    'Vector2',
    'Vector3',
    'Color',
    'any',
    ...nodeTypes.all().map((t) => t.name),
    'PackedScene',
    'Texture',
    'AudioStream',
    'Tween',
    'array<any>',
    'array<Node>',
    'array<string>',
    'array<float>',
    'array<Vector2>',
    'array<Vector3>',
    'map<string, any>',
  ],
  check: (t) => (t.kind === 'named' && !/^[A-Za-z_$][\w$.]*$/.test(t.name) ? `"${formatType(t)}" is not a valid type name` : undefined),
};
