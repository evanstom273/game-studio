/**
 * The node graph canvas (React Flow), ported from Coding Studio. Rendering is derived from the
 * visual script's document; every change is dispatched as edit operations (one write_script each),
 * never written into React Flow's state directly (apart from transient drag positions).
 *
 * Touch: one finger pans, pinch zooms, drag from a pin (or tap a pin, then another) to connect,
 * long-press a node for its menu and the canvas for the add-node menu.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  useNodesInitialized,
  useReactFlow,
  type Connection,
  type Edge as RFEdge,
  type FinalConnectionState,
  type Node as RFNode,
  type NodeChange,
  type EdgeChange,
  type NodeTypes,
} from '@xyflow/react';
import { Plus } from 'lucide-react';
import type { Diagnostic, FunctionDecl, GraphNode, ScriptDoc } from '@cs/graph-core';
import { checkConnection, makeNodeContext, nodeInfo, type NodeInfo } from '@cs/compiler-core';
import { gameStudioToolchain } from '@gs/visual';
import { useLayout } from '@editor/lib/layout';
import { useUi } from '@editor/store/ui';
import { BlueprintNode } from './BlueprintNode';
import { FrameNode } from './FrameNode';
import { RerouteNode } from './RerouteNode';
import { AddNodeMenu, type ChainTarget, type PendingConnection } from './AddNodeMenu';
import { NodeContextMenu, type NodeMenuProps } from './NodeContextMenu';
import { portColor, type BPNodeData } from './model';
import { linkedFunctionOf } from './links';
import { editVisualScript, functionTitle, graphKey, openFunction, selectInGraph, useGraphSelection, useGraphUi, useVisualBuild } from './store';

const nodeTypes: NodeTypes = { bp: BlueprintNode, frame: FrameNode, reroute: RerouteNode };

type FlowNode = RFNode<BPNodeData>;

/** Cache of node data objects so unchanged nodes keep referential identity (memoised render). */
const dataCache = new WeakMap<GraphNode, { sig: string; data: BPNodeData }>();

function buildNodes(script: ScriptDoc, fn: FunctionDecl, path: string, selected: Set<string>, diags: Map<string, Diagnostic>): { nodes: FlowNode[]; infos: Map<string, NodeInfo> } {
  const tc = gameStudioToolchain();
  const ctx = makeNodeContext(tc, script, fn);
  const connected = new Map<string, string[]>();
  for (const e of fn.graph.edges) {
    (connected.get(e.from.node) ?? connected.set(e.from.node, []).get(e.from.node)!).push(`out:${e.from.port}`);
    (connected.get(e.to.node) ?? connected.set(e.to.node, []).get(e.to.node)!).push(`in:${e.to.port}`);
  }
  const infos = new Map<string, NodeInfo>();
  const nodes = fn.graph.nodes.map((n): FlowNode => {
    const raw = nodeInfo(tc, ctx, n);
    // Entry nodes read "Event Ready" / "Event Every Frame" rather than "Event _ready".
    const info = n.type === 'core.entry' && fn.kind === 'event' ? { ...raw, title: `Event ${functionTitle(fn)}` } : raw;
    infos.set(n.id, info);
    const conn = (connected.get(n.id) ?? []).sort();
    const d = diags.get(n.id);
    const diag = d ? { severity: d.severity, message: d.suggestion ? `${d.message} ${d.suggestion}` : d.message, ...(d.portId ? { port: d.portId } : {}) } : undefined;
    const sig = JSON.stringify([info.title, info.ports, conn, diag, path, fn.id]);
    let cached = dataCache.get(n);
    if (!cached || cached.sig !== sig) {
      cached = { sig, data: { info, connected: conn, diag, path, fnId: fn.id } };
      dataCache.set(n, cached);
    }
    const isFrame = info.def?.flavor === 'annotation';
    const isReroute = n.type === 'core.reroute' || n.type === 'core.reroute_exec';
    return {
      id: n.id,
      type: isFrame ? 'frame' : isReroute ? 'reroute' : 'bp',
      position: n.position,
      data: cached.data,
      selected: selected.has(n.id),
      deletable: n.type !== 'core.entry',
      ...(isFrame ? { style: { width: n.size?.width ?? 360, height: n.size?.height ?? 220 }, zIndex: -1 } : {}),
    };
  });
  return { nodes, infos };
}

