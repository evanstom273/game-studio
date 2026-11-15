/**
 * 2D renderer on PixiJS v8 (WebGL, WebGPU when available).
 *
 * Pixi is used purely as a drawing backend: the engine's node tree stays the source of truth.
 * Each frame the renderer walks the tree, creates/updates display objects per visual node
 * (mark & sweep, so it needs no tree events), places them with the node's global transform from
 * the core, and sorts by z index then tree order.
 *
 * Canvases: the game world (moved by the camera) and one container per CanvasLayer (screen space,
 * ordered by layer; negative layers go behind the world). A Parallax2D that repeats draws its
 * subtree several times, so visuals are kept per node *and* per copy. 2D lighting renders the
 * CanvasModulate colour plus additive PointLight2D sprites into a light map that multiplies the
 * world.
 *
 * The same renderer serves the running game (camera + stretch mode) and the editor viewport
 * (an explicit view, plus collision-shape outlines).
 */
// Pixi normally compiles shaders and uniform uploads with eval; this add-on swaps in
// eval-free versions so the editor and games work under a strict Content-Security-Policy.
import 'pixi.js/unsafe-eval';
import { Container, Graphics, ImageSource, Matrix, Rectangle, RenderTexture, Sprite, Text, Texture, autoDetectRenderer, type Renderer } from 'pixi.js';
import { Color, Transform2D, Vector2 } from '@gs/shared';
import {
  AnimatedSprite2D,
  CPUParticles2D,
  CanvasLayer,
  CanvasModulate,
  CollisionShape2D,
  Control,
  Label2D,
  Line2D,
  Node2D,
  Parallax2D,
  PointLight2D,
  Polygon2D,
  Sprite2D,
  TileMapLayer,
  tileFallbackColor,
  type Node,
  type RenderServer,
  type SceneTree,
} from '@gs/core';
import { FONT_FAMILY, createControlVisual, isDrawnControl, subTexture, updateControl } from './ui';

export type StretchMode = 'fit' | 'expand' | 'stretch' | 'none';

export interface AssetUrls {
  /** URL (blob:, data: or relative) of a project asset, or null if missing. */
  url(path: string): string | null;
}

export interface Renderer2DOptions {
  canvas: HTMLCanvasElement;
  assets: AssetUrls;
  /** The project's display size. */
  width: number;
  height: number;
  stretch?: StretchMode;
  background?: string;
  pixelArt?: boolean;
  /** Transparent canvas (when drawn over the 3D view). */
  transparent?: boolean;
  /** Draw collision shapes (editor, debug). */
  showCollisionShapes?: boolean;
}

/** Explicit view for the editor: world point at the canvas centre, and zoom. */
export interface EditorView {
  center: Vector2;
  zoom: number;
}

interface Visual {
  obj: Container;
  key: string;
  seen: number;
}

/** Where a subtree draws: the world or a CanvasLayer. */
interface Canvas {
  container: Container;
  /** Canvas coordinates → canvas CSS pixels. */
  transform: Transform2D;
  world: boolean;
}

type TexEntry = { state: 'loading' } | { state: 'ready'; source: ImageSource; texture: Texture; frames: Map<string, Texture | null> } | { state: 'error' };

const MAX_PARALLAX_COPIES = 64;
const NO_COPIES = [new Vector2()];

