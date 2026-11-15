/**
 * Node: the building block of every scene (Godot's Node).
 *
 * Lifecycle, as in Godot:
 *  - `_enterTree()` when the node joins the active tree, parents before children;
 *  - `_ready()` once, after the node and all its children have entered, children before parents;
 *  - `_process(delta)` every frame and `_physicsProcess(delta)` every fixed physics tick, in tree order;
 *  - `_input(event)` for input events, deepest nodes first; set `event.handled = true` to stop it;
 *  - `_exitTree()` when it leaves, children before parents.
 *
 * Scripts override the underscore methods without calling super. Engine internals use separate
 * `__`-prefixed hooks so a script can never break them by forgetting `super`.
 */
import { GameStudioError, Signal, newId } from '@gs/shared';
import type { InputEvent } from './input';
import type { SceneTree } from './scene-tree';

export type ProcessMode = 'inherit' | 'pausable' | 'whenPaused' | 'always' | 'disabled';

const NAME_RE = /^[^/:.@%"]+$/;

export class Node {
  /** Registered type name; subclasses set their own. Scripts inherit their base's. */
  static readonly typeName: string = 'Node';

  id: string = newId();
  /** Project path of the attached script (informational at runtime). */
  scriptPath: string | null = null;
  processMode: ProcessMode = 'inherit';

  readonly ready = new Signal<[]>('ready');
  readonly treeEntered = new Signal<[]>('treeEntered');
  readonly treeExiting = new Signal<[]>('treeExiting');
  readonly treeExited = new Signal<[]>('treeExited');
  readonly renamed = new Signal<[]>('renamed');
  readonly childEnteredTree = new Signal<[node: Node]>('childEnteredTree');
  readonly childExitingTree = new Signal<[node: Node]>('childExitingTree');

  private _name = '';
  private _parent: Node | null = null;
  private _children: Node[] = [];
  private _tree: SceneTree | null = null;
  private _readyDone = false;
  private _queuedFree = false;
  private _freed = false;
  private _groups = new Set<string>();
  /** The root of the scene this node was instantiated from (Godot's owner). */
  owner: Node | null = null;
  /** For the root of an instantiated scene: its project path (Godot's scene_file_path). */
  sceneFilePath: string | null = null;

  constructor(name?: string) {
    this._name = name ?? (this.constructor as typeof Node).typeName;
  }

  /** The registered type name of this node (scripts report their base type). */
  get typeName(): string {
    return (this.constructor as typeof Node).typeName;
  }

  // --- overridable lifecycle -----------------------------------------------------------------------
  _enterTree(): void {}
  _ready(): void {}
  _process(_delta: number): void {}
  _physicsProcess(_delta: number): void {}
  _input(_event: InputEvent): void {}
  _exitTree(): void {}

  // --- internal hooks (subclasses in the engine override these, always calling super) -------------
  /** @internal */ __enterTree(): void {}
  /** @internal */ __ready(): void {}
  /** @internal */ __exitTree(): void {}
  /** @internal Called every frame before `_process` (engine-side per-frame work, e.g. animation). */
  __process(_delta: number): void {}
  /** @internal Called every physics tick before `_physicsProcess` (e.g. ray casts, physics-driven animation). */
  __physicsProcess(_delta: number): void {}

  // --- naming ------------------------------------------------------------------------------------------
  get name() {
    return this._name;
  }
  set name(value: string) {
    const v = String(value).trim();
    if (!v || !NAME_RE.test(v)) throw new GameStudioError('E_BAD_NAME', `"${value}" is not a valid node name (no / : . @ % or quotes)`);
    if (v === this._name) return;
    this._name = this._parent ? this._parent.uniqueChildName(v, this) : v;
    this.renamed.emit();
  }

  /** @internal Returns `want`, or `want2`, `want3`… so siblings keep unique names. */
  uniqueChildName(want: string, except?: Node) {
    const taken = new Set(this._children.filter((c) => c !== except).map((c) => c._name));
    if (!taken.has(want)) return want;
    const base = want.replace(/\d+$/, '');
    let i = 2;
    while (taken.has(`${base}${i}`)) i++;
    return `${base}${i}`;
  }

  // --- hierarchy -----------------------------------------------------------------------------------------
  get parent() {
    return this._parent;
  }
  getParent<T extends Node = Node>() {
    return this._parent as T | null;
  }
  get children(): readonly Node[] {
    return this._children;
  }
  getChildren(): Node[] {
    return [...this._children];
  }
  getChildCount() {
    return this._children.length;
  }
  getChild<T extends Node = Node>(index: number): T {
    const i = index < 0 ? this._children.length + index : index;
    const c = this._children[i];
    if (!c) throw new GameStudioError('E_NOT_FOUND', `${this._name} has no child at index ${index}`);
    return c as T;
  }
  getIndex() {
    return this._parent ? this._parent._children.indexOf(this) : 0;
  }

  addChild<T extends Node>(child: T, index?: number): T {
    if (child === (this as Node)) throw new GameStudioError('E_CYCLE', 'A node cannot be its own child');
    if (child._parent) throw new GameStudioError('E_HAS_PARENT', `${child.name} already has a parent (${child._parent.name}); remove it or use reparent()`);
    if (child.isAncestorOf(this)) throw new GameStudioError('E_CYCLE', `${child.name} is an ancestor of ${this.name}`);
    if (child._freed) throw new GameStudioError('E_FREED', `${child.name} was freed`);
    child._name = this.uniqueChildName(child._name);
    const at = index === undefined || index < 0 || index > this._children.length ? this._children.length : index;
    this._children.splice(at, 0, child);
    child._parent = this;
    this._tree?.structureChanged();
    if (this._tree) {
      child.propagateEnterTree(this._tree);
      this.childEnteredTree.emit(child);
      child.propagateReady();
    }
    return child;
  }

  removeChild(child: Node) {
    const i = this._children.indexOf(child);
    if (i < 0) throw new GameStudioError('E_NOT_CHILD', `${child.name} is not a child of ${this.name}`);
    if (this._tree) {
      this.childExitingTree.emit(child);
      child.propagateExitTree();
    }
    this._children.splice(i, 1);
    child._parent = null;
    this._tree?.structureChanged();
  }

  moveChild(child: Node, toIndex: number) {
    const i = this._children.indexOf(child);
    if (i < 0) throw new GameStudioError('E_NOT_CHILD', `${child.name} is not a child of ${this.name}`);
    this._children.splice(i, 1);
    const at = Math.max(0, Math.min(this._children.length, toIndex));
    this._children.splice(at, 0, child);
    this._tree?.structureChanged();
  }

  /** Moves this node under `newParent`. Subclasses keep their global transform when `keepGlobalTransform` is true. */
  reparent(newParent: Node, keepGlobalTransform = true) {
    const save = keepGlobalTransform ? this.saveGlobalTransform() : null;
    this._parent?.removeChild(this);
    newParent.addChild(this);
    if (save) save();
  }

  /** @internal Overridden by Node2D/Node3D: captures the global transform, returns a restore function. */
  protected saveGlobalTransform(): (() => void) | null {
    return null;
  }

  isAncestorOf(node: Node) {
    for (let p = node._parent; p; p = p._parent) if (p === this) return true;
    return false;
  }

  /** Path from the tree root, e.g. "/root/Main/Player". */
  getPath(): string {
    const parts: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- walking up from this node
    for (let n: Node | null = this; n; n = n._parent) parts.unshift(n._name);
    return '/' + parts.join('/');
  }

  /**
   * Finds a node by path: "Child/Grandchild", "../Sibling", or absolute "/root/Main/Player".
   * Throws E_NOT_FOUND when nothing is there (use getNodeOrNull to test).
   */
  getNode<T extends Node = Node>(path: string): T {
    const n = this.getNodeOrNull<T>(path);
    if (!n) throw new GameStudioError('E_NOT_FOUND', `Node not found: "${path}" (from ${this.getPath()})`);
    return n;
  }

  getNodeOrNull<T extends Node = Node>(path: string): T | null {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- path walk starts here
    let cur: Node | null = this;
    let parts = path.split('/');
    if (path.startsWith('/')) {
      cur = this.root();
      parts = parts.slice(1);
      if (parts[0] === cur._name) parts.shift();
    }
    for (const p of parts) {
      if (!cur) return null;
      if (p === '' || p === '.') continue;
      if (p === '..') cur = cur._parent;
      else cur = cur._children.find((c) => c._name === p) ?? null;
    }
    return cur as T | null;
  }

  hasNode(path: string) {
    return this.getNodeOrNull(path) !== null;
  }

  /** Depth-first search by name pattern (`*` wildcards). */
  findChild<T extends Node = Node>(pattern: string, recursive = true): T | null {
    const re = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    for (const c of this._children) {
      if (re.test(c._name)) return c as T;
      if (recursive) {
        const hit = c.findChild<T>(pattern, true);
        if (hit) return hit;
      }
    }
    return null;
  }

  /** All descendants of a given class, e.g. `findChildrenOfType(Sprite2D)`. */
  findChildrenOfType<T extends Node>(ctor: abstract new (...args: never[]) => T): T[] {
    const out: T[] = [];
    this.walk((n) => {
      if (n !== this && n instanceof ctor) out.push(n as T);
    });
    return out;
  }

  /** Visits this node and its descendants depth-first. */
  walk(fn: (n: Node) => void) {
    fn(this);
    for (const c of this._children.slice()) c.walk(fn);
  }

  private root(): Node {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- walking up to the root
    let n: Node = this;
    while (n._parent) n = n._parent;
    return n;
  }

  // --- tree membership ----------------------------------------------------------------------------------
  get tree() {
    return this._tree;
  }
  getTree(): SceneTree {
    if (!this._tree) throw new GameStudioError('E_NOT_IN_TREE', `${this.name} is not inside the scene tree`);
    return this._tree;
  }
  isInsideTree() {
    return this._tree !== null;
  }
  isNodeReady() {
    return this._readyDone;
  }

  /** @internal */
  propagateEnterTree(tree: SceneTree) {
    this._tree = tree;
    for (const g of this._groups) tree.groupAdd(g, this);
    tree.nodeEntered(this);
    this.guard('_enterTree', () => {
      this.__enterTree();
      this._enterTree();
    });
    this.treeEntered.emit();
    for (const c of this._children.slice()) {
      c.propagateEnterTree(tree);
      this.childEnteredTree.emit(c);
    }
  }

  /** @internal */
  propagateReady() {
    for (const c of this._children.slice()) c.propagateReady();
    if (this._readyDone || !this._tree) return;
    this._readyDone = true;
    this.guard('_ready', () => {
      this.__ready();
      this._ready();
    });
    this.ready.emit();
  }

  /** @internal */
  propagateExitTree() {
    const tree = this._tree;
    if (!tree) return;
    this.treeExiting.emit();
    for (let i = this._children.length - 1; i >= 0; i--) {
      const c = this._children[i];
      this.childExitingTree.emit(c);
      c.propagateExitTree();
    }
    this.guard('_exitTree', () => {
      this._exitTree();
      this.__exitTree();
    });
    for (const g of this._groups) tree.groupRemove(g, this);
    tree.nodeExited(this);
    this._tree = null;
    this.treeExited.emit();
  }

  /** Runs a lifecycle callback, routing script errors to the tree's error reporter. */
  protected guard(where: string, fn: () => void) {
    try {
      fn();
    } catch (e) {
      if (this._tree) this._tree.reportError(e, this, where);
      else throw e;
    }
  }

  // --- groups -------------------------------------------------------------------------------------------------
  addToGroup(group: string) {
    if (this._groups.has(group)) return;
    this._groups.add(group);
    this._tree?.groupAdd(group, this);
  }
  removeFromGroup(group: string) {
    if (!this._groups.delete(group)) return;
    this._tree?.groupRemove(group, this);
  }
  isInGroup(group: string) {
    return this._groups.has(group);
  }
  getGroups() {
    return [...this._groups];
  }

  // --- processing ---------------------------------------------------------------------------------------------
  /** Whether this node runs `_process` / `_physicsProcess` right now (pause and processMode aware). */
  canProcess(): boolean {
    if (!this._tree) return false;
    let mode: ProcessMode = this.processMode;
    for (let p = this._parent; mode === 'inherit' && p; p = p._parent) mode = p.processMode;
    if (mode === 'inherit') mode = 'pausable';
    const paused = this._tree.paused;
    return mode === 'always' || (mode === 'pausable' && !paused) || (mode === 'whenPaused' && paused);
  }

  /** A tween that stops automatically when this node leaves the tree. */
  createTween() {
    return this.getTree().createTween(this);
  }

  // --- freeing ---------------------------------------------------------------------------------------------------
  /** Deletes this node (and its children) at the end of the current frame. Safe to call during callbacks. */
  queueFree() {
    if (this._queuedFree || this._freed) return;
    this._queuedFree = true;
    if (this._tree) this._tree.queueDelete(this);
    else this.free();
  }

  isQueuedForDeletion() {
    return this._queuedFree;
  }

  /** Deletes this node immediately. Prefer queueFree() during callbacks. */
  free() {
    if (this._freed) return;
    this._parent?.removeChild(this);
    for (const c of this._children.slice()) c.free();
    this._freed = true;
    for (const key of Object.keys(this)) {
      const v = (this as Record<string, unknown>)[key];
      if (v instanceof Signal) v.disconnectAll();
    }
  }

  isFreed() {
    return this._freed;
  }

  toString() {
    return `${this.typeName}(${this._name})`;
  }
}