function buildEdges(fn: FunctionDecl, infos: Map<string, NodeInfo>, selected: Set<string>): RFEdge[] {
  return fn.graph.edges.map((e) => {
    const port = infos.get(e.from.node)?.ports.find((p) => p.id === e.from.port);
    const exec = port?.kind === 'exec';
    const color = port ? portColor(port.kind, port.type) : '#ef4444';
    return {
      id: e.id,
      source: e.from.node,
      sourceHandle: e.from.port,
      target: e.to.node,
      targetHandle: e.to.port,
      selected: selected.has(e.id),
      style: { stroke: color, strokeWidth: exec ? 3 : 2, ...(port ? {} : { strokeDasharray: '4 3' }) },
      className: exec ? 'exec-edge' : 'data-edge',
      interactionWidth: 24,
      data: { exec },
    };
  });
}

/** The first exec output of a node (not a loop body), e.g. "then". */
function execOut(info: NodeInfo | undefined) {
  return info?.ports.find((p) => p.kind === 'exec' && p.direction === 'out' && p.region !== 'body');
}

// Settings handed to React Flow must keep the same identity between renders: it copies changed
// ones into its store, and a new array/object each render can loop (seen on phone layouts).
const MULTI_SELECT_KEYS = ['Shift', 'Control', 'Meta'];
const PAN_BUTTONS = [1, 2];
const SNAP_GRID: [number, number] = [16, 16];
const EDGE_OPTIONS = { type: 'default' };
const CONNECTION_LINE = { stroke: '#cbd2de', strokeWidth: 2 };
const PRO_OPTIONS = { hideAttribution: false };
const LONG_PRESS_MS = 480;

type MenuState = { screen: { x: number; y: number }; flow: { x: number; y: number }; pending?: PendingConnection; chain?: ChainTarget; sheet: boolean };

