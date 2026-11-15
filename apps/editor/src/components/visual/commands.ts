/**
 * Selection commands for the open graph (ported from Coding Studio's lib/commands.ts): delete,
 * copy / cut / paste, duplicate, collapse, wrap in a comment frame. Used by the context menu, the
 * keyboard shortcuts and the touch selection bar.
 */
import type { Edge, GraphNode } from '@cs/graph-core';
import { useEditor } from '@editor/store/editor';
import { activeVisualPath, editVisualScript, graphKey, pickFunction, readVisualScript, selectInGraph, useGraphUi } from './store';

const CLIP_KEY = 'game-studio:graph-clipboard';
let clipboard: { nodes: GraphNode[]; edges: Edge[] } | null = null;

/** The open graph: its script path, function and current selection. */
export function activeGraph(path = activeVisualPath()) {
  if (!path) return null;
  const doc = readVisualScript(useEditor.getState().project?.scripts[path]).doc;
  if (!doc) return null;
  const ui = useGraphUi.getState();
  const fn = pickFunction(doc, ui.activeFn[path]);
  if (!fn) return null;
  const sel: { nodes: string[]; edges: string[] } = ui.selection.key === graphKey(path, fn.id) ? ui.selection : { nodes: [], edges: [] };
  return { path, doc, fn, nodes: sel.nodes, edges: sel.edges };
}

export function deleteSelection() {
  const g = activeGraph();
  if (!g) return;
  const nodes = g.nodes.filter((id) => g.fn.graph.nodes.some((n) => n.id === id && n.type !== 'core.entry'));
  const edges = g.edges.filter((id) => g.fn.graph.edges.some((e) => e.id === id && !nodes.includes(e.from.node) && !nodes.includes(e.to.node)));
  if (!nodes.length && !edges.length) return;
  const ops = [...(nodes.length ? [{ op: 'delete_nodes' as const, nodes }] : []), ...(edges.length ? [{ op: 'disconnect' as const, edges }] : [])];
  if (editVisualScript(g.path, ops, nodes.length ? (nodes.length > 1 ? `Delete ${nodes.length} nodes` : 'Delete node') : 'Delete connection', { functionId: g.fn.id })) selectInGraph(g.path, g.fn.id, []);
}

export function copySelection(): boolean {
  const g = activeGraph();
  if (!g || !g.nodes.length) return false;
  const ids = new Set(g.nodes);
  const nodes = g.fn.graph.nodes.filter((n) => ids.has(n.id) && n.type !== 'core.entry');
  if (!nodes.length) return false;
  clipboard = { nodes: structuredClone(nodes), edges: g.fn.graph.edges.filter((e) => ids.has(e.from.node) && ids.has(e.to.node)) };
  try {
    sessionStorage.setItem(CLIP_KEY, JSON.stringify(clipboard));
  } catch {
    /* storage unavailable */
  }
  return true;
}

export function cutSelection() {
  if (copySelection()) deleteSelection();
}

export function clipboardSize(): number {
  if (!clipboard) {
    try {
      clipboard = JSON.parse(sessionStorage.getItem(CLIP_KEY) ?? 'null');
    } catch {
      clipboard = null;
    }
  }
  return clipboard?.nodes.length ?? 0;
}

/** Paste the copied nodes (at a flow position, or offset from where they were). */
export function paste(at?: { x: number; y: number }) {
  const g = activeGraph();
  if (!g || !clipboardSize() || !clipboard) return;
  const minX = Math.min(...clipboard.nodes.map((n) => n.position.x));
  const minY = Math.min(...clipboard.nodes.map((n) => n.position.y));
  const offset = at ? { x: Math.round(at.x - minX), y: Math.round(at.y - minY) } : { x: 48, y: 48 };
  const r = editVisualScript(g.path, [{ op: 'paste_nodes', ref: 'p', nodes: clipboard.nodes, edges: clipboard.edges, offset }], `Paste ${clipboard.nodes.length} node(s)`, { functionId: g.fn.id });
  if (r) selectInGraph(g.path, g.fn.id, Object.entries(r.created).filter(([k]) => k.startsWith('p.')).map(([, v]) => v));
}

export function duplicateSelection() {
  const g = activeGraph();
  if (!g) return;
  const nodes = g.nodes.filter((id) => g.fn.graph.nodes.some((n) => n.id === id && n.type !== 'core.entry'));
  if (!nodes.length) return;
  const r = editVisualScript(g.path, [{ op: 'duplicate_nodes', ref: 'd', nodes, offset: { x: 48, y: 48 } }], 'Duplicate', { functionId: g.fn.id });
  if (r) selectInGraph(g.path, g.fn.id, Object.entries(r.created).filter(([k]) => k.startsWith('d.')).map(([, v]) => v));
}

export function selectAll() {
  const g = activeGraph();
  if (g) selectInGraph(g.path, g.fn.id, g.fn.graph.nodes.map((n) => n.id));
}

export function toggleCollapse() {
  const g = activeGraph();
  const nodes = g?.fn.graph.nodes.filter((n) => g.nodes.includes(n.id)) ?? [];
  if (!g || !nodes.length) return;
  const collapse = !nodes.every((n) => n.collapsed);
  editVisualScript(g.path, nodes.map((n) => ({ op: 'update_node' as const, node: n.id, collapsed: collapse })), collapse ? 'Collapse' : 'Expand', { functionId: g.fn.id });
}

export function frameSelection() {
  const g = activeGraph();
  const nodes = g?.fn.graph.nodes.filter((n) => g.nodes.includes(n.id)) ?? [];
  if (!g || !nodes.length) return;
  const x = Math.min(...nodes.map((n) => n.position.x)) - 32;
  const y = Math.min(...nodes.map((n) => n.position.y)) - 56;
  const w = Math.max(...nodes.map((n) => n.position.x)) - x + 260;
  const h = Math.max(...nodes.map((n) => n.position.y)) - y + 160;
  editVisualScript(g.path, [{ op: 'add_node', ref: 'fr', type: 'core.frame', position: { x, y } }, { op: 'update_node', node: '$fr', size: { width: w, height: h } }], 'Add comment frame', { functionId: g.fn.id });
}

/** Remove every wire attached to a node. */
export function disconnectNode(nodeId: string) {
  const g = activeGraph();
  if (!g) return;
  const edges = g.fn.graph.edges.filter((e) => e.from.node === nodeId || e.to.node === nodeId).map((e) => e.id);
  if (edges.length) editVisualScript(g.path, [{ op: 'disconnect', edges }], 'Disconnect', { functionId: g.fn.id });
}

/** Ask the canvas to open its add-node menu (bottom bar, Ctrl+A). */
export function requestAddNode() {
  const s = useGraphUi.getState();
  s.set({ addRequest: s.addRequest + 1 });
}