export class Renderer2D implements RenderServer {
  readonly stage = new Container();
  /** World and canvas layers (masked to the game frame in "fit" mode). */
  private readonly canvasRoot = new Container();
  private readonly world = new Container();
  private readonly background = new Graphics();
  private readonly frameMask = new Graphics();
  private visuals = new Map<Node, Visual[]>();
  private layers = new Map<CanvasLayer, { container: Container; seen: number }>();
  private textures = new Map<string, TexEntry>();
  private frame = 0;
  private matrix = new Matrix();
  // Lighting.
  private readonly lightSprite = new Sprite();
  private readonly glow = new Container();
  private lightLayer: Container | null = null;
  private lightTarget: RenderTexture | null = null;
  private lightTexture: Texture | null = null;
  private dotTexture: Texture | null = null;
  private modulate: CanvasModulate | null = null;
  private lights: { light: PointLight2D; transform: Transform2D }[] = [];
  /** Root to draw (the tree root for games, the edited scene for the editor). */
  root: Node | null = null;
  tree: SceneTree | null = null;
  editorView: EditorView | null = null;
  showCollisionShapes: boolean;
  /** Called when the picture changed asynchronously (a texture loaded, text was measured): the editor redraws on demand. */
  onAssetLoaded: (() => void) | null = null;
  private cssWidth = 1;
  private cssHeight = 1;
  /** world → canvas CSS pixels, from the last render */
  viewTransform = Transform2D.identity();
  /** game viewport → canvas CSS pixels (stretch), from the last render */
  stretchTransform = Transform2D.identity();

  private constructor(
    readonly renderer: Renderer,
    private opts: Renderer2DOptions,
  ) {
    this.showCollisionShapes = !!opts.showCollisionShapes;
    this.world.sortableChildren = true;
    this.canvasRoot.sortableChildren = true;
    this.world.zIndex = 0;
    this.lightSprite.zIndex = 1;
    this.lightSprite.blendMode = 'multiply';
    this.lightSprite.visible = false;
    this.glow.zIndex = 1;
    this.canvasRoot.addChild(this.world, this.lightSprite, this.glow);
    this.stage.addChild(this.background, this.canvasRoot);
  }

  static async create(opts: Renderer2DOptions) {
    const renderer = await autoDetectRenderer({
      canvas: opts.canvas,
      width: Math.max(1, opts.canvas.clientWidth || opts.width),
      height: Math.max(1, opts.canvas.clientHeight || opts.height),
      resolution: Math.min(globalThis.devicePixelRatio || 1, 2),
      autoDensity: true,
      antialias: !opts.pixelArt,
      backgroundAlpha: opts.transparent ? 0 : 1,
      background: opts.transparent ? 0x000000 : 0x000000,
      preference: 'webgl',
    });
    return new Renderer2D(renderer, opts);
  }

  setOptions(patch: Partial<Pick<Renderer2DOptions, 'width' | 'height' | 'stretch' | 'background' | 'pixelArt'>>) {
    this.opts = { ...this.opts, ...patch };
  }

  /** Canvas size in CSS pixels (call when the element resizes). */
  resize(width: number, height: number) {
    this.cssWidth = Math.max(1, Math.floor(width));
    this.cssHeight = Math.max(1, Math.floor(height));
    this.renderer.resize(this.cssWidth, this.cssHeight);
  }

  get size() {
    return new Vector2(this.cssWidth, this.cssHeight);
  }

  /** Canvas CSS pixel → game viewport pixel (for input). */
  canvasToViewport(p: { x: number; y: number }) {
    return this.stretchTransform.invert().apply(p);
  }
  /** Canvas CSS pixel → world (through camera or editor view). */
  canvasToWorld(p: { x: number; y: number }) {
    return this.viewTransform.invert().apply(p);
  }
  worldToCanvas(p: { x: number; y: number }) {
    return this.viewTransform.apply(p);
  }

