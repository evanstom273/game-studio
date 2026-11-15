/**
 * The edited scene as live engine nodes, for the editor viewports. Built with the real runtime
 * classes (so the viewport shows exactly what the game will draw) but without scripts — editing
 * never runs game code.
 *
 * Updates are incremental: nodes are matched by id and only changed properties are re-applied,
 * so renderer objects survive edits and dragging stays smooth.
 */
import { Node, ResourceLoader, instantiateScene, nodeTypes, propToRuntime, type NodeDoc, type PropContext, type SceneDoc } from '@gs/core';
import type { ProjectDoc } from '@gs/project';

const KEY = Symbol('gsDocKey');
type Tagged = Node & { [KEY]?: string };

export class LiveScene {
  root: Node | null = null;
  private byId = new Map<string, Node>();
  private resources: ResourceLoader | null = null;

  /** Live node for a scene node id (nested-instance internals map to their instance root). */
  node(id: string) {
    return this.byId.get(id) ?? null;
  }

  /** The scene node id a live node belongs to (instance internals → the instance node). */
  docId(n: Node): string | null {
    for (let cur: Node | null = n; cur; cur = cur.parent) {
      const id = cur.id.includes('/') ? cur.id.slice(0, cur.id.indexOf('/')) : cur.id;
      if (this.byId.has(id)) return id;
    }
    return null;
  }

  sync(project: ProjectDoc, scene: SceneDoc) {
    this.resources = new ResourceLoader({ asset: (p) => project.assets[p], scene: (p) => project.scenes[p] }, (ps) => instantiateScene(ps.doc, this.opts(project), ps.resourcePath));
    const ctx: PropContext = { loadResource: (kind, path) => this.resources!.loadKind(kind, path) };
    this.byId.clear();
    this.root = this.syncNode(this.root, scene.root, project, ctx, null);
    this.root.sceneFilePath = null;
  }

  private opts(project: ProjectDoc) {
    return { registry: nodeTypes, scripts: null, resources: this.resources, scene: (p: string) => project.scenes[p] };
  }

  private fresh(doc: NodeDoc, project: ProjectDoc): Node {
    // Build just this node (children are synced separately so they keep identity).
    const shallow: NodeDoc = { ...doc, children: undefined };
    let n: Node;
    try {
      n = instantiateScene({ root: shallow }, this.opts(project));
    } catch {
      n = new Node(doc.name);
    }
    n.id = doc.id;
    n.sceneFilePath = null;
    return n;
  }

  private syncNode(live: Node | null, doc: NodeDoc, project: ProjectDoc, ctx: PropContext, parent: Node | null): Node {
    const instanceKey = doc.instance ? JSON.stringify([doc, project.scenes[doc.instance]]) : '';
    const sameKind = live && live.id === doc.id && live.typeName === (nodeTypes.get(doc.type)?.name ?? 'Node') && ((live as Tagged)[KEY]?.startsWith('i:') ?? false) === !!doc.instance;
    let n = sameKind ? live! : null;
    if (doc.instance) {
      if (!n || (n as Tagged)[KEY] !== `i:${instanceKey}`) {
        if (n && parent) parent.removeChild(n);
        n = instantiateScene({ root: { ...doc, children: undefined } }, this.opts(project));
        n.id = doc.id;
        n.sceneFilePath = null;
        (n as Tagged)[KEY] = `i:${instanceKey}`;
      }
    } else {
      if (!n) {
        if (live && parent && live.parent === parent) parent.removeChild(live);
        n = this.fresh(doc, project);
      } else {
        const key = JSON.stringify([doc.name, doc.props ?? null]);
        if ((n as Tagged)[KEY] !== key) this.applyProps(n, doc, ctx);
      }
      (n as Tagged)[KEY] = JSON.stringify([doc.name, doc.props ?? null]);
    }
    n.scriptPath = doc.script ?? null;
    if (n.name !== doc.name) {
      try {
        n.name = doc.name;
      } catch {
        /* keep */
      }
    }
    this.byId.set(doc.id, n);
    // Children: match by id, keep order, drop the rest. (Instance internals are left alone.)
    const docKids = doc.children ?? [];
    const wanted = new Set(docKids.map((c) => c.id));
    for (const c of [...n.children]) if (!c.id.includes('/') && !wanted.has(c.id)) n.removeChild(c);
    docKids.forEach((cd, i) => {
      const existing = n!.children.find((c) => c.id === cd.id) ?? null;
      const synced = this.syncNode(existing, cd, project, ctx, n);
      if (synced.parent !== n) {
        if (synced.parent) synced.parent.removeChild(synced);
        n!.addChild(synced);
      }
      const offset = n!.children.filter((c) => c.id.includes('/')).length;
      if (n!.children.indexOf(synced) !== offset + i) n!.moveChild(synced, offset + i);
    });
    return n;
  }

  private applyProps(n: Node, doc: NodeDoc, ctx: PropContext) {
    const target = n as unknown as Record<string, unknown>;
    for (const def of nodeTypes.properties(doc.type)) {
      const value = doc.props && def.name in doc.props ? doc.props[def.name] : def.default;
      try {
        target[def.name] = propToRuntime(def, value, ctx);
      } catch {
        /* invalid value: leave as is */
      }
    }
  }
}
