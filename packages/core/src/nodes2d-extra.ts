/**
 * More 2D nodes: markers, lines, paths and followers, simple 2D lighting, parallax layers and
 * on-screen notifiers. All logic lives here (DOM-free); packages/render2d draws them.
 */
import { Color, Rect2, Signal, Transform2D, Vector2 } from '@gs/shared';
import { Node2D } from './nodes2d';
import type { Texture } from './resources';
import { BakedCurve, fposmod } from './curve';

/** A position marker: shows a cross in the editor, nothing in the game (spawn points, targets). */
export class Marker2D extends Node2D {
  static override readonly typeName: string = 'Marker2D';
  /** Size of the editor cross in pixels. */
  gizmoExtents = 10;
}

export type LineJoint = 'sharp' | 'bevel' | 'round';
export type LineCap = 'none' | 'box' | 'round';

/** A polyline drawn with a width (trails, lasers, outlines, ropes). */
export class Line2D extends Node2D {
  static override readonly typeName: string = 'Line2D';
  points: Vector2[] = [new Vector2(-64, 0), new Vector2(64, 0)];
  width = 10;
  defaultColor = Color.fromHex('#6680ff');
  closed = false;
  jointMode: LineJoint = 'sharp';
  capMode: LineCap = 'none';

  addPoint(p: Vector2, index?: number) {
    const next = this.points.slice();
    next.splice(index ?? next.length, 0, p.clone());
    this.points = next;
  }
  removePoint(index: number) {
    this.points = this.points.filter((_, i) => i !== index);
  }
  setPointPosition(index: number, p: Vector2) {
    const next = this.points.slice();
    if (index >= 0 && index < next.length) next[index] = p.clone();
    this.points = next;
  }
  getPointPosition(index: number) {
    return this.points[index]?.clone() ?? new Vector2();
  }
  getPointCount() {
    return this.points.length;
  }
  clearPoints() {
    this.points = [];
  }
  override getLocalBounds() {
    if (!this.points.length) return null;
    const r = Rect2.fromPoints(this.points);
    const h = this.width / 2;
    return new Rect2(r.x - h, r.y - h, r.width + this.width, r.height + this.width);
  }
}

/** A path for PathFollow2D children to move along (patrols, moving platforms, rails). */
export class Path2D extends Node2D {
  static override readonly typeName: string = 'Path2D';
  points: Vector2[] = [new Vector2(0, 0), new Vector2(128, 0), new Vector2(128, 128)];
  closed = false;
  /** Smooth the corners (a Catmull-Rom spline through the points). */
  curved = false;
  private bakedKey = '';
  private baked: BakedCurve | null = null;

  /** The baked curve (recomputed when the points change). */
  getCurve(): BakedCurve {
    const key = `${this.closed}|${this.curved}|${this.points.map((p) => `${p.x},${p.y}`).join(';')}`;
    if (!this.baked || key !== this.bakedKey) {
      this.baked = new BakedCurve(
        this.points.map((p) => [p.x, p.y]),
        this.closed,
        this.curved,
      );
      this.bakedKey = key;
    }
    return this.baked;
  }
  /** Total length in pixels. */
  getBakedLength() {
    return this.getCurve().length;
  }
  /** Local point `offset` pixels along the path. */
  samplePosition(offset: number): Vector2 {
    const s = this.getCurve().sample(offset);
    return new Vector2(s.point[0], s.point[1]);
  }
  /** Offset along the path of the point closest to `localPoint`. */
  getClosestOffset(localPoint: Vector2) {
    return this.getCurve().closestOffset([localPoint.x, localPoint.y]);
  }
  override getLocalBounds() {
    return this.points.length ? Rect2.fromPoints(this.getCurve().points.map((p) => new Vector2(p[0], p[1]))) : null;
  }
}

/**
 * Moves along its parent Path2D: set `progress` (pixels) or `progressRatio` (0–1) and it places
 * itself — and its children — on the path, rotated along it when `rotates` is on.
 */
export class PathFollow2D extends Node2D {
  static override readonly typeName: string = 'PathFollow2D';
  private _progress = 0;
  /** Offset along the path's direction. */
  hOffset = 0;
  /** Offset perpendicular to the path. */
  vOffset = 0;
  rotates = true;
  /** Wrap around at the ends (otherwise stop there). */
  loop = true;

  /** Distance along the path in pixels. */
  get progress() {
    return this._progress;
  }
  set progress(v: number) {
    const len = this.path?.getBakedLength() ?? 0;
    this._progress = len > 0 ? (this.loop ? fposmod(v, len) : Math.min(len, Math.max(0, v))) : v;
    this.syncToPath();
  }
  /** Progress as a fraction of the path's length (0–1). */
  get progressRatio() {
    const len = this.path?.getBakedLength() ?? 0;
    return len > 0 ? this._progress / len : 0;
  }
  set progressRatio(r: number) {
    const len = this.path?.getBakedLength() ?? 0;
    this.progress = r * len;
  }

  get path(): Path2D | null {
    return this.parent instanceof Path2D ? this.parent : null;
  }

  /** Places this node on the path (called automatically; scripts rarely need it). */
  syncToPath() {
    const path = this.path;
    if (!path) return;
    const curve = path.getCurve();
    const len = curve.length;
    const d = len > 0 && this.loop ? fposmod(this._progress, len) : this._progress;
    const s = curve.sample(d);
    const t = new Vector2(s.tangent[0], s.tangent[1]);
    const normal = new Vector2(-t.y, t.x);
    this.position = new Vector2(s.point[0], s.point[1]).add(t.scale(this.hOffset)).add(normal.scale(this.vOffset));
    if (this.rotates && (t.x !== 0 || t.y !== 0)) this.rotation = t.angle();
  }