  private computeTransforms() {
    const { width: W, height: H } = this.opts;
    const cw = this.cssWidth;
    const ch = this.cssHeight;
    if (this.editorView) {
      const { center, zoom } = this.editorView;
      this.stretchTransform = Transform2D.identity();
      this.viewTransform = new Transform2D(zoom, 0, 0, zoom, cw / 2 - center.x * zoom, ch / 2 - center.y * zoom);
      // Controls with no running game anchor to the project's display size.
      if (!this.tree) Control.editorViewportSize = new Vector2(W, H);
      return { viewport: new Vector2(cw, ch), clip: null as Rect | null };
    }
    const stretch = this.opts.stretch ?? 'fit';
    let sx = 1;
    let sy = 1;
    let vw = W;
    let vh = H;
    if (stretch === 'stretch') {
      sx = cw / W;
      sy = ch / H;
    } else if (stretch === 'fit' || stretch === 'expand') {
      sx = sy = Math.min(cw / W, ch / H);
      if (stretch === 'expand') {
        vw = cw / sx;
        vh = ch / sy;
      }
    } else {
      vw = cw;
      vh = ch;
    }
    const ox = (cw - vw * sx) / 2;
    const oy = (ch - vh * sy) / 2;
    this.stretchTransform = new Transform2D(sx, 0, 0, sy, ox, oy);
    // Camera: world → game viewport.
    const cam = this.tree?.currentCamera2D;
    let view = Transform2D.identity();
    if (cam && cam.isInsideTree() && cam.enabled) {
      const c = cam.getScreenCenterPosition();
      view = new Transform2D(cam.zoom.x, 0, 0, cam.zoom.y, vw / 2 - c.x * cam.zoom.x, vh / 2 - c.y * cam.zoom.y);
    } else if (stretch === 'expand') {
      // No camera: keep the design area centred, extra space shows more world around it.
      view = new Transform2D(1, 0, 0, 1, (vw - W) / 2, (vh - H) / 2);
    }
    if (this.tree) {
      this.tree.canvasTransform = view;
      this.tree.viewportSize = new Vector2(vw, vh);
    }
    this.viewTransform = this.stretchTransform.multiply(view);
    return { viewport: new Vector2(vw, vh), clip: stretch === 'fit' ? { x: ox, y: oy, w: vw * sx, h: vh * sy } : null };
  }

  render() {
    const { clip } = this.computeTransforms();
    const bg = Color.fromHex(this.opts.background ?? '#1e2230');
    this.background.clear();
    if (!this.opts.transparent) {
      if (clip) this.background.rect(0, 0, this.cssWidth, this.cssHeight).fill({ color: 0x000000 });
      const r = clip ?? { x: 0, y: 0, w: this.cssWidth, h: this.cssHeight };
      this.background.rect(r.x, r.y, r.w, r.h).fill({ color: bg.toNumber() });
    }
    if (clip) {
      this.frameMask.clear().rect(clip.x, clip.y, clip.w, clip.h).fill({ color: 0xffffff });
      if (this.canvasRoot.mask !== this.frameMask) {
        this.stage.addChild(this.frameMask);
        this.canvasRoot.mask = this.frameMask;
      }
    } else if (this.canvasRoot.mask) {
      this.canvasRoot.mask = null;
      this.stage.removeChild(this.frameMask);
    }

    this.frame++;
    this.modulate = null;
    this.lights = [];
    let order = 0;
    const worldCanvas: Canvas = { container: this.world, transform: this.viewTransform, world: true };
    const visit = (n: Node, visible: boolean, tint: Color, canvas: Canvas, copies: Vector2[]) => {
      let childVisible = visible;
      let childTint = tint;
      let childCanvas = canvas;
      let childCopies = copies;
      if (n instanceof CanvasLayer) {
        childVisible = visible && n.visible;
        childTint = Color.WHITE;
        childCanvas = this.layerCanvas(n);
        childCopies = NO_COPIES;
      } else if (n instanceof Node2D) {
        childVisible = visible && n.visible;
        childTint = multiply(tint, n.modulate);
        if (n instanceof Parallax2D && copies === NO_COPIES && (n.repeatSize.x > 0 || n.repeatSize.y > 0)) childCopies = this.parallaxCopies(n, canvas);
        if (childVisible) {
          for (let k = 0; k < copies.length; k++) this.updateVisual(n, childTint, order, canvas, copies[k], k);
          if (canvas.world && n instanceof CanvasModulate && !this.modulate) this.modulate = n;
          if (canvas.world && n instanceof PointLight2D && n.enabled && n.energy > 0) this.lights.push({ light: n, transform: canvas.transform.multiply(n.globalTransform) });
        }
        order++;
      }
      for (const c of n.children) visit(c, childVisible, childTint, childCanvas, childCopies);
    };
    if (this.root) visit(this.root, true, Color.WHITE, worldCanvas, NO_COPIES);
    for (const [node, list] of this.visuals) {
      for (let k = list.length - 1; k >= 0; k--) {
        const v = list[k];
        if (v && v.seen !== this.frame) {
          v.obj.destroy({ children: true });
          list.splice(k, 1);
        }
      }
      if (!list.length) this.visuals.delete(node);
    }
    for (const [layer, entry] of this.layers) {
      if (entry.seen === this.frame) continue;
      entry.container.destroy({ children: true });
      this.layers.delete(layer);
    }
    this.updateLighting();
    this.renderer.render(this.stage);
  }

