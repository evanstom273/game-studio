/**
 * The stored form of a scene (a `.scene` file). Plain JSON, nested like the node tree.
 *
 *   { "root": { "id": "…", "name": "Main", "type": "Node2D", "props": { "position": [0, 0] },
 *               "children": [ … ] },
 *     "connections": [ { "from": "<node id>", "signal": "timeout", "to": "<node id>", "method": "onTimeout" } ] }
 *
 * Only properties that differ from the type's defaults need to be stored in `props`.
 * A node with `instance` is a nested scene: the instanced scene's tree appears there, and `props`
 * override its root's properties.
 */
import type { Json } from '@gs/shared';

export const SCENE_EXT = '.scene';
export const SCRIPT_EXTS = ['.ts', '.js', '.vgraph'] as const;

export interface NodeDoc {
  /** Unique within the scene. Stable across renames and moves (the editor, MCP and connections use it). */
  id: string;
  /** Unique among siblings. */
  name: string;
  /** A registered node type (e.g. "Sprite2D"). For instances: the instanced scene's root type. */
  type: string;
  props?: Record<string, Json>;
  /** Project path of the attached script, e.g. "scripts/player.ts". */
  script?: string | null;
  /** Values of the script's exported properties. */
  scriptProps?: Record<string, Json>;
  /** Project path of an instanced scene. */
  instance?: string;
  groups?: string[];
  children?: NodeDoc[];
}

export interface ConnectionDoc {
  from: string;
  signal: string;
  to: string;
  method: string;
}

export interface SceneDoc {
  root: NodeDoc;
  connections?: ConnectionDoc[];
}

/** Depth-first walk over a scene document. Return false from `fn` to skip a node's children. */
export function walkDoc(node: NodeDoc, fn: (n: NodeDoc, parent: NodeDoc | null, depth: number) => boolean | void, parent: NodeDoc | null = null, depth = 0) {
  if (fn(node, parent, depth) === false) return;
  for (const c of node.children ?? []) walkDoc(c, fn, node, depth + 1);
}

export function findDocNode(scene: SceneDoc, id: string): { node: NodeDoc; parent: NodeDoc | null } | null {
  let hit: { node: NodeDoc; parent: NodeDoc | null } | null = null;
  walkDoc(scene.root, (n, p) => {
    if (hit) return false;
    if (n.id === id) {
      hit = { node: n, parent: p };
      return false;
    }
  });
  return hit;
}

/** Path of a node relative to the scene root ("." for the root, "Player/Sprite" otherwise). */
export function docNodePath(scene: SceneDoc, id: string): string | null {
  const stack: string[] = [];
  const visit = (n: NodeDoc): boolean => {
    if (n.id === id) return true;
    for (const c of n.children ?? []) {
      stack.push(c.name);
      if (visit(c)) return true;
      stack.pop();
    }
    return false;
  };
  return visit(scene.root) ? stack.join('/') || '.' : null;
}

/** Finds a node by path relative to the root ("." / "" = root). */
export function docNodeByPath(scene: SceneDoc, path: string): NodeDoc | null {
  let cur: NodeDoc | undefined = scene.root;
  const parts = path.split('/').filter((p) => p && p !== '.');
  if (parts[0] === scene.root.name && !(scene.root.children ?? []).some((c) => c.name === parts[0])) parts.shift();
  for (const p of parts) {
    cur = cur?.children?.find((c) => c.name === p);
    if (!cur) return null;
  }
  return cur ?? null;
}