export function GraphCanvas({ path, doc, fn }: { path: string; doc: ScriptDoc; fn: FunctionDecl }) {
  const rf = useReactFlow<FlowNode>();
  const layout = useLayout();
  const touch = layout.touch;
  const compact = layout.mode === 'compact';
  const selection = useGraphSelection(path, fn.id);
  const build = useVisualBuild(path);
  const wrapRef = useRef<HTMLDivElement>(null);

  const diagMap = useMemo(() => {
    const m = new Map<string, Diagnostic>();
    const rank = { error: 0, warning: 1, info: 2 };
    for (const d of build.diagnostics) if (d.nodeId && (d.functionId === fn.id || d.graphId === fn.graph.id) && (!m.has(d.nodeId) || rank[d.severity] < rank[m.get(d.nodeId)!.severity])) m.set(d.nodeId, d);
    return m;
  }, [build.diagnostics, fn.id, fn.graph.id]);

  const selNodes = useMemo(() => new Set(selection.nodes), [selection.nodes]);
  const selEdges = useMemo(() => new Set(selection.edges), [selection.edges]);
  const derived = useMemo(() => buildNodes(doc, fn, path, selNodes, diagMap), [doc, fn, path, selNodes, diagMap]);
  const edges = useMemo(() => buildEdges(fn, derived.infos, selEdges), [fn, derived.infos, selEdges]);
  // React Flow keeps its own copy of the nodes (drag positions, measured sizes). When the document
  // changes (an edit here, undo, or the AI editing the script), replace that copy in the same
  // render (not in an effect): rendering once with a stale copy made React Flow report the old
  // selection back, and the selection flipped forever.
  const [nodes, setNodes] = useState<FlowNode[]>(derived.nodes);
  const [synced, setSynced] = useState(derived.nodes);
  if (synced !== derived.nodes) {
    setSynced(derived.nodes);
    setNodes(derived.nodes);
  }

  const [menu, setMenu] = useState<MenuState | null>(null);
  const [nodeMenu, setNodeMenu] = useState<Omit<NodeMenuProps, 'onClose'> | null>(null);
  const connectingFrom = useRef<PendingConnection | null>(null);
  const sheet = compact || (touch && layout.width < 900);

  // Restore (or fit) the viewport when switching graphs.
  const initialized = useNodesInitialized();
  const shown = useRef<string | null>(null);
  const key = graphKey(path, fn.id);
  useEffect(() => {
    if (shown.current === key) return;
    const vp = useGraphUi.getState().viewports[key] ?? fn.graph.viewport;
    if (vp) {
      shown.current = key;
      void rf.setViewport(vp);
    } else if (initialized || fn.graph.nodes.length === 0) {
      shown.current = key;
      requestAnimationFrame(() => void rf.fitView({ padding: 0.25, maxZoom: 1, minZoom: 0.5 }));
    }
  }, [key, initialized, fn.graph.viewport, fn.graph.nodes.length, rf]);

  // Centre on a node requested by the diagnostics list / code view, or bring a node that was just
  // added into view (on a phone the next step of a chain is usually past the edge of the screen).
  const focus = useGraphUi((s) => s.focus);
  useEffect(() => {
    if (!focus || focus.path !== path || focus.fnId !== fn.id) return;
    const n = fn.graph.nodes.find((x) => x.id === focus.nodeId);
    if (!n) return;
    // Wait a frame so a node added just now has been measured.
    const t = setTimeout(() => {
      const size = (id: string) => rf.getNode(id)?.measured ?? { width: 200, height: 90 };
      const { width: w = 200, height: h = 90 } = size(n.id);
      const vp = rf.getViewport();
      if (!focus.reveal) return void rf.setCenter(n.position.x + w / 2, n.position.y + h / 2, { zoom: Math.max(vp.zoom, 0.9), duration: 300 });
      const r = wrapRef.current?.getBoundingClientRect();
      if (!r) return;
      const other = focus.with ? fn.graph.nodes.find((x) => x.id === focus.with) : undefined;
      const boxes = [{ ...n.position, w, h }, ...(other ? [{ ...other.position, w: size(other.id).width ?? 200, h: size(other.id).height ?? 90 }] : [])];
      const visible = boxes.every((b) => b.x * vp.zoom + vp.x >= 8 && b.y * vp.zoom + vp.y >= 8 && (b.x + b.w) * vp.zoom + vp.x <= r.width - 8 && (b.y + b.h) * vp.zoom + vp.y <= r.height - 8);
      if (visible) return;
      // Both fit at this zoom (or a little smaller): show both; otherwise just the new node.
      if (other) void rf.fitView({ nodes: [{ id: n.id }, { id: other.id }], padding: 0.12, maxZoom: vp.zoom, minZoom: Math.min(vp.zoom, 0.7), duration: 300 });
      else void rf.setCenter(n.position.x + w / 2, n.position.y + h / 2, { zoom: vp.zoom, duration: 300 });
    }, 40);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.seq]);

  // The selection lives in the graph store. React Flow's clicks / box-selects arrive as "select"
  // changes and become store selections; React Flow then just shows what the store says.
  const onNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      const sel = changes.filter((c) => c.type === 'select');
      const rest = changes.filter((c) => c.type !== 'select');
      if (rest.length) setNodes((nds) => applyNodeChanges(rest, nds));
      if (sel.length) {
        const cur = useGraphUi.getState().selection;
        const k = graphKey(path, fn.id);
        const next = new Set(cur.key === k ? cur.nodes : []);
        for (const c of sel) {
          if (c.type !== 'select') continue;
          if (c.selected) next.add(c.id);
          else next.delete(c.id);
        }
        selectInGraph(path, fn.id, [...next], cur.key === k ? cur.edges : []);
      }
    },
    [path, fn.id],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const sel = changes.filter((c) => c.type === 'select');
      if (!sel.length) return;
      const cur = useGraphUi.getState().selection;
      const k = graphKey(path, fn.id);
      const next = new Set(cur.key === k ? cur.edges : []);
      for (const c of sel) {
        if (c.type !== 'select') continue;
        if (c.selected) next.add(c.id);
        else next.delete(c.id);
      }
      selectInGraph(path, fn.id, cur.key === k ? cur.nodes : [], [...next]);
    },
    [path, fn.id],
  );

  const onNodeDragStop = useCallback(
    (_e: unknown, _n: RFNode, dragged: RFNode[]) => {
      const moved = dragged.filter((d) => {
        const orig = fn.graph.nodes.find((x) => x.id === d.id);
        return orig && (Math.round(orig.position.x) !== Math.round(d.position.x) || Math.round(orig.position.y) !== Math.round(d.position.y));
      });
      if (!moved.length) return;
      editVisualScript(path, [{ op: 'move_nodes', nodes: moved.map((d) => d.id), positions: Object.fromEntries(moved.map((d) => [d.id, { x: Math.round(d.position.x), y: Math.round(d.position.y) }])) }], moved.length > 1 ? `Move ${moved.length} nodes` : 'Move node', { functionId: fn.id });
    },
    [path, fn],
  );

  const isValidConnection = useCallback(
    (c: Connection | RFEdge) => {
      if (c.source === c.target) return false;
      const a = derived.infos.get(c.source)?.ports.find((p) => p.id === c.sourceHandle && p.direction === 'out');
      const b = derived.infos.get(c.target)?.ports.find((p) => p.id === c.targetHandle && p.direction === 'in');
      if (!a || !b) return false;
      return checkConnection(gameStudioToolchain(), a, b).severity !== 'error';
    },
    [derived.infos],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      connectingFrom.current = null;
      if (!c.sourceHandle || !c.targetHandle) return;
      editVisualScript(path, [{ op: 'connect', from: { node: c.source, port: c.sourceHandle }, to: { node: c.target, port: c.targetHandle } }], 'Connect', { functionId: fn.id });
    },
    [path, fn.id],
  );

  const onConnectStart = useCallback((_e: unknown, p: { nodeId: string | null; handleId: string | null; handleType: 'source' | 'target' | null }) => {
    connectingFrom.current = p.nodeId && p.handleId && p.handleType ? { nodeId: p.nodeId, portId: p.handleId, handleType: p.handleType } : null;
  }, []);

  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      const pending = connectingFrom.current;
      connectingFrom.current = null;
      if (!pending || state.isValid || state.toHandle) return;
      const pt = 'changedTouches' in event ? event.changedTouches[0] : event;
      if (!pt) return;
      // Dropped a wire on empty canvas: offer compatible nodes (Blueprint-style). Touch events
      // target where the finger went down, so look up what is under the point instead.
      if (document.elementFromPoint(pt.clientX, pt.clientY)?.closest('.react-flow__node')) return;
      setMenu({ screen: { x: pt.clientX, y: pt.clientY }, flow: rf.screenToFlowPosition({ x: pt.clientX, y: pt.clientY }), pending, sheet });
    },
    [rf, sheet],
  );

  /** Where a node added without a dragged wire connects: after the selected node, or at the end of the event's chain. */
  const chainTarget = useCallback((): ChainTarget | undefined => {
    const sel = useGraphUi.getState().selection;
    const ids = sel.key === graphKey(path, fn.id) ? sel.nodes : [];
    const from = (id: string): ChainTarget | undefined => {
      const info = derived.infos.get(id);
      const port = execOut(info);
      const node = fn.graph.nodes.find((n) => n.id === id);
      if (!info || !port || !node || fn.graph.edges.some((e) => e.from.node === id && e.from.port === port.id)) return undefined;
      const width = rf.getNode(id)?.measured?.width ?? 200;
      return { nodeId: id, portId: port.id, title: info.title, at: { x: Math.round(node.position.x + width + 70), y: Math.round(node.position.y) } };
    };
    if (ids.length === 1) return from(ids[0]);
    if (ids.length) return undefined;
    // Nothing selected: follow the exec wires from the entry to the first free "then".
    let cur = fn.graph.nodes.find((n) => n.type === 'core.entry')?.id;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const port = execOut(derived.infos.get(cur));
      if (!port) return undefined;
      const next = fn.graph.edges.find((e) => e.from.node === cur && e.from.port === port.id);
      if (!next) return from(cur);
      cur = next.to.node;
    }
    return undefined;
  }, [derived.infos, fn, path, rf]);

  const openMenuAt = useCallback(
    (x: number, y: number, chain = false) => {
      setNodeMenu(null);
      setMenu({ screen: { x, y }, flow: rf.screenToFlowPosition({ x, y }), chain: chain ? chainTarget() : undefined, sheet });
    },
    [rf, sheet, chainTarget],
  );

  /** Add-node menu for the middle of the visible canvas (buttons, bottom bar, shortcut). */
  const openMenuCentred = useCallback(() => {
    const r = wrapRef.current?.getBoundingClientRect();
    if (!r) return;
    setNodeMenu(null);
    const centre = { x: r.left + r.width / 2, y: r.top + r.height * (sheet ? 0.25 : 0.4) };
    setMenu({ screen: { x: Math.max(8, centre.x - 170), y: r.top + 24 }, flow: rf.screenToFlowPosition(centre), chain: chainTarget(), sheet });
  }, [rf, sheet, chainTarget]);

  const addRequest = useGraphUi((s) => s.addRequest);
  const seenRequest = useRef(addRequest);
  useEffect(() => {
    if (addRequest === seenRequest.current) return;
    seenRequest.current = addRequest;
    openMenuCentred();
  }, [addRequest, openMenuCentred]);

  const openNodeMenu = useCallback(
    (x: number, y: number, nodeId: string) => {
      const node = fn.graph.nodes.find((n) => n.id === nodeId);
      if (!node) return;
      const cur = useGraphUi.getState().selection;
      if (cur.key !== graphKey(path, fn.id) || !cur.nodes.includes(nodeId)) selectInGraph(path, fn.id, [nodeId]);
      const target = linkedFunctionOf(doc, node);
      setMenu(null);
      setNodeMenu({ x, y, nodeId, title: derived.infos.get(nodeId)?.title ?? node.type, isEntry: node.type === 'core.entry', sheet, open: target ? { label: `Open ${functionTitle(target)}`, run: () => openFunction(path, target.id) } : undefined });
    },
    [doc, fn, path, derived.infos, sheet],
  );

  // Long-press (touch): node → its menu, empty canvas → add-node menu there.
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const pressedAt = useRef(0);
  const cancelPress = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  };
  const onPointerDown = (e: React.PointerEvent) => {
    cancelPress();
    if (e.pointerType !== 'touch' || !e.isPrimary) return;
    const target = e.target as Element;
    if (target.closest('.react-flow__handle, input, button, select, .react-flow__controls')) return;
    const nodeEl = target.closest<HTMLElement>('.react-flow__node');
    const onPane = !nodeEl && target.closest('.react-flow__pane');
    if (!nodeEl && !onPane) return;
    const { clientX: x, clientY: y } = e;
    press.current = {
      x,
      y,
      timer: setTimeout(() => {
        press.current = null;
        pressedAt.current = Date.now();
        navigator.vibrate?.(12);
        // Lifting the finger may still produce a click, which would land on the menu that just
        // opened under it: swallow that one click.
        const swallow = (ev: Event) => {
          ev.stopPropagation();
          ev.preventDefault();
        };
        window.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 1000);
        const id = nodeEl?.dataset.id;
        if (id) openNodeMenu(x, y, id);
        else openMenuAt(x, y);
      }, LONG_PRESS_MS),
    };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const p = press.current;
    if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) cancelPress();
  };
  // A long-press also fires the browser's contextmenu event on some phones: one menu is enough.
  const recentlyPressed = () => Date.now() - pressedAt.current < 900;

  const viewportTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  return (
    <div
      ref={wrapRef}
      className="relative h-full w-full"
      data-testid="graph-canvas"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={cancelPress}
      onPointerCancel={cancelPress}
    >
      <ReactFlow<FlowNode>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStart={cancelPress}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        onConnectStart={onConnectStart}
        onConnectEnd={onConnectEnd}
        isValidConnection={isValidConnection}
        onPaneContextMenu={(e) => {
          e.preventDefault();
          if (!recentlyPressed()) openMenuAt(e.clientX, e.clientY);
        }}
        onNodeContextMenu={(e, n) => {
          e.preventDefault();
          if (!recentlyPressed()) openNodeMenu(e.clientX, e.clientY, n.id);
        }}
        onNodeDoubleClick={(_e, n) => {
          const node = fn.graph.nodes.find((x) => x.id === n.id);
          // Call Function / Connect Signal / Inline Function: double-click opens that function's graph.
          const target = node && linkedFunctionOf(doc, node);
          if (target) openFunction(path, target.id);
          // Phones: double-tap a node to see its properties.
          else if (compact) useUi.getState().set({ sheet: 'inspector', sheetSize: 'half' });
        }}
        onMoveEnd={(_e, vp) => {
          if (viewportTimer.current) clearTimeout(viewportTimer.current);
          viewportTimer.current = setTimeout(() => {
            const s = useGraphUi.getState();
            s.set({ viewports: { ...s.viewports, [key]: { x: Math.round(vp.x), y: Math.round(vp.y), zoom: Math.round(vp.zoom * 1000) / 1000 } } });
          }, 300);
        }}
        deleteKeyCode={null}
        selectionKeyCode="Shift"
        multiSelectionKeyCode={MULTI_SELECT_KEYS}
        // Touch: one finger pans, pinch zooms. Mouse: drag box-selects, middle/right-drag pans.
        panOnDrag={touch ? true : PAN_BUTTONS}
        selectionOnDrag={!touch}
        panActivationKeyCode="Space"
        snapToGrid={false}
        snapGrid={SNAP_GRID}
        minZoom={0.1}
        maxZoom={2.5}
        connectionRadius={touch ? 44 : 24}
        defaultEdgeOptions={EDGE_OPTIONS}
        connectionLineStyle={CONNECTION_LINE}
        proOptions={PRO_OPTIONS}
        colorMode="dark"
        elevateEdgesOnSelect
        zoomOnDoubleClick={false}
      >
        <Background variant={BackgroundVariant.Lines} gap={16} color="#1b2029" />
        <Background id="major" variant={BackgroundVariant.Lines} gap={128} color="#232a35" />
        <Controls showInteractive={false} position="bottom-left" />
        {touch && !compact && (
          <button aria-label="Add node" data-testid="fab-add-node" className="absolute bottom-6 right-4 z-10 flex h-12 w-12 items-center justify-center rounded-full bg-accent text-white shadow-xl active:bg-accent-2" onClick={openMenuCentred}>
            <Plus size={22} />
          </button>
        )}
        {!compact && layout.width >= 1000 && fn.graph.nodes.length > 6 && <MiniMap pannable zoomable position="bottom-right" nodeColor="#3b4352" maskColor="rgba(10,12,16,0.7)" />}
      </ReactFlow>
      {fn.graph.nodes.length <= 1 && (
        <div className="pointer-events-none absolute left-1/2 top-4 w-max max-w-[calc(100%-32px)] -translate-x-1/2 rounded-md border border-border bg-panel/90 px-3 py-2 text-center text-[12px] leading-snug text-muted" data-testid="graph-hint">
          {touch ? 'Tap + to add a step. It joins on after the last one; drag from a ▶ pin to wire things up yourself.' : 'Right-click the canvas (or press Tab) to add a node, then drag from the ▶ pin to connect it.'}
        </div>
      )}
      {menu && <AddNodeMenu path={path} script={doc} fn={fn} {...menu} onClose={() => setMenu(null)} />}
      {nodeMenu && <NodeContextMenu {...nodeMenu} onClose={() => setNodeMenu(null)} />}
    </div>
  );
}