  /** The container (and transform) for a CanvasLayer's subtree. */
  private layerCanvas(layer: CanvasLayer): Canvas {
    let entry = this.layers.get(layer);
    if (!entry) {
      const container = new Container();
      container.sortableChildren = true;
      this.canvasRoot.addChild(container);
      this.layers.set(layer, (entry = { container, seen: 0 }));
    }
    entry.seen = this.frame;
    // Layer 0 shares the world's slot but draws after it (and its lights); negative layers go behind.
    entry.container.zIndex = layer.layer < 0 ? layer.layer * 10 : layer.layer * 10 + 5;
    // In the editor layers sit at the world origin, inside the game frame.
    const base = this.editorView ? this.viewTransform : this.stretchTransform;
    return { container: entry.container, transform: base.multiply(layer.transform), world: false };
  }

  /** Offsets at which a repeating Parallax2D draws its children so they cover the view. */
  private parallaxCopies(n: Parallax2D, canvas: Canvas): Vector2[] {
    const inv = canvas.transform.invert();
    const corners = [inv.apply({ x: 0, y: 0 }), inv.apply({ x: this.cssWidth, y: 0 }), inv.apply({ x: 0, y: this.cssHeight }), inv.apply({ x: this.cssWidth, y: this.cssHeight })];
    const w = Math.max(...corners.map((c) => c.x)) - Math.min(...corners.map((c) => c.x));
    const h = Math.max(...corners.map((c) => c.y)) - Math.min(...corners.map((c) => c.y));
    const r = n.repeatSize;
    const nx = r.x > 0 ? Math.ceil(w / r.x) + 1 : 0;
    const ny = r.y > 0 ? Math.ceil(h / r.y) + 1 : 0;
    const out: Vector2[] = [];
    for (let j = ny > 0 ? -1 : 0; j <= ny; j++) for (let i = nx > 0 ? -1 : 0; i <= nx; i++) if (out.length < MAX_PARALLAX_COPIES) out.push(new Vector2(i * r.x, j * r.y));
    return out;
  }

  private createVisual(n: Node2D): Visual | null {
    const make = (obj: Container): Visual => ({ obj, key: '', seen: 0 });
    if (n instanceof Sprite2D) return make(new Sprite());
    if (n instanceof Polygon2D || n instanceof Line2D) return make(new Graphics());
    if (n instanceof Label2D) return make(new Text({ text: '' }));
    if (n instanceof CPUParticles2D || n instanceof TileMapLayer) return make(new Container());
    if (n instanceof Control && isDrawnControl(n)) return make(createControlVisual());
    if (n instanceof CollisionShape2D && this.showCollisionShapes) return make(new Graphics());
    return null;
  }

