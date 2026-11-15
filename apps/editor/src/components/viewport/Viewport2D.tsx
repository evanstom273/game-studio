/**
 * 2D scene viewport: the real 2D renderer (PixiJS) drawing the live scene, with an overlay canvas
 * for the grid, the game frame, camera frames, selection and transform handles.
 *
 * Mouse: click to select, drag to transform with the active tool, wheel to zoom, middle/right drag
 * or Space+drag to pan. Touch: tap to select, drag a selected node to transform it, drag empty space
 * or use two fingers to pan, pinch to zoom.
 */
import { useEffect, useRef } from 'react';
import { Transform2D, Vector2, degToRad, errorMessage } from '@gs/shared';
import { AudioStreamPlayer2D, CPUParticles2D, Camera2D, CollisionShape2D, Control, Marker2D, Node2D, Parallax2D, Path2D, PointLight2D, RayCast2D, TileMapLayer, VisibleOnScreenNotifier2D, type Node } from '@gs/core';
import { Renderer2D } from '@gs/render2d';
import { useEditor } from '@editor/store/editor';
import { useUi } from '@editor/store/ui';
import { toast } from '@editor/store/toasts';
import { assetUrl } from '@editor/services/assets';
import { LiveScene } from './live-scene';
import { viewportEvents } from './Viewport';
import { TilePalette, selectedTileMap, useTilePaint } from './TilePalette';

const HANDLE = 7;

interface Drag {
  kind: 'pan' | 'move' | 'rotate' | 'scale' | 'axis-x' | 'axis-y';
  start: Vector2;
  last: Vector2;
  ids: string[];
  /** Per node: start global position, local position, local rotation, scale. */
  starts: Map<string, { global: Vector2; local: Vector2; rotation: number; scale: Vector2 }>;
  pivot: Vector2;
  session: number;
  moved: boolean;
}

let sessionSeq = 0;
const round = (n: number) => Math.round(n * 100) / 100;

/** A node's transform into the editor's world: CanvasLayer content sits at the world origin, offset by the layer. */
const canvasXf = (n: Node2D): Transform2D => {
  const layer = n.getCanvasLayer();
  return layer ? layer.transform.multiply(n.globalTransform) : n.globalTransform;
};

