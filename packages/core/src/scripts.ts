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

  /** The class to construct for a node of `type` with script `path`. Throws when they don't fit together. */
  classFor(path: string, type: string, registry: NodeRegistry): ScriptClass {
    const cls = this.classes.get(path);
    if (!cls) throw new GameStudioError('E_SCRIPT', this.loadErrors.get(path) ?? `Script "${path}" was not found or failed to compile`);
    const base = registry.require(type).ctor;
    if (!(cls === base || cls.prototype instanceof base)) {
      const actual = registry.typeOfClass(cls)?.name ?? 'something else';
      throw new GameStudioError('E_SCRIPT', `Script "${path}" extends ${actual}, but it is attached to a ${type}. Change the script to extend ${type}, or change the node's type to ${actual}.`);
    }
    return cls;
  }
}
