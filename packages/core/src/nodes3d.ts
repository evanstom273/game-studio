/**
 * 3D nodes. Units are metres, y-up, -z forward. Rotation is Euler radians in YXZ order.
 * A Node3D inherits its transform from the nearest Node3D ancestor.
 */
import { Color, Mat4, Quaternion, Vector3, degToRad, radToDeg } from '@gs/shared';
import { Node } from './node';
import { DEFAULT_MATERIAL, type MaterialData, type MeshData } from './properties';

export class Node3D extends Node {
  static override readonly typeName: string = 'Node3D';

  private readonly _position = new Vector3();
  private readonly _rotation = new Vector3();
  private readonly _scale = new Vector3(1, 1, 1);
  visible = true;

  get position(): Vector3 {
    return this._position;
  }
  set position(v: { x: number; y: number; z: number }) {
    this._position.set(v.x, v.y, v.z);
  }
  /** Euler angles in radians (YXZ). */
  get rotation(): Vector3 {
    return this._rotation;
  }
  set rotation(v: { x: number; y: number; z: number }) {
    this._rotation.set(v.x, v.y, v.z);
  }
  get scale(): Vector3 {
    return this._scale;
  }
  set scale(v: { x: number; y: number; z: number }) {
    this._scale.set(v.x, v.y, v.z);
  }
  /** A copy in degrees; assign a new vector to change it. */
  get rotationDegrees(): Vector3 {
    return new Vector3(radToDeg(this._rotation.x), radToDeg(this._rotation.y), radToDeg(this._rotation.z));
  }
  set rotationDegrees(v: { x: number; y: number; z: number }) {
    this._rotation.set(degToRad(v.x), degToRad(v.y), degToRad(v.z));
  }
  get quaternion(): Quaternion {
    return Quaternion.fromEuler(this._rotation);
  }
  set quaternion(q: Quaternion) {
    this.rotation = q.toEuler();
  }

  get parent3D(): Node3D | null {
    return this.parent instanceof Node3D ? this.parent : null;
  }

  get transform(): Mat4 {
    return Mat4.compose(this._position, this._rotation, this._scale);
  }

  get globalTransform(): Mat4 {
    const p = this.parent3D;
    return p ? p.globalTransform.multiply(this.transform) : this.transform;
  }
  set globalTransform(m: Mat4) {
    const p = this.parent3D;
    const local = p ? p.globalTransform.invert().multiply(m) : m;
    const d = local.decompose();
    this.position = d.position;
    this.rotation = d.rotation;
    this.scale = d.scale;
  }

  get globalPosition(): Vector3 {
    return this.globalTransform.getPosition();
  }
  set globalPosition(v: Vector3) {
    const p = this.parent3D;
    this.position = p ? p.globalTransform.invert().transformPoint(v) : v;
  }

  get globalRotation(): Vector3 {
    return this.globalTransform.decompose().rotation;
  }

  /** World-space direction this node faces (-Z). */
  getForward(): Vector3 {
    return this.globalTransform.transformDirection(Vector3.FORWARD).normalized();
  }
  getRight(): Vector3 {
    return this.globalTransform.transformDirection(Vector3.RIGHT).normalized();
  }
  getUp(): Vector3 {
    return this.globalTransform.transformDirection(Vector3.UP).normalized();
  }

  isVisibleInTree(): boolean {
    if (!this.visible) return false;
    const p = this.parent3D;
    return p ? p.isVisibleInTree() : true;
  }

  show() {
    this.visible = true;
  }
  hide() {
    this.visible = false;
  }
  translate(offset: Vector3) {
    this._position.set(this._position.x + offset.x, this._position.y + offset.y, this._position.z + offset.z);
  }
  rotateX(rad: number) {
    this._rotation.x += rad;
  }
  rotateY(rad: number) {
    this._rotation.y += rad;
  }
  rotateZ(rad: number) {
    this._rotation.z += rad;
  }

  /** Points -Z at `target` (global coordinates), keeping `up` up. */
  lookAt(target: Vector3, up = Vector3.UP) {
    const eye = this.globalPosition;
    const z = eye.sub(target).normalized();
    if (z.lengthSquared() === 0) return;
    let x = up.cross(z).normalized();
    if (x.lengthSquared() === 0) x = new Vector3(1, 0, 0);
    const y = z.cross(x);
    const s = this.globalTransform.decompose().scale;
    const m = new Mat4([x.x * s.x, x.y * s.x, x.z * s.x, 0, y.x * s.y, y.y * s.y, y.z * s.y, 0, z.x * s.z, z.y * s.z, z.z * s.z, 0, eye.x, eye.y, eye.z, 1]);
    this.globalTransform = m;
  }

  toLocal(globalPoint: Vector3) {
    return this.globalTransform.invert().transformPoint(globalPoint);
  }
  toGlobal(localPoint: Vector3) {
    return this.globalTransform.transformPoint(localPoint);
  }

  protected override saveGlobalTransform() {
    const m = this.globalTransform;
    return () => {
      this.globalTransform = m;
    };
  }
}

/** Renders a mesh: a built-in primitive or a model file (.glb / .gltf). */
export class MeshInstance3D extends Node3D {
  static override readonly typeName: string = 'MeshInstance3D';
  mesh: MeshData | null = { type: 'box', size: [1, 1, 1] };
  /** Material for primitives; for models, overrides the model's materials when set. */
  material: MaterialData | null = { ...DEFAULT_MATERIAL };
  castShadow = true;
  receiveShadow = true;
}

export class Camera3D extends Node3D {
  static override readonly typeName: string = 'Camera3D';
  current = false;
  projection: 'perspective' | 'orthogonal' = 'perspective';
  /** Vertical field of view in degrees. */
  fov = 75;
  /** Height of the view for orthogonal projection, in metres. */
  size = 10;
  near = 0.05;
  far = 1000;

  override __enterTree() {
    super.__enterTree();
    const tree = this.tree!;
    if (this.current || !tree.currentCamera3D) tree.currentCamera3D = this;
  }
  override __exitTree() {
    if (this.tree?.currentCamera3D === this) this.tree.currentCamera3D = this.tree.findCamera3D(this);
    super.__exitTree();
  }
  makeCurrent() {
    if (this.tree) this.tree.currentCamera3D = this;
  }
  isCurrent() {
    return this.tree?.currentCamera3D === this;
  }
}

export abstract class Light3D extends Node3D {
  color = Color.WHITE;
  energy = 1;
  shadowEnabled = false;
}

/** Sun-like light: only its rotation matters. Shines along -Z. */
export class DirectionalLight3D extends Light3D {
  static override readonly typeName: string = 'DirectionalLight3D';
}

export class PointLight3D extends Light3D {
  static override readonly typeName: string = 'PointLight3D';
  range = 5;
}

export class SpotLight3D extends Light3D {
  static override readonly typeName: string = 'SpotLight3D';
  range = 5;
  /** Half-angle in degrees. */
  spotAngle = 45;
}

/** Scene-wide background and ambient light. */
export class WorldEnvironment extends Node {
  static override readonly typeName: string = 'WorldEnvironment';
  backgroundColor = Color.fromHex('#3a4150');
  ambientColor = Color.fromHex('#ffffff');
  ambientEnergy = 0.4;
  fogEnabled = false;
  fogColor = Color.fromHex('#3a4150');
  fogDensity = 0.02;
}
