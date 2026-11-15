/**
 * 2D nodes. Coordinates are pixels, y-down. A Node2D inherits its transform from the nearest
 * Node2D ancestor; a plain Node in between breaks the chain (as in Godot).
 */
import { Color, Rect2, Signal, Transform2D, Vector2, degToRad, radToDeg } from '@gs/shared';
import { Node } from './node';
import type { Texture } from './resources';
import { Input } from './input';

export class Node2D extends Node {
  static override readonly typeName: string = 'Node2D';

  private readonly _position = new Vector2();
  private readonly _scale = new Vector2(1, 1);
  rotation = 0;
  /** Draw order; higher draws on top. Relative to the parent's when zAsRelative. */
  zIndex = 0;
  zAsRelative = true;
  visible = true;
  modulate = Color.WHITE;

  get position(): Vector2 {
    return this._position;
  }
  set position(v: { x: number; y: number }) {
    this._position.set(v.x, v.y);
  }
  get scale(): Vector2 {
    return this._scale;
  }
  set scale(v: { x: number; y: number }) {
    this._scale.set(v.x, v.y);
  }
  get rotationDegrees() {
    return radToDeg(this.rotation);
  }
  set rotationDegrees(d: number) {
    this.rotation = degToRad(d);
  }

  /** The nearest Node2D ancestor (whose transform this node inherits). */
  get parent2D(): Node2D | null {
    return this.parent instanceof Node2D ? this.parent : null;
  }

  get transform(): Transform2D {
    return Transform2D.compose(this._position, this.rotation, this._scale);
  }

  get globalTransform(): Transform2D {
    const local = this.transform;
    const p = this.parent2D;
    return p ? p.globalTransform.multiply(local) : local;
  }

  get globalPosition(): Vector2 {
    return this.globalTransform.origin;
  }
  set globalPosition(v: { x: number; y: number }) {
    const p = this.parent2D;
    this.position = p ? p.globalTransform.invert().apply(v) : v;
  }

  get globalRotation(): number {
    return this.globalTransform.rotation;
  }
  set globalRotation(r: number) {
    const p = this.parent2D;
    this.rotation = p ? r - p.globalTransform.rotation : r;
  }

  get globalScale(): Vector2 {
    return this.globalTransform.scale;
  }

  /** Effective z index (adds the parents' when zAsRelative). */
  get globalZIndex(): number {
    const p = this.parent2D;
    return this.zAsRelative && p ? p.globalZIndex + this.zIndex : this.zIndex;
  }

  isVisibleInTree(): boolean {
    if (!this.visible) return false;
    const p = this.parent2D;
    return p ? p.isVisibleInTree() : true;
  }

  show() {
    this.visible = true;
  }
  hide() {
    this.visible = false;
  }

  translate(offset: Vector2) {
    this._position.set(this._position.x + offset.x, this._position.y + offset.y);
  }
  rotate(radians: number) {
    this.rotation += radians;
  }
  /** Rotates so +x points at `point` (global coordinates). */
  lookAt(point: Vector2) {
    this.globalRotation = point.sub(this.globalPosition).angle();
  }
  toLocal(globalPoint: Vector2) {
    return this.globalTransform.invert().apply(globalPoint);
  }
  toGlobal(localPoint: Vector2) {
    return this.globalTransform.apply(localPoint);
  }

  /** The pointer position in world coordinates (through the current camera). */
  getGlobalMousePosition(): Vector2 {
    const tree = this.tree;
    const p = Input.getPointerPosition();
    return tree ? tree.canvasTransform.invert().apply(p) : p;
  }
  /** The pointer position in this node's local coordinates. */
  getLocalMousePosition(): Vector2 {
    return this.toLocal(this.getGlobalMousePosition());
  }

  /** Local-space bounds used for picking in the editor (null = just the origin). */
  getLocalBounds(): Rect2 | null {
    return null;
  }

  protected override saveGlobalTransform() {
    const t = this.globalTransform;
    const pos = t.origin;
    const rot = t.rotation;
    return () => {
      this.globalPosition = pos;
      this.globalRotation = rot;
    };
  }
}

export class Sprite2D extends Node2D {
  static override readonly typeName: string = 'Sprite2D';
  texture: Texture | null = null;
  centered = true;
  offset = new Vector2();
  flipH = false;
  flipV = false;
  /** Sprite-sheet columns / rows and the frame shown. */
  hframes = 1;
  vframes = 1;
  frame = 0;