  // The transform always reflects the path, also in the editor (where nodes don't process).
  override get transform(): Transform2D {
    this.syncToPath();
    return super.transform;
  }
  override __process(delta: number) {
    super.__process(delta);
    this.syncToPath();
  }
}

/** Tints everything in its canvas (not CanvasLayers): darken a level, then light it with PointLight2D. */
export class CanvasModulate extends Node2D {
  static override readonly typeName: string = 'CanvasModulate';
  color = Color.WHITE;
}

/**
 * A soft radial light. Lights add up and multiply the canvas, so they show where a CanvasModulate
 * has darkened it (without one, they brighten a little).
 */
export class PointLight2D extends Node2D {
  static override readonly typeName: string = 'PointLight2D';
  enabled = true;
  color = Color.WHITE;
  energy = 1;
  /** Radius in pixels when there's no texture. */
  range = 128;
  /** Optional light shape (white = full light); defaults to a soft circle. */
  texture: Texture | null = null;
  textureScale = 1;

  /** Radius of the lit area in local pixels. */
  get radius(): number {
    const t = this.texture;
    return (t && t.width > 0 ? Math.max(t.width, t.height) / 2 : this.range) * this.textureScale;
  }
  override getLocalBounds() {
    const r = this.radius;
    return new Rect2(-r, -r, r * 2, r * 2);
  }
}

/**
 * A parallax layer (Godot 4.3's Parallax2D): its children scroll at `scrollScale` times the camera's
 * speed (0.5 = half as fast, so further away), and repeat every `repeatSize` pixels for endless
 * backgrounds.
 */
export class Parallax2D extends Node2D {
  static override readonly typeName: string = 'Parallax2D';
  scrollScale = new Vector2(1, 1);
  scrollOffset = new Vector2();
  /** Repeat the children every this many pixels (0 = don't repeat). */
  repeatSize = new Vector2();
  /** Constant scrolling in pixels per second (clouds, conveyor backgrounds). */
  autoscroll = new Vector2();
  private autoscrolled = new Vector2();

  override __process(delta: number) {
    super.__process(delta);
    if (this.autoscroll.x || this.autoscroll.y) this.autoscrolled = this.autoscrolled.add(this.autoscroll.scale(delta));
  }

  /** How far the layer is shifted right now (camera parallax + offset + autoscroll, wrapped by the repeat size). */
  getScrollShift(): Vector2 {
    const tree = this.tree;
    let shift = this.scrollOffset.add(this.autoscrolled);
    if (!tree || this.getCanvasLayer()) return shift;
    // The view's top-left corner in the world: where every layer lines up.
    const view = tree.canvasTransform.invert();
    const topLeft = view.apply({ x: 0, y: 0 });
    shift = shift.add(new Vector2(topLeft.x * (1 - this.scrollScale.x), topLeft.y * (1 - this.scrollScale.y)));
    // Keep a repeating layer's origin just left of / above the view so copies cover the screen.
    const parentT = this.parent2D?.globalTransform ?? Transform2D.identity();
    const origin = parentT.apply(this.position.add(shift));
    const r = this.repeatSize;
    if (r.x > 0) shift.x += Math.floor((topLeft.x - origin.x) / r.x) * r.x;
    if (r.y > 0) shift.y += Math.floor((topLeft.y - origin.y) / r.y) * r.y;
    return shift;
  }

  override get transform(): Transform2D {
    return Transform2D.compose(this.position.add(this.getScrollShift()), this.rotation, this.scale);
  }
}

/** Emits screenEntered / screenExited when its rectangle enters or leaves the screen (despawn off-screen bullets, wake enemies). */
export class VisibleOnScreenNotifier2D extends Node2D {
  static override readonly typeName: string = 'VisibleOnScreenNotifier2D';
  rectPosition = new Vector2(-10, -10);
  rectSize = new Vector2(20, 20);
  readonly screenEntered = new Signal<[]>('screenEntered');
  readonly screenExited = new Signal<[]>('screenExited');
  private onScreen = false;

  get rect(): Rect2 {
    return new Rect2(this.rectPosition.x, this.rectPosition.y, this.rectSize.x, this.rectSize.y);
  }
  set rect(r: Rect2) {
    this.rectPosition = new Vector2(r.x, r.y);
    this.rectSize = new Vector2(r.width, r.height);
  }
  isOnScreen() {
    return this.onScreen;
  }
  override getLocalBounds() {
    return this.rect;
  }

  /** The rectangle's bounding box in viewport pixels. */
  getScreenRect(): Rect2 {
    const t = this.getCanvasTransform().multiply(this.globalTransform);
    const r = this.rect;
    return Rect2.fromPoints([t.apply({ x: r.x, y: r.y }), t.apply({ x: r.x + r.width, y: r.y }), t.apply({ x: r.x, y: r.y + r.height }), t.apply({ x: r.x + r.width, y: r.y + r.height })]);
  }

  override __process(delta: number) {
    super.__process(delta);
    const tree = this.tree;
    if (!tree) return;
    const vp = tree.viewportSize;
    const visible = this.isVisibleInTree() && this.getScreenRect().intersects(new Rect2(0, 0, vp.x, vp.y));
    if (visible === this.onScreen) return;
    this.onScreen = visible;
    if (visible) this.screenEntered.emit();
    else this.screenExited.emit();
  }
  override __exitTree() {
    if (this.onScreen) {
      this.onScreen = false;
      this.screenExited.emit();
    }
    super.__exitTree();
  }
}
