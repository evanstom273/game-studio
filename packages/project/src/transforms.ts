/** Transform maths on scene documents (used to keep a node's global transform when reparenting). */
import { Mat4, Transform2D, Vector2, Vector3 } from '@gs/shared';
import type { NodeDoc, NodeRegistry, SceneDoc } from '@gs/core';

/** Root → node chain of documents, or null. */
export function docChain(scene: SceneDoc, id: string): NodeDoc[] | null {
  const trail: NodeDoc[] = [];
  const visit = (n: NodeDoc): boolean => {
    trail.push(n);
    if (n.id === id) return true;
    for (const c of n.children ?? []) if (visit(c)) return true;
    trail.pop();
    return false;
  };
  return visit(scene.root) ? trail : null;
}

const num = (v: unknown, d: number) => (typeof v === 'number' ? v : d);
const v2 = (v: unknown, d: [number, number]) => Vector2.fromArray(Array.isArray(v) ? (v as number[]) : d);
const v3 = (v: unknown, d: [number, number, number]) => Vector3.fromArray(Array.isArray(v) ? (v as number[]) : d);

function local2D(n: NodeDoc) {
  return Transform2D.compose(v2(n.props?.position, [0, 0]), num(n.props?.rotation, 0), v2(n.props?.scale, [1, 1]));
}
function local3D(n: NodeDoc) {
  return Mat4.compose(v3(n.props?.position, [0, 0, 0]), v3(n.props?.rotation, [0, 0, 0]), v3(n.props?.scale, [1, 1, 1]));
}

/** Global transform of the last node of `chain`, following only same-dimension ancestors. */
function global2D(chain: NodeDoc[], registry: NodeRegistry): Transform2D {
  let t = Transform2D.identity();
  for (let i = chain.length - 1; i >= 0 && registry.isA(chain[i].type, 'Node2D'); i--) t = local2D(chain[i]).multiply(t);
  return t;
}
function global3D(chain: NodeDoc[], registry: NodeRegistry): Mat4 {
  let m = Mat4.identity();
  for (let i = chain.length - 1; i >= 0 && registry.isA(chain[i].type, 'Node3D'); i--) m = local3D(chain[i]).multiply(m);
  return m;
}

const round = (x: number) => Math.round(x * 1e6) / 1e6 + 0;

/**
 * New local transform props for `node` (still at `oldChain`) when it moves under `newParentChain`
 * so that its global transform stays the same. Returns null for nodes without a transform.
 */
export function keepGlobalProps(oldChain: NodeDoc[], newParentChain: NodeDoc[], registry: NodeRegistry): Record<string, unknown> | null {
  const node = oldChain[oldChain.length - 1];
  if (registry.isA(node.type, 'Node2D')) {
    const g = global2D(oldChain, registry);
    const parent = newParentChain.length && registry.isA(newParentChain[newParentChain.length - 1].type, 'Node2D') ? global2D(newParentChain, registry) : Transform2D.identity();
    const l = parent.invert().multiply(g);
    const s = l.scale;
    return { position: [round(l.tx), round(l.ty)], rotation: round(l.rotation), scale: [round(s.x), round(s.y)] };
  }
  if (registry.isA(node.type, 'Node3D')) {
    const g = global3D(oldChain, registry);
    const parent = newParentChain.length && registry.isA(newParentChain[newParentChain.length - 1].type, 'Node3D') ? global3D(newParentChain, registry) : Mat4.identity();
    const d = parent.invert().multiply(g).decompose();
    return { position: d.position.toArray().map(round), rotation: d.rotation.toArray().map(round), scale: d.scale.toArray().map(round) };
  }
  return null;
}