  /** Size of one frame in pixels (0×0 without a texture). */
  get frameSize(): Vector2 {
    if (!this.texture) return new Vector2();
    return new Vector2(this.texture.width / Math.max(1, this.hframes), this.texture.height / Math.max(1, this.vframes));
  }

  getRect(): Rect2 {
    const s = this.frameSize;
    const x = (this.centered ? -s.x / 2 : 0) + this.offset.x;
    const y = (this.centered ? -s.y / 2 : 0) + this.offset.y;
    return new Rect2(x, y, s.x, s.y);
  }

  override getLocalBounds() {
    return this.texture ? this.getRect() : null;
  }
}

/** Plays a sprite sheet: frames are read left-to-right, top-to-bottom. */
export class AnimatedSprite2D extends Sprite2D {
  static override readonly typeName: string = 'AnimatedSprite2D';
  fps = 10;
  playing = true;
  loop = true;
  /** Number of frames to play (0 = all hframes × vframes). */
  frameCount = 0;
  readonly animationFinished = new Signal<[]>('animationFinished');
  private acc = 0;

  play() {
    this.playing = true;
  }
  stop() {
    this.playing = false;
    this.frame = 0;
    this.acc = 0;
  }
  pause() {
    this.playing = false;
  }

  get totalFrames() {
    return this.frameCount > 0 ? this.frameCount : Math.max(1, this.hframes * this.vframes);
  }

  override __process(delta: number) {
    if (!this.playing || this.fps <= 0) return;
    this.acc += delta;
    const step = 1 / this.fps;
    while (this.acc >= step) {
      this.acc -= step;
      if (this.frame + 1 >= this.totalFrames) {
        if (this.loop) this.frame = 0;
        else {
          this.playing = false;
          this.animationFinished.emit();
          return;
        }
      } else this.frame++;
    }
  }
}

/** A filled polygon (default: a 64×64 square). Good for prototyping without art. */
export class Polygon2D extends Node2D {
  static override readonly typeName: string = 'Polygon2D';
  polygon: Vector2[] = [new Vector2(-32, -32), new Vector2(32, -32), new Vector2(32, 32), new Vector2(-32, 32)];
  color = Color.fromHex('#4f8cff');
  override getLocalBounds() {
    return Rect2.fromPoints(this.polygon);
  }
}

/** Text drawn in the 2D world. (Godot's Label is a UI Control; this is a world-space label.) */
export class Label2D extends Node2D {
  static override readonly typeName: string = 'Label2D';
  text = 'Label';
  fontSize = 24;
  color = Color.WHITE;
  horizontalAlignment: 'left' | 'center' | 'right' = 'left';
  outlineSize = 0;
  outlineColor = Color.BLACK;
  override getLocalBounds() {
    const lines = this.text.split('\n');
    const w = Math.max(...lines.map((l) => l.length)) * this.fontSize * 0.55;
    const h = lines.length * this.fontSize * 1.2;
    const x = this.horizontalAlignment === 'center' ? -w / 2 : this.horizontalAlignment === 'right' ? -w : 0;
    return new Rect2(x, 0, Math.max(w, 8), h);
  }
}

/** The 2D view into the world. The first enabled camera in the tree becomes current. */
export class Camera2D extends Node2D {
  static override readonly typeName: string = 'Camera2D';
  enabled = true;
  zoom = new Vector2(1, 1);
  offset = new Vector2();
  /** Smoothly follow the camera's target position. */
  positionSmoothing = false;
  positionSmoothingSpeed = 5;
  /** @internal Smoothed position the renderer uses. */
  smoothedPosition: Vector2 | null = null;

  override __enterTree() {
    super.__enterTree();
    if (this.enabled && !this.tree!.currentCamera2D) this.tree!.currentCamera2D = this;
  }
  override __exitTree() {
    if (this.tree?.currentCamera2D === this) this.tree.currentCamera2D = this.tree.findCamera2D(this);
    super.__exitTree();
  }
  override __process(delta: number) {
    const target = this.globalPosition;
    if (!this.positionSmoothing || !this.smoothedPosition) this.smoothedPosition = target;
    else this.smoothedPosition = this.smoothedPosition.lerp(target, Math.min(1, delta * this.positionSmoothingSpeed));
  }

  makeCurrent() {
    if (this.tree) this.tree.currentCamera2D = this;
  }
  isCurrent() {
    return this.tree?.currentCamera2D === this;
  }
  /** The world point at the centre of the screen. */
  getScreenCenterPosition() {
    return (this.smoothedPosition ?? this.globalPosition).add(this.offset);
  }
}
