/**
 * Scripts: TypeScript classes attached to nodes. A script's default export extends the node
 * type it is attached to, exactly like a Godot script `extends` its node:
 *
 *   import { CharacterBody2D, Input } from 'gamestudio';
 *
 *   export default class Player extends CharacterBody2D {
 *     static exports = { speed: { min: 0, max: 2000 }, jumpVelocity: {} };
 *     speed = 300;
 *     jumpVelocity = -600;
 *     _physicsProcess(delta: number) { … }
 *   }
 *
 * `static exports` lists the fields the inspector shows (names, or names → hints). Their types
 * and defaults come from the field initialisers.
 */
import { GameStudioError } from '@gs/shared';
import type { Node } from './node';
import { inferPropDef, type PropDef } from './properties';
import type { NodeRegistry } from './registry';

export type ScriptClass = (new () => Node) & { exports?: readonly string[] | Record<string, Partial<PropDef>> };

export interface ScriptInfo {
  path: string;
  /** Registered node type the script extends (e.g. "CharacterBody2D"). */
  baseType: string | null;
  className: string;
  exports: PropDef[];
  error?: string;
}

export class ScriptRegistry {
  private classes = new Map<string, ScriptClass>();
  /** Errors from loading each script (shown when a node uses it). */
  readonly loadErrors = new Map<string, string>();

  register(path: string, cls: unknown) {
    if (typeof cls !== 'function') {
      this.loadErrors.set(path, `${path} must "export default" a class extending a node type (e.g. export default class Player extends Node2D {…})`);
      return;
    }
    this.classes.set(path, cls as ScriptClass);
  }

  get(path: string) {
    return this.classes.get(path);
  }

  has(path: string) {
    return this.classes.has(path);
  }

  paths() {
    return [...this.classes.keys()];
  }

  /** Metadata for the editor: base type and exported properties (instantiates the class once, outside any tree). */
  describe(path: string, registry: NodeRegistry): ScriptInfo {
    const cls = this.classes.get(path);
    if (!cls) return { path, baseType: null, className: '', exports: [], error: this.loadErrors.get(path) ?? 'Script not loaded' };
    const type = registry.typeOfClass(cls);
    if (!type) return { path, baseType: null, className: cls.name, exports: [], error: `${cls.name || 'The default export'} does not extend a node type` };
    let instance: Node;
    try {
      instance = new cls();
    } catch (e) {
      return { path, baseType: type.name, className: cls.name, exports: [], error: `Constructing the script failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    const spec = cls.exports;
    const entries: [string, Partial<PropDef>][] = Array.isArray(spec) ? spec.map((n) => [n, {}]) : spec ? Object.entries(spec) : [];
    const exports: PropDef[] = [];
    const bad: string[] = [];
    for (const [name, hints] of entries) {
      const def = inferPropDef(name, (instance as unknown as Record<string, unknown>)[name], hints);
      if (def) exports.push(def);
      else bad.push(name);
    }
    instance.free();
    return { path, baseType: type.name, className: cls.name, exports, ...(bad.length ? { error: `Can't export ${bad.join(', ')}: give each a number, boolean, string, Vector2, Vector3 or Color initial value, or a type hint` } : {}) };
  }

  private composed = new Map<string, new () => Node>();

  /**
   * Creates the node for a scene node of `type` with script `path`.
   *
   * As in Godot, a script may extend the node's type or any of its ancestors: a script that
   * `extends Node3D` works on a MeshInstance3D. When the script extends an ancestor, its methods
   * are layered on top of the node's real class, so the node keeps everything its type does.
   */
  instantiate(path: string, type: string, registry: NodeRegistry): Node {
    const cls = this.classes.get(path);
    if (!cls) throw new GameStudioError('E_SCRIPT', this.loadErrors.get(path) ?? `Script "${path}" has no default-exported class (export default class … extends …), or it failed to compile`);
    const nodeCtor = registry.require(type).ctor;
    if (cls === nodeCtor || cls.prototype instanceof nodeCtor) return new cls();
    const scriptBase = registry.typeOfClass(cls);
    if (!scriptBase || !(nodeCtor === scriptBase.ctor || nodeCtor.prototype instanceof scriptBase.ctor)) {
      throw new GameStudioError('E_SCRIPT', `Script "${path}" extends ${scriptBase?.name ?? 'something that is not a node'}, which a ${type} is not. Change the script to extend ${type} (or one of its base types), or change the node's type.`);
    }
    const key = `${path}|${type}`;
    let Composite = this.composed.get(key);
    if (!Composite) {
      // Script classes between the script and its registered base, base-most first.
      const layers: (new () => Node)[] = [];
      for (let c: unknown = cls; c && c !== scriptBase.ctor; c = Object.getPrototypeOf(c)) layers.unshift(c as new () => Node);
      let proto: object = nodeCtor.prototype;
      for (const layer of layers) {
        const next = Object.create(proto);
        for (const key of Reflect.ownKeys(layer.prototype)) {
          if (key === 'constructor') continue;
          Object.defineProperty(next, key, Object.getOwnPropertyDescriptor(layer.prototype, key)!);
        }
        proto = next;
      }
      const C = function () {} as unknown as new () => Node;
      C.prototype = proto as Node;
      this.composed.set(key, (Composite = C));
    }
    // Runs the script's constructor chain (its field initialisers) with the composite prototype…
    const node = Reflect.construct(cls, [], Composite) as Node;
    // …then adds the fields of the node's own type that the script's chain didn't create.
    const defaults = new nodeCtor() as unknown as Record<string, unknown>;
    for (const k of Object.keys(defaults)) if (!Object.prototype.hasOwnProperty.call(node, k)) (node as unknown as Record<string, unknown>)[k] = defaults[k];
    return node;
  }
}