  private updateVisual(n: Node2D, tint: Color, order: number, canvas: Canvas, offset: Vector2, copy: number) {
    let list = this.visuals.get(n);
    let v = list?.[copy];
    if (!v) {
      const made = this.createVisual(n);
      if (!made) return;
      v = made;
      if (!list) this.visuals.set(n, (list = []));
      list[copy] = v;
    }
    const obj = v.obj;
    if (obj.parent !== canvas.container) canvas.container.addChild(obj);
    v.seen = this.frame;
    obj.zIndex = n.globalZIndex * 100000 + order;
    obj.tint = tint.toNumber();
    obj.alpha = tint.a;
    const base = offset.x || offset.y ? canvas.transform.multiply(new Transform2D(1, 0, 0, 1, offset.x, offset.y)) : canvas.transform;
    let t = base.multiply(n.globalTransform);

    if (n instanceof Sprite2D) {
      const sprite = obj as Sprite;
      const tex = this.frameTexture(n);
      sprite.visible = !!tex;
      if (tex) {
        if (sprite.texture !== tex) sprite.texture = tex;
        const ax = n.centered ? 0.5 : n.flipH ? 1 : 0;
        const ay = n.centered ? 0.5 : n.flipV ? 1 : 0;
        sprite.anchor.set(ax, ay);
        t = t.multiply(new Transform2D(n.flipH ? -1 : 1, 0, 0, n.flipV ? -1 : 1, n.offset.x, n.offset.y));
      }
    } else if (n instanceof Polygon2D) {
      const key = JSON.stringify([n.polygon.map((p) => [p.x, p.y]), n.color.toHex(true)]);
      if (key !== v.key) {
        v.key = key;
        const g = obj as Graphics;
        g.clear();
        if (n.polygon.length >= 3) g.poly(n.polygon.flatMap((p) => [p.x, p.y])).fill({ color: n.color.toNumber(), alpha: n.color.a });
      }
    } else if (n instanceof Line2D) {
      this.drawLine(v, n);
    } else if (n instanceof Label2D) {
      const key = JSON.stringify([n.text, n.fontSize, n.color.toHex(true), n.horizontalAlignment, n.outlineSize, n.outlineColor.toHex(true)]);
      const text = obj as Text;
      if (key !== v.key) {
        v.key = key;
        text.text = n.text;
        text.style = {
          fontFamily: FONT_FAMILY,
          fontSize: n.fontSize,
          fill: n.color.toNumber(),
          align: n.horizontalAlignment,
          ...(n.outlineSize > 0 ? { stroke: { color: n.outlineColor.toNumber(), width: n.outlineSize } } : {}),
        };
      }
      text.alpha = n.color.a * tint.a;
      text.anchor.set(n.horizontalAlignment === 'center' ? 0.5 : n.horizontalAlignment === 'right' ? 1 : 0, 0);
    } else if (n instanceof CPUParticles2D) {
      this.drawParticles(v, n);
      // Particles live in canvas coordinates unless they move with the emitter.
      if (!n.localCoords) t = base;
    } else if (n instanceof TileMapLayer) {
      this.drawTiles(v, n);
    } else if (n instanceof Control) {
      updateControl(v, n, { texture: (p) => this.plainTexture(p), measured: () => this.onAssetLoaded?.() });
    } else if (n instanceof CollisionShape2D) {
      const key = JSON.stringify([n.shape, n.disabled]);
      if (key !== v.key) {
        v.key = key;
        const g = obj as Graphics;
        g.clear();
        const color = n.disabled ? 0x8b93a4 : 0x38bdf8;
        const s = n.shape;
        if (s?.type === 'rectangle') g.rect(-s.size[0] / 2, -s.size[1] / 2, s.size[0], s.size[1]);
        else if (s?.type === 'circle') g.circle(0, 0, s.radius);
        else if (s?.type === 'capsule') g.roundRect(-s.radius, -s.height / 2, s.radius * 2, s.height, s.radius);
        if (s) g.fill({ color, alpha: 0.18 }).stroke({ color, width: 1.5, alpha: 0.9, pixelLine: true });
      }
      obj.tint = 0xffffff;
      obj.alpha = 1;
    }
    this.matrix.set(t.a, t.b, t.c, t.d, t.tx, t.ty);
    obj.setFromMatrix(this.matrix);
  }

