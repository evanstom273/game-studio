/**
 * Blueprint look for the canvas (ported from Coding Studio): pin colours by type, node header
 * colours by category. Engine node families use Game Studio's colours (2D blue, 3D red, physics
 * green, audio amber) darkened so white titles stay readable.
 */
import { typeColorKey, type TypeRef } from '@cs/type-system';
import type { NodeInfo } from '@cs/compiler-core';
import type { NodeDefinition } from '@cs/node-registry';
import { nodeTypes } from '@gs/core';

export const TYPE_COLORS: Record<string, string> = {
  exec: '#f1f3f6',
  bool: '#e05a5a',
  int: '#2fd4bf',
  float: '#8bd94a',
  string: '#e46ff0',
  any: '#9aa3b2',
  object: '#5b9dff',
  struct: '#f4c542',
  array: '#ff9f43',
  map: '#ff8a65',
  function: '#c084fc',
  void: '#9aa3b2',
};

export function portColor(kind: 'exec' | 'data', type?: TypeRef): string {
  if (kind === 'exec') return TYPE_COLORS.exec;
  return TYPE_COLORS[typeColorKey(type ?? { kind: 'any' })] ?? TYPE_COLORS.any;
}

const CATEGORY_COLORS: [RegExp, string][] = [
  [/^Flow|^Async|^Errors/, '#4a5568'],
  [/^Variables/, '#2f855a'],
  [/^Literals/, '#38606b'],
  [/^Math\/|^Math$|^Comparison|^Logic/, '#3c6e47'],
  [/^Strings/, '#8a3b8f'],
  [/^Conversions/, '#4c5f7a'],
  [/^Arrays|^Dictionaries/, '#a05a23'],
  [/^Functions/, '#2b5fad'],
  [/^Objects|^Classes|^Resources/, '#2c5282'],
  [/^Debug|^Utility/, '#5a5f6b'],
  [/^Signals/, '#9b2c2c'],
  [/^Input/, '#8a5a1f'],
  [/^Scene|^Time|^Tween/, '#4b4f8f'],
];

/** Engine classes: by family (Godot's colours). */
function nodeClassColor(cls: string): string | undefined {
  const info = nodeTypes.get(cls);
  if (!info) return undefined;
  if (info.category === 'Audio') return '#8a6a2b';
  if (/^Physics/.test(info.category)) return '#2f7a62';
  const dim = nodeTypes.dimension(cls);
  return dim === '2d' ? '#3d5aa8' : dim === '3d' ? '#a3404f' : '#55606f';
}

export function categoryColor(category: string, flavor?: NodeDefinition['flavor']): string {
  if (flavor === 'entry') return '#9b2c2c';
  const m = /^Nodes\/(\w+)/.exec(category);
  if (m) return nodeClassColor(m[1]) ?? '#55606f';
  return CATEGORY_COLORS.find(([re]) => re.test(category))?.[1] ?? '#4a5568';
}

export function headerColor(info: Pick<NodeInfo, 'def'>): string {
  return categoryColor(info.def?.category ?? '', info.def?.flavor);
}

export interface BPNodeData extends Record<string, unknown> {
  info: NodeInfo;
  /** Connected port keys ("in:value", "out:then"); inline editors are hidden for connected inputs. */
  connected: string[];
  diag?: { severity: 'error' | 'warning' | 'info'; message: string; port?: string };
  /** The script and graph the node is in (inline edits write to it). */
  path: string;
  fnId: string;
}
