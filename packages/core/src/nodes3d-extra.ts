/**
 * More 3D nodes: markers, sprites and text in 3D space, paths and followers, on-screen notifiers.
 * Logic lives here (DOM-free); packages/render3d draws them.
 */
import { Color, Mat4, Signal, Vector2, Vector3 } from '@gs/shared';
import { Node3D } from './nodes3d';
import type { Texture } from './resources';
import { BakedCurve, fposmod } from './curve';

/** A position marker: shows axes in the editor, nothing in the game (spawn points, targets). */
export class Marker3D extends Node3D {
  static override readonly typeName: string = 'Marker3D';
  /** Length of the editor axes in metres. */
  gizmoExtents = 0.25;
}

export type BillboardMode = 'disabled' | 'enabled' | 'yBillboard';

/** Shared by Sprite3D and Label3D: drawn flat in 3D, optionally always facing the camera. */
export abstract class SpriteBase3D extends Node3D {
  /** Metres per pixel. */
  pixelSize = 0.01;
  centered = true;
  offset = new Vector2();
  flipH = false;
  flipV = false;
  modulate = Color.WHITE;
  billboard: BillboardMode = 'disabled';
  /** Affected by lights (otherwise drawn at full brightness). */
  shaded = false;
  doubleSided = true;
  /** Draw on top of everything (ignores depth). */
  noDepthTest = false;
}

/** A 2D image in 3D space (pickups, foliage, retro characters). Supports sprite sheets like Sprite2D. */
export class Sprite3D extends SpriteBase3D {
  static override readonly typeName: string = 'Sprite3D';
  texture: Texture | null = null;
  hframes = 1;
  vframes = 1;
  frame = 0;

  /** Size of one frame in pixels. */
  get frameSize(): Vector2 {
    if (!this.texture) return new Vector2();
    return new Vector2(this.texture.width / Math.max(1, this.hframes), this.texture.height / Math.max(1, this.vframes));
  }
}

/** Text in 3D space (name tags, signs, damage numbers). */
export class Label3D extends SpriteBase3D {
  static override readonly typeName: string = 'Label3D';
  text = 'Label';
  fontSize = 32;
  outlineSize = 12;
  outlineColor = Color.BLACK;
  horizontalAlignment: 'left' | 'center' | 'right' = 'center';

  constructor(name?: string) {
    super(name);
    this.pixelSize = 0.005;
  }
}

/** A 3D path for PathFollow3D children (rails, flight paths, patrols). */
export class Path3D extends Node3D {
  static override readonly typeName: string = 'Path3D';
  points: Vector3[] = [new Vector3(0, 0, 0), new Vector3(2, 0, 0), new Vector3(2, 0, -2)];
  closed = false;
  curved = false;
  private bakedKey = '';
  private baked: BakedCurve | null = null;

  getCurve(): BakedCurve {
    const key = `${this.closed}|${this.curved}|${this.points.map((p) => `${p.x},${p.y},${p.z}`).join(';')}`;
    if (!this.baked || key !== this.bakedKey) {
      this.baked = new BakedCurve(
        this.points.map((p) => [p.x, p.y, p.z]),
        this.closed,
        this.curved,
      );
      this.bakedKey = key;
    }
    return this.baked;
  }
  getBakedLength() {
    return this.getCurve().length;
  }
  samplePosition(offset: number): Vector3 {
    return Vector3.fromArray(this.getCurve().sample(offset).point);
  }
  getClosestOffset(localPoint: Vector3) {
    return this.getCurve().closestOffset([localPoint.x, localPoint.y, localPoint.z]);
  }
}

export type PathRotationMode = 'none' | 'y' | 'oriented';

/** Moves along its parent Path3D; faces along the path (-Z forward) unless rotationMode is "none". */
export class PathFollow3D extends Node3D {
  static override readonly typeName: string = 'PathFollow3D';
  private _progress = 0;
  hOffset = 0;
  vOffset = 0;
  rotationMode: PathRotationMode = 'oriented';
  loop = true;

  get progress() {
    return this._progress;
  }
  set progress(v: number) {
    const len = this.path?.getBakedLength() ?? 0;
    this._progress = len > 0 ? (this.loop ? fposmod(v, len) : Math.min(len, Math.max(0, v))) : v;
    this.syncToPath();
  }
  get progressRatio() {
    const len = this.path?.getBakedLength() ?? 0;
    return len > 0 ? this._progress / len : 0;
  }
  set progressRatio(r: number) {
    this.progress = r * (this.path?.getBakedLength() ?? 0);
  }
  get path(): Path3D | null {
    return this.parent instanceof Path3D ? this.parent : null;
  }

  syncToPath() {
    const path = this.path;
    if (!path) return;
    const curve = path.getCurve();
    const len = curve.length;
    const s = curve.sample(len > 0 && this.loop ? fposmod(this._progress, len) : this._progress);
    const fwd = Vector3.fromArray(s.tangent);
    let pos = Vector3.fromArray(s.point);
    let right = new Vector3(1, 0, 0);
    if (fwd.lengthSquared() > 0) {
      right = fwd.cross(Vector3.UP);
      if (right.lengthSquared() < 1e-9) right = new Vector3(1, 0, 0);
      right = right.normalized();
    }
    const up = right.cross(fwd).normalized();
    pos = pos.add(right.scale(this.hOffset)).add(up.lengthSquared() > 0 ? up.scale(this.vOffset) : new Vector3(0, this.vOffset, 0));
    this.position = pos;
    if (this.rotationMode === 'none' || fwd.lengthSquared() === 0) return;
    if (this.rotationMode === 'y') {
      this.rotation = new Vector3(0, Math.atan2(-fwd.x, -fwd.z), 0);
      return;
    }
    // Basis with -Z along the path.
    const z = fwd.neg();
    const m = new Mat4([right.x, right.y, right.z, 0, up.x, up.y, up.z, 0, z.x, z.y, z.z, 0, 0, 0, 0, 1]);
    this.rotation = m.decompose().rotation;
  }

  override get transform(): Mat4 {
    this.syncToPath();
    return super.transform;
  }
  override __process(delta: number) {
    super.__process(delta);
    this.syncToPath();
  }
}

/** Emits screenEntered / screenExited when its box enters or leaves the current camera's view. */
export class VisibleOnScreenNotifier3D extends Node3D {
  static override readonly typeName: string = 'VisibleOnScreenNotifier3D';
  aabbPosition = new Vector3(-1, -1, -1);
  aabbSize = new Vector3(2, 2, 2);
  readonly screenEntered = new Signal<[]>('screenEntered');
  readonly screenExited = new Signal<[]>('screenExited');
  private onScreen = false;

  isOnScreen() {
    return this.onScreen;
  }

  /** The box's corners in world space. */
  getWorldCorners(): Vector3[] {
    const t = this.globalTransform;
    const p = this.aabbPosition;
    const s = this.aabbSize;
    const out: Vector3[] = [];
    for (let i = 0; i < 8; i++) out.push(t.transformPoint(new Vector3(p.x + (i & 1 ? s.x : 0), p.y + (i & 2 ? s.y : 0), p.z + (i & 4 ? s.z : 0))));
    return out;
  }

  override __process(delta: number) {
    super.__process(delta);
    const cam = this.tree?.currentCamera3D;
    const visible = !!cam && cam.isInsideTree() && this.isVisibleInTree() && cam.isBoxInFrustum(this.getWorldCorners());
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