  private drawLine(v: Visual, n: Line2D) {
    const key = JSON.stringify([n.points.map((p) => [p.x, p.y]), n.width, n.defaultColor.toHex(true), n.closed, n.jointMode, n.capMode]);
    if (key === v.key) return;
    v.key = key;
    const g = v.obj as Graphics;
    g.clear();
    if (n.points.length < 2 || n.width <= 0) return;
    const pts = n.points.flatMap((p) => [p.x, p.y]);
    const join = n.jointMode === 'round' ? 'round' : n.jointMode === 'bevel' ? 'bevel' : 'miter';
    const cap = n.capMode === 'round' ? 'round' : n.capMode === 'box' ? 'square' : 'butt';
    if (n.closed && n.points.length > 2) g.poly(pts, true);
    else {
      g.moveTo(pts[0], pts[1]);
      for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
    }
    g.stroke({ width: n.width, color: n.defaultColor.toNumber(), alpha: n.defaultColor.a, join, cap, miterLimit: 4 });
  }

  private drawParticles(v: Visual, n: CPUParticles2D) {
    const c = v.obj;
    const sim = n.sim;
    const path = n.texture?.resourcePath ?? null;
    const tex = path ? this.plainTexture(path) : this.dot();
    if (!tex) {
      c.visible = false;
      return;
    }
    c.visible = true;
    // A dot is 8 px at scale 1; textures draw at their own size.
    const base = path ? 1 : 0.5;
    while (c.children.length < sim.count) {
      const s = new Sprite(tex);
      s.anchor.set(0.5);
      c.addChild(s);
    }
    while (c.children.length > sim.count) c.removeChildAt(c.children.length - 1).destroy();
    for (let i = 0; i < sim.count; i++) {
      const s = c.children[i] as Sprite;
      if (!sim.alive[i]) {
        s.visible = false;
        continue;
      }
      s.visible = true;
      if (s.texture !== tex) s.texture = tex;
      s.position.set(sim.pos[i * 2], sim.pos[i * 2 + 1]);
      s.scale.set(sim.scale[i] * base);
      s.rotation = path ? sim.angle[i] : 0;
      const col = n.color.lerp(n.colorEnd, sim.ageRatio(i));
      s.tint = col.toNumber();
      s.alpha = col.a;
    }
  }

  private drawTiles(v: Visual, n: TileMapLayer) {
    const path = n.tileSet?.resourcePath ?? null;
    const entry = path ? (this.textures.get(path) ?? this.load(path)) : null;
    const key = `${n.__version}|${n.tileSize.x}x${n.tileSize.y}|${path}|${entry?.state ?? 'none'}|${this.showCollisionShapes}|${n.collisionEnabled}|${n.solidTiles.length}`;
    if (key === v.key) return;
    v.key = key;
    const c = v.obj;
    for (const old of c.removeChildren()) old.destroy();
    const { x: tw, y: th } = n.tileSize;
    if (entry?.state === 'loading') return;
    if (entry?.state === 'ready') {
      const missing = new Graphics();
      n.forEachCell((x, y, ax, ay) => {
        const fk = `tile:${tw}x${th}:${ax},${ay}`;
        let frame = entry.frames.get(fk);
        if (frame === undefined) entry.frames.set(fk, (frame = subTexture(entry.texture, ax * tw, ay * th, tw, th)));
        if (!frame) {
          // Atlas coordinates outside the texture: show them instead of hiding the tile.
          missing.rect(x * tw, y * th, tw, th).fill({ color: 0xff00ff, alpha: 0.6 });
          return;
        }
        const s = new Sprite(frame);
        s.position.set(x * tw, y * th);
        c.addChild(s);
      });
      c.addChild(missing);
    } else {
      // No tile set: coloured squares by atlas coordinate (prototyping).
      const g = new Graphics();
      n.forEachCell((x, y, ax, ay) => {
        g.rect(x * tw, y * th, tw, th).fill({ color: tileFallbackColor(ax, ay).toNumber() });
        g.rect(x * tw + 0.5, y * th + 0.5, tw - 1, th - 1).stroke({ color: 0x000000, alpha: 0.18, width: 1 });
      });
      c.addChild(g);
    }
    if (this.showCollisionShapes && n.collisionEnabled) {
      const g = new Graphics();
      for (const r of n.getCollisionRects()) g.rect(r.x, r.y, r.width, r.height).fill({ color: 0x38bdf8, alpha: 0.14 }).stroke({ color: 0x38bdf8, width: 1.5, alpha: 0.9, pixelLine: true });
      c.addChild(g);
    }
  }