/** Cells on the line between two map cells (so fast strokes don't skip tiles). */
function cellLine(a: Vector2, b: Vector2): Vector2[] {
  const out: Vector2[] = [];
  let x = a.x;
  let y = a.y;
  const dx = Math.abs(b.x - x);
  const dy = -Math.abs(b.y - y);
  const sx = x < b.x ? 1 : -1;
  const sy = y < b.y ? 1 : -1;
  let err = dx + dy;
  for (let guard = 0; guard < 4096; guard++) {
    out.push(new Vector2(x, y));
    if (x === b.x && y === b.y) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
  return out;
}

export default function Viewport2D({ scenePath }: { scenePath: string }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current!;
    // Fresh canvases per run: a disposed renderer loses its WebGL context, which must never be
    // the context of the next renderer (React may mount effects twice).
    const cv = document.createElement('canvas');
    cv.className = 'absolute inset-0 h-full w-full';
    const ov = document.createElement('canvas');
    ov.className = 'pointer-events-none absolute inset-0';
    el.append(cv, ov);
    const live = new LiveScene();
    let renderer: Renderer2D | null = null;
    let disposed = false;
    let raf = 0;
    const project0 = useEditor.getState().project!;
    const view = { center: new Vector2(project0.settings.display.width / 2, project0.settings.display.height / 2), zoom: 0.5 };
    let drag: Drag | null = null;
    let spaceDown = false;
    const pointers = new Map<number, Vector2>();
    let pinch: { dist: number; zoom: number; mid: Vector2; center: Vector2 } | null = null;
    /** Tile painting stroke in progress. */
    let stroke: { session: number; erase: boolean; last: Vector2 | null; cells: Map<string, [number, number] | null> } | null = null;
    let lastDraw = 0;

    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(draw);
    };

    const syncScene = () => {
      const s = useEditor.getState();
      const scene = s.project?.scenes[scenePath];
      if (!s.project || !scene) return;
      try {
        live.sync(s.project, scene);
      } catch (e) {
        console.error(e);
      }
      if (renderer) renderer.root = live.root;
      schedule();
    };

    const fit = () => {
      const r = el.getBoundingClientRect();
      const d = useEditor.getState().project!.settings.display;
      view.zoom = Math.max(0.05, Math.min(4, Math.min((r.width - 40) / d.width, (r.height - 40) / d.height)));
      view.center = new Vector2(d.width / 2, d.height / 2);
    };

    void (async () => {
      const d = project0.settings.display;
      const r = await Renderer2D.create({ canvas: cv, assets: { url: assetUrl }, width: d.width, height: d.height, background: d.background, pixelArt: d.pixelArt, showCollisionShapes: useUi.getState().showShapes });
      if (disposed) {
        r.dispose();
        return;
      }
      renderer = r;
      renderer.onAssetLoaded = schedule;
      renderer.editorView = view;
      resize();
      fit();
      syncScene();
    })();

    function resize() {
      const r = el.getBoundingClientRect();
      renderer?.resize(r.width, r.height);
      const dpr = Math.min(devicePixelRatio || 1, 2);
      ov.width = Math.round(r.width * dpr);
      ov.height = Math.round(r.height * dpr);
      ov.style.width = `${r.width}px`;
      ov.style.height = `${r.height}px`;
      schedule();
    }
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    // --- helpers -------------------------------------------------------------------------------------------
    const toWorld = (p: Vector2) => new Transform2D(view.zoom, 0, 0, view.zoom, el.clientWidth / 2 - view.center.x * view.zoom, el.clientHeight / 2 - view.center.y * view.zoom).invert().apply(p);
    const toScreen = (p: Vector2) => new Vector2((p.x - view.center.x) * view.zoom + el.clientWidth / 2, (p.y - view.center.y) * view.zoom + el.clientHeight / 2);
    const local = (e: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect();
      return new Vector2(e.clientX - r.left, e.clientY - r.top);
    };
    const selectedNodes = () => useEditor.getState().selection.map((id) => live.node(id)).filter((n): n is Node2D => n instanceof Node2D);
    const boundsOf = (n: Node2D) => {
      if (n instanceof CollisionShape2D && n.shape) {
        const s = n.shape;
        const [w, h] = s.type === 'rectangle' ? s.size : s.type === 'circle' ? [s.radius * 2, s.radius * 2] : [s.radius * 2, s.height];
        return { x: -w / 2, y: -h / 2, w, h };
      }
      const b = n.getLocalBounds();
      return b && b.width > 0 && b.height > 0 ? { x: b.x, y: b.y, w: b.width, h: b.height } : null;
    };
    /** Topmost node under a screen point (reverse draw order). */
    const pick = (p: Vector2): Node2D | null => {
      const list: Node2D[] = [];
      live.root?.walk((n) => {
        if (n instanceof Node2D && n.isVisibleInTree()) list.push(n);
      });
      // Canvas layers draw above the world, in layer order.
      const layerOf = (n: Node2D) => n.getCanvasLayer()?.layer ?? 0;
      list.sort((a, b) => layerOf(a) - layerOf(b) || a.globalZIndex - b.globalZIndex);
      const world = toWorld(p);
      for (let i = list.length - 1; i >= 0; i--) {
        const n = list[i];
        if (n instanceof CollisionShape2D && !useUi.getState().showShapes) continue;
        const b = boundsOf(n);
        if (b) {
          const lp = canvasXf(n).invert().apply(world);
          if (lp.x >= b.x && lp.x <= b.x + b.w && lp.y >= b.y && lp.y <= b.y + b.h) return n;
        } else if (toScreen(canvasXf(n).origin).distanceTo(p) < 10) return n;
      }
      return null;
    };
    const handleAt = (p: Vector2): Drag['kind'] | null => {
      const sel = selectedNodes();
      if (sel.length !== 1) return null;
      const tool = useUi.getState().tool;
      const o = toScreen(canvasXf(sel[0]).origin);
      const touchPad = matchMedia('(pointer: coarse)').matches ? 10 : 0;
      if (tool === 'move' || tool === 'select') {
        if (Math.abs(p.y - o.y) < HANDLE + touchPad && p.x > o.x + 12 && p.x < o.x + 60 + touchPad) return 'axis-x';
        if (Math.abs(p.x - o.x) < HANDLE + touchPad && p.y < o.y - 12 && p.y > o.y - 60 - touchPad) return 'axis-y';
      }
      if (tool === 'rotate' && Math.abs(p.distanceTo(o) - 46) < 9 + touchPad) return 'rotate';
      return null;
    };

    const commitTransforms = (final: boolean) => {
      if (!drag) return;
      const s = useEditor.getState();
      const ui = useUi.getState();
      const commands = drag.ids.flatMap((id) => {
        const n = live.node(id);
        const st = drag!.starts.get(id);
        if (!(n instanceof Node2D) || !st) return [];
        const parent = n.parent2D ? n.parent2D.globalTransform : Transform2D.identity();
        const props: Record<string, unknown> = {};
        if (drag!.kind === 'move' || drag!.kind === 'axis-x' || drag!.kind === 'axis-y') {
          let delta = toWorld(drag!.last).sub(toWorld(drag!.start));
          if (drag!.kind === 'axis-x') delta = new Vector2(delta.x, 0);
          if (drag!.kind === 'axis-y') delta = new Vector2(0, delta.y);
          // Into the node's canvas (CanvasLayers can be offset and scaled).
          const layer = n.getCanvasLayer();
          if (layer) delta = layer.transform.invert().applyVector(delta);
          let g = st.global.add(delta);
          if (ui.snap) g = new Vector2(Math.round(g.x / ui.gridSize) * ui.gridSize, Math.round(g.y / ui.gridSize) * ui.gridSize);
          // Move by the difference: anchored controls aren't placed by their position directly.
          const l = st.local.add(parent.invert().applyVector(g.sub(st.global)));
          props.position = [round(l.x), round(l.y)];
        } else if (drag!.kind === 'rotate') {
          const o = drag!.pivot;
          const a0 = toWorld(drag!.start).sub(o).angle();
          const a1 = toWorld(drag!.last).sub(o).angle();
          let r = st.rotation + (a1 - a0);
          if (ui.snap) r = Math.round(r / degToRad(15)) * degToRad(15);
          props.rotation = Math.round(r * 1e5) / 1e5;
        } else if (drag!.kind === 'scale') {
          const o = drag!.pivot;
          const d0 = Math.max(4, toWorld(drag!.start).distanceTo(o));
          let k = toWorld(drag!.last).distanceTo(o) / d0;
          if (ui.snap) k = Math.max(0.1, Math.round(k * 10) / 10);
          props.scale = [round(st.scale.x * k), round(st.scale.y * k)];
        }
        return [{ op: 'set_props' as const, scene: scenePath, node: id, props }];
      });
      if (!commands.length) return;
      try {
        s.dispatch(commands, { label: drag.kind === 'rotate' ? 'Rotate' : drag.kind === 'scale' ? 'Scale' : 'Move', mergeKey: `drag2d:${drag.session}` });
      } catch (e) {
        if (final) toast('error', errorMessage(e));
      }
    };

    // --- tile painting ---------------------------------------------------------------------------------------
    let hover: Vector2 | null = null;
    /** The selected TileMapLayer while the paint tool is on. */
    const paintTarget = (): TileMapLayer | null => {
      if (!useTilePaint.getState().painting) return null;
      const sel = selectedTileMap();
      const n = sel ? live.node(sel.node.id) : null;
      return n instanceof TileMapLayer ? n : null;
    };
    const cellAt = (n: TileMapLayer, p: Vector2) => n.localToMap(canvasXf(n).invert().apply(toWorld(p)));
    const paintAt = (n: TileMapLayer, p: Vector2) => {
      if (!stroke) return;
      const cell = cellAt(n, p);
      const path = stroke.last ? cellLine(stroke.last, cell) : [cell];
      stroke.last = cell;
      const atlas = useTilePaint.getState().atlas;
      let changed = false;
      for (const c of path) {
        const want: [number, number] | null = stroke.erase ? null : [atlas[0], atlas[1]];
        const cur = n.getCell(c);
        if ((want === null && cur === null) || (want && cur && cur.x === want[0] && cur.y === want[1])) continue;
        stroke.cells.set(`${c.x},${c.y}`, want);
        changed = true;
      }
      if (!changed) return;
      const sel = selectedTileMap();
      if (!sel) return;
      // Apply the stroke to the stored cells (one undo step per stroke).
      const cells = new Map<string, [number, number]>();
      const stored = (sel.node.props?.cells as number[] | undefined) ?? [];
      for (let i = 0; i + 3 < stored.length; i += 4) cells.set(`${stored[i]},${stored[i + 1]}`, [stored[i + 2], stored[i + 3]]);
      for (const [k, v] of stroke.cells) {
        if (v) cells.set(k, v);
        else cells.delete(k);
      }
      const flat: number[] = [];
      for (const [k, v] of cells) {
        const [x, y] = k.split(',').map(Number);
        flat.push(x, y, v[0], v[1]);
      }
      try {
        useEditor.getState().dispatch([{ op: 'set_props', scene: sel.scenePath, node: sel.node.id, props: { cells: flat } }], { label: stroke.erase ? 'Erase tiles' : 'Paint tiles', mergeKey: `tiles:${stroke.session}` });
      } catch (err) {
        toast('error', errorMessage(err));
        stroke = null;
      }
    };

    // --- pointer handling ----------------------------------------------------------------------------------
    /** Overlay UI inside the viewport (the tile palette) handles its own pointer events. */
    const fromOverlay = (e: Event) => !!(e.target as Element | null)?.closest?.('[data-viewport-ui]');
    const onDown = (e: PointerEvent) => {
      if (fromOverlay(e)) return;
      el.setPointerCapture(e.pointerId);
      const p = local(e);
      pointers.set(e.pointerId, p);
      if (pointers.size === 2) {
        // Second finger: switch to pinch-zoom/pan, cancel any node drag.
        const [a, b] = [...pointers.values()];
        if (drag && drag.kind !== 'pan' && drag.moved) commitTransforms(true);
        drag = null;
        pinch = { dist: a.distanceTo(b), zoom: view.zoom, mid: a.add(b).scale(0.5), center: view.center.clone() };
        return;
      }
      if (pointers.size > 2) return;
      const tiles = paintTarget();
      if (tiles && (e.button === 0 || e.button === 2) && !spaceDown) {
        const tool = useTilePaint.getState();
        stroke = { session: ++sessionSeq, erase: tool.erase || e.button === 2, last: null, cells: new Map() };
        paintAt(tiles, p);
        return;
      }
      const panButton = e.button === 1 || e.button === 2 || spaceDown;
      if (panButton) {
        drag = { kind: 'pan', start: p, last: p, ids: [], starts: new Map(), pivot: new Vector2(), session: ++sessionSeq, moved: false };
        return;
      }
      const tool = useUi.getState().tool;
      const handle = handleAt(p);
      let ids = useEditor.getState().selection;
      if (!handle) {
        const hit = pick(p);
        const id = hit ? live.docId(hit) : null;
        if (id && !ids.includes(id)) {
          ids = e.shiftKey ? [...ids, id] : [id];
          useEditor.getState().select(ids);
        } else if (!id) {
          // Empty space: deselect (mouse) or pan (touch / mouse drag).
          drag = { kind: 'pan', start: p, last: p, ids: [], starts: new Map(), pivot: new Vector2(), session: ++sessionSeq, moved: false };
          return;
        }
      }
      const starts = new Map<string, { global: Vector2; local: Vector2; rotation: number; scale: Vector2 }>();
      for (const id of ids) {
        const n = live.node(id);
        if (n instanceof Node2D && n !== live.root) starts.set(id, { global: n.globalPosition, local: n.position.clone(), rotation: n.rotation, scale: n.scale.clone() });
      }
      if (!starts.size) return;
      const kind: Drag['kind'] = handle ?? (tool === 'rotate' ? 'rotate' : tool === 'scale' ? 'scale' : 'move');
      const first = live.node([...starts.keys()][0]) as Node2D;
      drag = { kind, start: p, last: p, ids: [...starts.keys()], starts, pivot: canvasXf(first).origin, session: ++sessionSeq, moved: false };
    };
    const onMove = (e: PointerEvent) => {
      const p = local(e);
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const zoom = Math.max(0.05, Math.min(16, pinch.zoom * (a.distanceTo(b) / Math.max(1, pinch.dist))));
        const mid = a.add(b).scale(0.5);
        view.zoom = zoom;
        view.center = pinch.center.sub(mid.sub(pinch.mid).scale(1 / zoom));
        schedule();
        return;
      }
      if (stroke) {
        const tiles = paintTarget();
        if (tiles) paintAt(tiles, p);
        return;
      }
      if (!drag) {
        const painting = !!paintTarget();
        el.style.cursor = painting ? 'crosshair' : handleAt(p) ? 'grab' : 'default';
        hover = p;
        if (painting) schedule();
        return;
      }
      if (!drag.moved && drag.start.distanceTo(p) < 3) return;
      drag.moved = true;
      if (drag.kind === 'pan') {
        view.center = view.center.sub(p.sub(drag.last).scale(1 / view.zoom));
        drag.last = p;
        schedule();
        return;
      }
      drag.last = p;
      commitTransforms(false);
    };
    const onUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (stroke) {
        stroke = null;
        return;
      }
      if (!drag) return;
      if (drag.kind === 'pan' && !drag.moved && e.button === 0) useEditor.getState().select([]);
      else if (drag.kind !== 'pan' && drag.moved) commitTransforms(true);
      drag = null;
    };
    const onWheel = (e: WheelEvent) => {
      if (fromOverlay(e)) return;
      e.preventDefault();
      const p = local(e);
      if (e.ctrlKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
        const before = toWorld(p);
        view.zoom = Math.max(0.05, Math.min(16, view.zoom * Math.pow(1.0015, -e.deltaY * (e.ctrlKey ? 4 : 1))));
        const after = toWorld(p);
        view.center = view.center.add(before.sub(after));
      } else view.center = view.center.add(new Vector2(e.deltaX, e.deltaY).scale(1 / view.zoom));
      schedule();
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input,textarea,.cm-editor')) return;
      if (e.code === 'Space') {
        spaceDown = e.type === 'keydown';
        el.style.cursor = spaceDown ? 'grab' : 'default';
      }
      if (e.type === 'keydown' && e.key.toLowerCase() === 'f' && !e.ctrlKey && !e.metaKey) frame();
    };
    const frame = () => {
      const sel = selectedNodes();
      if (sel.length) view.center = canvasXf(sel[0]).origin;
      else fit();
      schedule();
    };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    viewportEvents.addEventListener('frame', frame);

    // --- drawing -----------------------------------------------------------------------------------------------
    function draw() {
      raf = 0;
      if (!renderer) return;
      // Particles preview in the editor (the live scene has no tree, so nothing else advances them).
      const now = performance.now();
      const dt = lastDraw ? Math.min(0.05, (now - lastDraw) / 1000) : 1 / 60;
      lastDraw = now;
      let animating = false;
      live.root?.walk((n) => {
        if (n instanceof CPUParticles2D && n.isVisibleInTree() && (n.emitting || n.getParticleCount() > 0)) {
          n.simulate(dt);
          animating = true;
        }
      });
      if (animating) schedule();
      else lastDraw = 0;
      renderer.showCollisionShapes = useUi.getState().showShapes;
      renderer.editorView = view;
      renderer.render();
      const ctx = ov.getContext('2d')!;
      const dpr = ov.width / Math.max(1, el.clientWidth);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, el.clientWidth, el.clientHeight);
      drawGrid(ctx);
      const project = useEditor.getState().project!;
      const d = project.settings.display;
      // The game's frame (like Godot's blue viewport rectangle).
      const a = toScreen(new Vector2(0, 0));
      const b = toScreen(new Vector2(d.width, d.height));
      ctx.strokeStyle = 'rgba(79,140,255,0.9)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
      live.root?.walk((n) => {
        if (n instanceof Camera2D) {
          const c = n.globalPosition.add(n.offset);
          const hw = d.width / 2 / n.zoom.x;
          const hh = d.height / 2 / n.zoom.y;
          const p1 = toScreen(c.sub(new Vector2(hw, hh)));
          const p2 = toScreen(c.add(new Vector2(hw, hh)));
          ctx.strokeStyle = 'rgba(214,218,227,0.55)';
          ctx.setLineDash([6, 4]);
          ctx.strokeRect(p1.x, p1.y, p2.x - p1.x, p2.y - p1.y);
          ctx.setLineDash([]);
        }
      });
      drawHelpers(ctx);
      const sel = selectedNodes();
      for (const n of sel) drawSelection(ctx, n);
      if (sel.length === 1 && !paintTarget()) drawHandles(ctx, sel[0]);
    }

    /** Editor-only drawings: markers, paths, rays, light radii, notifier rects, control frames, tile grids. */
    function drawHelpers(ctx: CanvasRenderingContext2D) {
      const selected = new Set(useEditor.getState().selection);
      const isSel = (n: Node) => {
        const id = live.docId(n);
        return !!id && selected.has(id) && live.node(id) === n;
      };
      const poly = (t: Transform2D, pts: Vector2[], close: boolean) => {
        ctx.beginPath();
        pts.forEach((q, i) => {
          const s = toScreen(t.apply(q));
          if (i) ctx.lineTo(s.x, s.y);
          else ctx.moveTo(s.x, s.y);
        });
        if (close) ctx.closePath();
        ctx.stroke();
      };
      const circle = (t: Transform2D, r: number) => {
        const c = toScreen(t.origin);
        const k = t.scale;
        ctx.beginPath();
        ctx.arc(c.x, c.y, Math.max(1, r * Math.max(Math.abs(k.x), Math.abs(k.y)) * view.zoom), 0, Math.PI * 2);
        ctx.stroke();
      };
      const rect = (t: Transform2D, x: number, y: number, w: number, h: number) => poly(t, [new Vector2(x, y), new Vector2(x + w, y), new Vector2(x + w, y + h), new Vector2(x, y + h)], true);
      live.root?.walk((n) => {
        if (!(n instanceof Node2D) || !n.isVisibleInTree()) return;
        const t = canvasXf(n);
        const sel = isSel(n);
        ctx.lineWidth = 1.5;
        ctx.setLineDash([]);
        if (n instanceof Marker2D) {
          const e = n.gizmoExtents;
          ctx.strokeStyle = sel ? '#f5a524' : 'rgba(248,113,113,0.95)';
          poly(t, [new Vector2(-e, 0), new Vector2(e, 0)], false);
          ctx.strokeStyle = sel ? '#f5a524' : 'rgba(74,222,128,0.95)';
          poly(t, [new Vector2(0, -e), new Vector2(0, e)], false);
        } else if (n instanceof Path2D) {
          const pts = n.getCurve().points.map((q) => new Vector2(q[0], q[1]));
          ctx.strokeStyle = 'rgba(125,211,252,0.9)';
          ctx.lineWidth = 2;
          poly(t, pts, false);
          ctx.fillStyle = '#7dd3fc';
          for (const q of n.points) {
            const s = toScreen(t.apply(q));
            ctx.fillRect(s.x - 3, s.y - 3, 6, 6);
          }
        } else if (n instanceof RayCast2D) {
          const a = toScreen(t.origin);
          const b = toScreen(t.apply(n.targetPosition));
          ctx.strokeStyle = n.enabled ? 'rgba(251,146,60,0.95)' : 'rgba(139,147,164,0.8)';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          const ang = Math.atan2(b.y - a.y, b.x - a.x);
          ctx.moveTo(b.x, b.y);
          ctx.lineTo(b.x - Math.cos(ang - 0.4) * 9, b.y - Math.sin(ang - 0.4) * 9);
          ctx.moveTo(b.x, b.y);
          ctx.lineTo(b.x - Math.cos(ang + 0.4) * 9, b.y - Math.sin(ang + 0.4) * 9);
          ctx.stroke();
        } else if (n instanceof VisibleOnScreenNotifier2D) {
          ctx.strokeStyle = 'rgba(232,121,249,0.85)';
          const r = n.rect;
          rect(t, r.x, r.y, r.width, r.height);
        } else if (n instanceof PointLight2D && sel) {
          ctx.strokeStyle = 'rgba(253,224,71,0.8)';
          ctx.setLineDash([5, 4]);
          circle(t, n.radius);
        } else if (n instanceof AudioStreamPlayer2D && sel) {
          ctx.strokeStyle = 'rgba(245,196,107,0.7)';
          ctx.setLineDash([5, 4]);
          circle(t, n.maxDistance);
        } else if (n instanceof CPUParticles2D && sel && n.emissionShape !== 'point') {
          ctx.strokeStyle = 'rgba(167,139,250,0.85)';
          ctx.setLineDash([4, 3]);
          if (n.emissionShape === 'sphere') circle(t, n.emissionSphereRadius);
          else rect(t, -n.emissionRectExtents.x, -n.emissionRectExtents.y, n.emissionRectExtents.x * 2, n.emissionRectExtents.y * 2);
        } else if (n instanceof Parallax2D && sel && (n.repeatSize.x > 0 || n.repeatSize.y > 0)) {
          ctx.strokeStyle = 'rgba(141,165,243,0.7)';
          ctx.setLineDash([6, 4]);
          rect(t, 0, 0, n.repeatSize.x || 64, n.repeatSize.y || 64);
        } else if (n instanceof Control) {
          // Frames for controls that draw nothing themselves (containers, plain Controls).
          const s = n.getSize();
          if (sel || n.typeName === 'Control' || /Container$/.test(n.typeName)) {
            ctx.strokeStyle = sel ? 'rgba(142,239,151,0.9)' : 'rgba(142,239,151,0.35)';
            ctx.setLineDash([4, 3]);
            rect(t, 0, 0, s.x, s.y);
          }
        } else if (n instanceof TileMapLayer && sel) {
          drawTileGrid(ctx, n, t);
        }
      });
      ctx.setLineDash([]);
    }

    function drawTileGrid(ctx: CanvasRenderingContext2D, n: TileMapLayer, t: Transform2D) {
      const { x: tw, y: th } = n.tileSize;
      if (tw * view.zoom < 4 || th * view.zoom < 4) return;
      // The visible part of the layer, in cells.
      const inv = t.invert();
      const corners = [new Vector2(0, 0), new Vector2(el.clientWidth, 0), new Vector2(0, el.clientHeight), new Vector2(el.clientWidth, el.clientHeight)].map((c) => inv.apply(toWorld(c)));
      const x0 = Math.floor(Math.min(...corners.map((c) => c.x)) / tw);
      const x1 = Math.ceil(Math.max(...corners.map((c) => c.x)) / tw);
      const y0 = Math.floor(Math.min(...corners.map((c) => c.y)) / th);
      const y1 = Math.ceil(Math.max(...corners.map((c) => c.y)) / th);
      if ((x1 - x0) * (y1 - y0) > 40000) return;
      ctx.strokeStyle = 'rgba(245,165,36,0.18)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = x0; x <= x1; x++) {
        const a = toScreen(t.apply(new Vector2(x * tw, y0 * th)));
        const b = toScreen(t.apply(new Vector2(x * tw, y1 * th)));
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      for (let y = y0; y <= y1; y++) {
        const a = toScreen(t.apply(new Vector2(x0 * tw, y * th)));
        const b = toScreen(t.apply(new Vector2(x1 * tw, y * th)));
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();
      // The cell under the pointer while painting.
      if (hover && paintTarget() === n) {
        const c = cellAt(n, hover);
        const pts = [new Vector2(c.x * tw, c.y * th), new Vector2((c.x + 1) * tw, c.y * th), new Vector2((c.x + 1) * tw, (c.y + 1) * th), new Vector2(c.x * tw, (c.y + 1) * th)].map((q) => toScreen(t.apply(q)));
        ctx.strokeStyle = useTilePaint.getState().erase ? '#f87171' : '#f5a524';
        ctx.lineWidth = 2;
        ctx.beginPath();
        pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
        ctx.closePath();
        ctx.stroke();
      }
    }

    function drawGrid(ctx: CanvasRenderingContext2D) {
      const w = el.clientWidth;
      const h = el.clientHeight;
      let step = useUi.getState().gridSize;
      while (step * view.zoom < 12) step *= 2;
      const tl = toWorld(new Vector2(0, 0));
      const br = toWorld(new Vector2(w, h));
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(255,255,255,0.045)';
      ctx.beginPath();
      for (let x = Math.floor(tl.x / step) * step; x <= br.x; x += step) {
        const sx = Math.round(toScreen(new Vector2(x, 0)).x) + 0.5;
        ctx.moveTo(sx, 0);
        ctx.lineTo(sx, h);
      }
      for (let y = Math.floor(tl.y / step) * step; y <= br.y; y += step) {
        const sy = Math.round(toScreen(new Vector2(0, y)).y) + 0.5;
        ctx.moveTo(0, sy);
        ctx.lineTo(w, sy);
      }
      ctx.stroke();
      const o = toScreen(new Vector2(0, 0));
      ctx.strokeStyle = 'rgba(248,113,113,0.5)';
      ctx.beginPath();
      ctx.moveTo(0, Math.round(o.y) + 0.5);
      ctx.lineTo(w, Math.round(o.y) + 0.5);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(74,222,128,0.5)';
      ctx.beginPath();
      ctx.moveTo(Math.round(o.x) + 0.5, 0);
      ctx.lineTo(Math.round(o.x) + 0.5, h);
      ctx.stroke();
    }

    function drawSelection(ctx: CanvasRenderingContext2D, n: Node2D) {
      const b = boundsOf(n);
      ctx.strokeStyle = '#f5a524';
      ctx.lineWidth = 1.5;
      if (b) {
        const t = canvasXf(n);
        const corners = [new Vector2(b.x, b.y), new Vector2(b.x + b.w, b.y), new Vector2(b.x + b.w, b.y + b.h), new Vector2(b.x, b.y + b.h)].map((c) => toScreen(t.apply(c)));
        ctx.beginPath();
        corners.forEach((c, i) => (i ? ctx.lineTo(c.x, c.y) : ctx.moveTo(c.x, c.y)));
        ctx.closePath();
        ctx.stroke();
      }
      const o = toScreen(canvasXf(n).origin);
      ctx.beginPath();
      ctx.arc(o.x, o.y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = '#f5a524';
      ctx.fill();
    }

    function drawHandles(ctx: CanvasRenderingContext2D, n: Node2D) {
      const tool = useUi.getState().tool;
      const o = toScreen(canvasXf(n).origin);
      ctx.lineWidth = 2.5;
      if (tool === 'move' || tool === 'select') {
        ctx.strokeStyle = '#f87171';
        ctx.fillStyle = '#f87171';
        ctx.beginPath();
        ctx.moveTo(o.x + 12, o.y);
        ctx.lineTo(o.x + 54, o.y);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(o.x + 62, o.y);
        ctx.lineTo(o.x + 52, o.y - 5);
        ctx.lineTo(o.x + 52, o.y + 5);
        ctx.fill();
        ctx.strokeStyle = '#4ade80';
        ctx.fillStyle = '#4ade80';
        ctx.beginPath();
        ctx.moveTo(o.x, o.y - 12);
        ctx.lineTo(o.x, o.y - 54);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(o.x, o.y - 62);
        ctx.lineTo(o.x - 5, o.y - 52);
        ctx.lineTo(o.x + 5, o.y - 52);
        ctx.fill();
      } else if (tool === 'rotate') {
        ctx.strokeStyle = '#60a5fa';
        ctx.beginPath();
        ctx.arc(o.x, o.y, 46, 0, Math.PI * 2);
        ctx.stroke();
        const a = canvasXf(n).rotation;
        ctx.beginPath();
        ctx.moveTo(o.x, o.y);
        ctx.lineTo(o.x + Math.cos(a) * 46, o.y + Math.sin(a) * 46);
        ctx.stroke();
      } else if (tool === 'scale') {
        ctx.strokeStyle = '#fbbf24';
        ctx.strokeRect(o.x - 30, o.y - 30, 60, 60);
        ctx.fillStyle = '#fbbf24';
        for (const [dx, dy] of [
          [-30, -30],
          [30, -30],
          [30, 30],
          [-30, 30],
        ])
          ctx.fillRect(o.x + dx - 4, o.y + dy - 4, 8, 8);
      }
    }

    // React to document, selection and UI changes without re-rendering React.
    const unsubEditor = useEditor.subscribe((s, prev) => {
      if (s.project !== prev.project) syncScene();
      else if (s.selection !== prev.selection) schedule();
    });
    const unsubUi = useUi.subscribe(schedule);
    const unsubPaint = useTilePaint.subscribe(schedule);
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      unsubEditor();
      unsubUi();
      unsubPaint();
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      viewportEvents.removeEventListener('frame', frame);
      renderer?.dispose();
      cv.remove();
      ov.remove();
    };
  }, [scenePath]);

  return (
    <div ref={host} className="absolute inset-0 touch-none select-none overflow-hidden" data-testid="viewport-2d">
      <TilePalette />
    </div>
  );
}
