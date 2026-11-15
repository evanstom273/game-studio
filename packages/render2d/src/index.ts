/**
 * 2D renderer on PixiJS v8 (WebGL, WebGPU when available).
 *
 * Pixi is used purely as a drawing backend: the engine's node tree stays the source of truth.
 * Each frame the renderer walks the tree, creates/updates one display object per visual node
 * (mark & sweep, so it needs no tree events), places it with the node's global transform from
 * the core, and sorts by z index then tree order.
 *
 * The same renderer serves the running game (camera + stretch mode) and the editor viewport
 * (an explicit view, plus collision-shape outlines).
 */
import { Container, Graphics, ImageSource, Matrix, Rectangle, Sprite, Text, Texture, autoDetectRenderer, type Renderer } from 'pixi.js';
import { Color, Transform2D, Vector2 } from '@gs/shared';
import { AnimatedSprite2D, CollisionShape2D, Label2D, Node2D, Polygon2D, Sprite2D, type Node, type RenderServer, type SceneTree } from '@gs/core';

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

type TexEntry = { state: 'loading' } | { state: 'ready'; source: ImageSource; frames: Map<string, Texture> } | { state: 'error' };

export class Renderer2D implements RenderServer {
  readonly stage = new Container();
  private readonly world = new Container();
  private readonly background = new Graphics();
  private readonly frameMask = new Graphics();
  private visuals = new Map<Node, Visual>();
  private textures = new Map<string, TexEntry>();
  private frame = 0;
  private matrix = new Matrix();
  /** Root to draw (the tree root for games, the edited scene for the editor). */
  root: Node | null = null;
  tree: SceneTree | null = null;
  editorView: EditorView | null = null;
  showCollisionShapes: boolean;
  /** Called when an async texture load finishes (the editor redraws on demand). */
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
    this.stage.addChild(this.background, this.world);
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
      if (this.world.mask !== this.frameMask) {
        this.stage.addChild(this.frameMask);
        this.world.mask = this.frameMask;
      }
    } else if (this.world.mask) {
      this.world.mask = null;
      this.stage.removeChild(this.frameMask);
    }

    this.frame++;
    let order = 0;
    const visit = (n: Node, visible: boolean, tint: Color) => {
      let childVisible = visible;
      let childTint = tint;
      if (n instanceof Node2D) {
        childVisible = visible && n.visible;
        childTint = multiply(tint, n.modulate);
        if (childVisible) this.updateVisual(n, childTint, order++);
      }
      for (const c of n.children) visit(c, childVisible, childTint);
    };
    if (this.root) visit(this.root, true, Color.WHITE);
    for (const [node, v] of this.visuals) {
      if (v.seen !== this.frame) {
        v.obj.destroy({ children: true });
        this.visuals.delete(node);
      }
    }
    this.renderer.render(this.stage);
  }

  private updateVisual(n: Node2D, tint: Color, order: number) {
    let v = this.visuals.get(n);
    const make = (): Visual | null => {
      if (n instanceof Sprite2D) return { obj: new Sprite(), key: '', seen: 0 };
      if (n instanceof Polygon2D) return { obj: new Graphics(), key: '', seen: 0 };
      if (n instanceof Label2D) return { obj: new Text({ text: '' }), key: '', seen: 0 };
      if (n instanceof CollisionShape2D && this.showCollisionShapes) return { obj: new Graphics(), key: '', seen: 0 };
      return null;
    };
    if (!v) {
      const made = make();
      if (!made) return;
      v = made;
      this.world.addChild(v.obj);
      this.visuals.set(n, v);
    }
    v.seen = this.frame;
    const obj = v.obj;
    obj.zIndex = n.globalZIndex * 100000 + order;
    obj.tint = tint.toNumber();
    obj.alpha = tint.a;
    let t = this.viewTransform.multiply(n.globalTransform);

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
    } else if (n instanceof Label2D) {
      const key = JSON.stringify([n.text, n.fontSize, n.color.toHex(true), n.horizontalAlignment, n.outlineSize, n.outlineColor.toHex(true)]);
      const text = obj as Text;
      if (key !== v.key) {
        v.key = key;
        text.text = n.text;
        text.style = {
          fontFamily: 'Inter, system-ui, -apple-system, Segoe UI, sans-serif',
          fontSize: n.fontSize,
          fill: n.color.toNumber(),
          align: n.horizontalAlignment,
          ...(n.outlineSize > 0 ? { stroke: { color: n.outlineColor.toNumber(), width: n.outlineSize } } : {}),
        };
        text.alpha = n.color.a * tint.a;
      }
      text.anchor.set(n.horizontalAlignment === 'center' ? 0.5 : n.horizontalAlignment === 'right' ? 1 : 0, 0);
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
    const key = `${h}x${vf}:${f}`;
    let tex = entry.frames.get(key);
    if (!tex) {
      const fw = entry.source.width / h;
      const fh = entry.source.height / vf;
      tex = h === 1 && vf === 1 ? new Texture({ source: entry.source }) : new Texture({ source: entry.source, frame: new Rectangle((f % h) * fw, Math.floor(f / h) * fh, fw, fh) });
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
        this.textures.set(path, { state: 'ready', source, frames: new Map() });
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
      for (const t of e.frames.values()) t.destroy();
      e.source.destroy();
    }
    this.textures.delete(path);
    for (const v of this.visuals.values()) if (v.obj instanceof Sprite) v.obj.texture = Texture.EMPTY;
  }

  /** Texture size if loaded (editor picking for sprites whose asset has no recorded size). */
  textureSize(path: string): Vector2 | null {
    const e = this.textures.get(path);
    return e?.state === 'ready' ? new Vector2(e.source.width, e.source.height) : null;
  }

  dispose() {
    for (const v of this.visuals.values()) v.obj.destroy({ children: true });
    this.visuals.clear();
    for (const e of this.textures.values()) if (e.state === 'ready') e.source.destroy();
    this.textures.clear();
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