  // --- lighting ---------------------------------------------------------------------------------------------------

  /**
   * CanvasModulate + PointLight2D. The light map starts as the modulate colour, lights add to it,
   * and it multiplies the world. Without a CanvasModulate there is nothing to multiply, so lights
   * are added on top as a soft glow instead.
   */
  private updateLighting() {
    const ambient = this.modulate?.color ?? null;
    const darkens = !!ambient && !(ambient.r >= 1 && ambient.g >= 1 && ambient.b >= 1);
    this.lightSprite.visible = false;
    // A transparent canvas sits over the 3D view: an opaque light map would hide it.
    if (darkens && !this.opts.transparent) {
      const res = this.renderer.resolution;
      if (!this.lightTarget) this.lightTarget = RenderTexture.create({ width: this.cssWidth, height: this.cssHeight, resolution: res });
      else if (this.lightTarget.width !== this.cssWidth || this.lightTarget.height !== this.cssHeight) this.lightTarget.resize(this.cssWidth, this.cssHeight, res);
      if (!this.lightLayer) {
        this.lightLayer = new Container();
        this.lightLayer.addChild(new Graphics(), new Container());
      }
      const [ambientRect, lights] = this.lightLayer.children as [Graphics, Container];
      ambientRect.clear().rect(0, 0, this.cssWidth, this.cssHeight).fill({ color: ambient!.toNumber() });
      this.placeLights(lights, 1);
      this.placeLights(this.glow, 0);
      this.renderer.render({ container: this.lightLayer, target: this.lightTarget, clear: true });
      this.lightSprite.texture = this.lightTarget;
      this.lightSprite.position.set(0, 0);
      this.lightSprite.visible = true;
    } else this.placeLights(this.glow, 0.35);
  }

  /** Fills `into` with additive light sprites (reused between frames; several per light when energy > 1). */
  private placeLights(into: Container, strength: number) {
    let used = 0;
    for (const { light, transform } of strength > 0 ? this.lights : []) {
      const path = light.texture?.resourcePath ?? null;
      const tex = (path ? this.plainTexture(path) : null) ?? this.softLight();
      // The texture is scaled so its larger side spans the light's diameter.
      const k = (light.radius * 2) / Math.max(1, tex.width, tex.height);
      const m = transform.multiply(new Transform2D(k, 0, 0, k, 0, 0));
      this.matrix.set(m.a, m.b, m.c, m.d, m.tx, m.ty);
      for (let energy = light.energy * strength, n = 0; energy > 0.001 && n < 4; energy -= 1, n++) {
        let s = into.children[used] as Sprite | undefined;
        if (!s) {
          s = new Sprite(tex);
          s.anchor.set(0.5);
          s.blendMode = 'add';
          into.addChild(s);
        }
        used++;
        if (s.texture !== tex) s.texture = tex;
        s.visible = true;
        s.tint = light.color.toNumber();
        s.alpha = Math.min(1, energy) * light.color.a;
        s.setFromMatrix(this.matrix);
      }
    }
    for (let i = used; i < into.children.length; i++) into.children[i].visible = false;
  }

  /** A soft radial gradient (the default light shape). */
  private softLight(): Texture {
    if (this.lightTexture) return this.lightTexture;
    const size = 256;
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const ctx = cv.getContext('2d')!;
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    for (let i = 0; i <= 8; i++) {
      const d = i / 8;
      g.addColorStop(d, `rgba(255,255,255,${Math.pow(1 - d, 2).toFixed(4)})`);
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    return (this.lightTexture = Texture.from(cv));
  }

  /** The default particle: a soft white dot (16 px texture, drawn at 8 px). */
  private dot(): Texture {
    if (this.dotTexture) return this.dotTexture;
    const cv = document.createElement('canvas');
    cv.width = cv.height = 16;
    const ctx = cv.getContext('2d')!;
    const g = ctx.createRadialGradient(8, 8, 0, 8, 8, 8);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.9)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 16, 16);
    return (this.dotTexture = Texture.from(cv));
  }

  // --- textures ------------------------------------------------------------------------------------------------------

  /** The whole texture of a project image (null while loading or missing). */
  private plainTexture(path: string): Texture | null {
    const entry = this.textures.get(path) ?? this.load(path);
    return entry.state === 'ready' ? entry.texture : null;
  }

  /** The texture for a sprite's current frame (null while loading or missing). */
  private frameTexture(n: Sprite2D): Texture | null {
    const path = n.texture?.resourcePath;
    if (!path) return null;
    const entry = this.textures.get(path) ?? this.load(path);
    if (entry.state !== 'ready') return null;
    const h = Math.max(1, n.hframes);
    const vf = Math.max(1, n.vframes);
    const total = n instanceof AnimatedSprite2D ? n.totalFrames : h * vf;
    const f = Math.max(0, Math.min(total - 1, n.frame));
    if (h === 1 && vf === 1) return entry.texture;
    const key = `${h}x${vf}:${f}`;
    let tex = entry.frames.get(key);
    if (!tex) {
      const fw = entry.source.width / h;
      const fh = entry.source.height / vf;
      tex = new Texture({ source: entry.source, frame: new Rectangle((f % h) * fw, Math.floor(f / h) * fh, fw, fh) });
      entry.frames.set(key, tex);
    }
    return tex;
  }

  private load(path: string): TexEntry {
    const entry: TexEntry = { state: 'loading' };
    this.textures.set(path, entry);
    const url = this.opts.assets.url(path);
    if (!url) {
      this.textures.set(path, { state: 'error' });
      return { state: 'error' };
    }
    void (async () => {
      try {
        const res = await fetch(url);
        const bitmap = await createImageBitmap(await res.blob());
        const source = new ImageSource({ resource: bitmap, scaleMode: this.opts.pixelArt ? 'nearest' : 'linear' });
        this.textures.set(path, { state: 'ready', source, texture: new Texture({ source }), frames: new Map() });
      } catch {
        this.textures.set(path, { state: 'error' });
      }
      this.onAssetLoaded?.();
    })();
    return entry;
  }

  /** Forget a texture (its file changed). */
  invalidateTexture(path: string) {
    const e = this.textures.get(path);
    if (e?.state === 'ready') {
      for (const t of e.frames.values()) t?.destroy();
      e.texture.destroy();
      e.source.destroy();
    }
    this.textures.delete(path);
    for (const list of this.visuals.values()) {
      for (const v of list) {
        if (v.obj instanceof Sprite) v.obj.texture = Texture.EMPTY;
        // Anything else keyed on the texture rebuilds.
        v.key = '';
      }
    }
  }

  /** Texture size if loaded (editor picking for sprites whose asset has no recorded size). */
  textureSize(path: string): Vector2 | null {
    const e = this.textures.get(path);
    return e?.state === 'ready' ? new Vector2(e.source.width, e.source.height) : null;
  }

  dispose() {
    for (const list of this.visuals.values()) for (const v of list) v.obj.destroy({ children: true });
    this.visuals.clear();
    for (const e of this.textures.values()) if (e.state === 'ready') e.source.destroy();
    this.textures.clear();
    this.lightTarget?.destroy(true);
    this.lightLayer?.destroy({ children: true });
    this.lightTexture?.destroy(true);
    this.dotTexture?.destroy(true);
    this.stage.destroy({ children: true });
    this.renderer.destroy();
  }
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function multiply(a: Color, b: Color) {
  return new Color(a.r * b.r, a.g * b.g, a.b * b.b, a.a * b.a);
}
