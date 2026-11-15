/**
 * 3D renderer on three.js (WebGL 2).
 *
 * Every Node3D gets a three.js Group parented to the group of its nearest Node3D ancestor, so the
 * transform inheritance is exactly the core's. Meshes, lights and cameras hang inside those
 * groups. Like the 2D renderer it reconciles by walking the tree each frame (mark & sweep).
 *
 * The editor reuses it with its own camera, helpers and collision-shape wireframes.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { Color as GsColor } from '@gs/shared';
import { CPUParticles3D, Camera3D, CollisionShape3D, DEFAULT_MATERIAL, DirectionalLight3D, Label3D, Marker3D, MeshInstance3D, Node3D, Path3D, PointLight3D, RayCast3D, SpotLight3D, Sprite3D, VisibleOnScreenNotifier3D, WorldEnvironment, type MaterialData, type MeshData, type Node, type RenderServer, type SceneTree, type SpriteBase3D } from '@gs/core';

export type StretchMode = 'fit' | 'expand' | 'stretch' | 'none';

export interface AssetUrls {
  url(path: string): string | null;
}

export interface Renderer3DOptions {
  canvas: HTMLCanvasElement;
  assets: AssetUrls;
  width: number;
  height: number;
  stretch?: StretchMode;
  /** Clear colour when there is no WorldEnvironment. */
  background?: string;
  pixelArt?: boolean;
  /** Editor: draw collision shapes and add a preview sun when the scene has no light. */
  editor?: boolean;
}

interface Visual {
  group: THREE.Group;
  /** Mesh / light / camera inside the group. */
  content: THREE.Object3D | null;
  key: string;
  matKey: string;
  seen: number;
  /** Objects drawn outside the node's group (world-space particles). */
  extra?: THREE.Object3D;
}

const PARTICLE_VERTEX = `
attribute float size;
attribute vec4 color;
uniform float uHalfHeight;
varying vec4 vColor;
void main() {
  vColor = color;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float depth = projectionMatrix[2][3] != 0.0 ? max(-mv.z, 0.0001) : 1.0;
  gl_PointSize = size * projectionMatrix[1][1] * uHalfHeight / depth;
}`;

const PARTICLE_FRAGMENT = `
uniform sampler2D map;
uniform bool useMap;
varying vec4 vColor;
void main() {
  vec4 col = vColor;
  if (useMap) {
    vec4 t = texture2D(map, vec2(gl_PointCoord.x, 1.0 - gl_PointCoord.y));
    col *= vec4(pow(t.rgb, vec3(1.0 / 2.2)), t.a);
  } else {
    float d = length(gl_PointCoord - 0.5);
    col.a *= smoothstep(0.5, 0.3, d);
  }
  if (col.a <= 0.003) discard;
  gl_FragColor = col;
}`;

const LIGHT_SCALE = { directional: 2.5, point: 25, spot: 40, ambient: 2.2 };

export class Renderer3D implements RenderServer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  /** Editor-only objects (grid, gizmos). Drawn but not part of the game. */
  readonly helpers = new THREE.Group();
  root: Node | null = null;
  tree: SceneTree | null = null;
  /** When set, used instead of the scene's current Camera3D (editor viewport). */
  editorCamera: THREE.Camera | null = null;
  onAssetLoaded: (() => void) | null = null;
  private visuals = new Map<Node, Visual>();
  private frame = 0;
  private ambient = new THREE.AmbientLight(0xffffff, 0.4 * LIGHT_SCALE.ambient);
  private previewSun = new THREE.DirectionalLight(0xffffff, 2.2);
  private fallbackCamera = new THREE.PerspectiveCamera(70, 1, 0.05, 1000);
  private textures = new Map<string, THREE.Texture | 'loading' | 'error'>();
  private models = new Map<string, THREE.Object3D | 'loading' | 'error'>();
  private gltf = new GLTFLoader();
  private cssWidth = 1;
  private cssHeight = 1;
  /** Viewport rectangle the game was drawn in (CSS px), for input mapping. */
  viewport = { x: 0, y: 0, w: 1, h: 1 };
  private warnedNoCamera = false;
  /** Sprites and labels to turn toward the camera this frame. */
  private billboards: { v: Visual; mode: 'enabled' | 'yBillboard' }[] = [];
  /** World-space particles live here (they must not move with their emitter). */
  private worldRoot = new THREE.Group();
  private particleMaterials = new Set<THREE.ShaderMaterial>();

  constructor(private opts: Renderer3DOptions) {
    this.renderer = new THREE.WebGLRenderer({ canvas: opts.canvas, antialias: !opts.pixelArt, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.scene.add(this.ambient, this.helpers, this.worldRoot);
    this.previewSun.position.set(4, 8, 6);
    this.fallbackCamera.position.set(0, 2, 6);
    this.fallbackCamera.lookAt(0, 0, 0);
  }

  setOptions(patch: Partial<Pick<Renderer3DOptions, 'width' | 'height' | 'stretch' | 'background' | 'pixelArt'>>) {
    this.opts = { ...this.opts, ...patch };
  }

  resize(width: number, height: number) {
    this.cssWidth = Math.max(1, Math.floor(width));
    this.cssHeight = Math.max(1, Math.floor(height));
    this.renderer.setSize(this.cssWidth, this.cssHeight, false);
  }

  get canvasSize() {
    return { width: this.cssWidth, height: this.cssHeight };
  }

  objectFor(node: Node): THREE.Group | null {
    return this.visuals.get(node)?.group ?? null;
  }

  /** The node a hit object belongs to (for picking). */
  nodeForObject(obj: THREE.Object3D | null): Node | null {
    for (let o = obj; o; o = o.parent) if (o.userData.gsNode) return o.userData.gsNode as Node;
    return null;
  }

  render() {
    this.frame++;
    this.billboards = [];
    let env: WorldEnvironment | null = null;
    let lights = 0;
    const visit = (n: Node, parentGroup: THREE.Object3D) => {
      let next = parentGroup;
      if (n instanceof Node3D) {
        const v = this.sync(n, parentGroup);
        next = v.group;
        if (n instanceof DirectionalLight3D || n instanceof PointLight3D || n instanceof SpotLight3D) lights++;
      } else if (n instanceof WorldEnvironment && !env) env = n;
      for (const c of n.children) visit(c, next);
    };
    if (this.root) visit(this.root, this.scene);
    for (const [node, v] of this.visuals) {
      if (v.seen !== this.frame) {
        v.group.removeFromParent();
        disposeTree(v.group);
        if (v.extra) {
          v.extra.removeFromParent();
          disposeTree(v.extra);
        }
        this.visuals.delete(node);
      }
    }
    this.applyEnvironment(env);
    const wantSun = !!this.opts.editor && lights === 0;
    if (wantSun && !this.previewSun.parent) this.scene.add(this.previewSun);
    if (!wantSun && this.previewSun.parent) this.scene.remove(this.previewSun);

    const camera = this.activeCamera();
    this.drawWith(camera);
  }

  /** Turns billboarded sprites and labels toward the camera (after the scene's transforms are known). */
  private faceCamera(camera: THREE.Camera) {
    if (!this.billboards.length) return;
    this.scene.updateMatrixWorld();
    camera.updateMatrixWorld();
    const camQ = new THREE.Quaternion();
    const camPos = new THREE.Vector3();
    camera.matrixWorld.decompose(camPos, camQ, new THREE.Vector3());
    const parentQ = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    for (const { v, mode } of this.billboards) {
      const content = v.content;
      if (!content) continue;
      v.group.matrixWorld.decompose(pos, parentQ, new THREE.Vector3());
      let target: THREE.Quaternion;
      if (mode === 'enabled') target = camQ.clone();
      else {
        const yaw = Math.atan2(camPos.x - pos.x, camPos.z - pos.z);
        target = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0, 'YXZ'));
      }
      content.quaternion.copy(parentQ.invert().multiply(target));
    }
  }

  private activeCamera(): THREE.Camera {
    if (this.editorCamera) return this.editorCamera;
    const cam = this.tree?.currentCamera3D;
    const v = cam ? this.visuals.get(cam) : undefined;
    if (v?.content instanceof THREE.Camera) return v.content;
    if (!this.warnedNoCamera && this.tree) {
      this.warnedNoCamera = true;
      this.tree.log('warn', 'The 3D scene has no Camera3D; showing it from a default viewpoint. Add a Camera3D.');
    }
    return this.fallbackCamera;
  }

  private drawWith(camera: THREE.Camera) {
    const cw = this.cssWidth;
    const ch = this.cssHeight;
    let vp = { x: 0, y: 0, w: cw, h: ch };
    if (!this.editorCamera && (this.opts.stretch ?? 'fit') === 'fit') {
      const s = Math.min(cw / this.opts.width, ch / this.opts.height);
      const w = this.opts.width * s;
      const h = this.opts.height * s;
      vp = { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
    }
    this.viewport = vp;
    if (this.tree && !this.editorCamera) {
      // The game's viewport in game units, for Camera3D.unprojectPosition and on-screen notifiers.
      const fit = (this.opts.stretch ?? 'fit') === 'fit';
      const s = Math.min(cw / this.opts.width, ch / this.opts.height) || 1;
      this.tree.viewportSize.set(fit ? this.opts.width : cw / s, fit ? this.opts.height : ch / s);
    }
    const aspect = vp.w / Math.max(1, vp.h);
    if (camera instanceof THREE.PerspectiveCamera && camera.aspect !== aspect) {
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
    } else if (camera instanceof THREE.OrthographicCamera) {
      const half = (camera.top - camera.bottom) / 2;
      if (Math.abs((camera.right - camera.left) / 2 - half * aspect) > 1e-6) {
        camera.left = -half * aspect;
        camera.right = half * aspect;
        camera.updateProjectionMatrix();
      }
    }
    const r = this.renderer;
    if (vp.w < cw || vp.h < ch) {
      r.setScissorTest(false);
      r.setClearColor(0x000000, 1);
      r.clear();
      r.setScissorTest(true);
      r.setScissor(vp.x, ch - vp.y - vp.h, vp.w, vp.h);
    } else r.setScissorTest(false);
    r.setViewport(vp.x, ch - vp.y - vp.h, vp.w, vp.h);
    this.faceCamera(camera);
    const halfHeight = (vp.h * r.getPixelRatio()) / 2;
    for (const m of this.particleMaterials) m.uniforms.uHalfHeight.value = halfHeight;
    r.render(this.scene, camera);
    r.setScissorTest(false);
  }

  private applyEnvironment(env: WorldEnvironment | null) {
    const bg = env ? env.backgroundColor : GsColor.fromHex(this.opts.background ?? '#3a4150');
    const bgColor = new THREE.Color(bg.r, bg.g, bg.b).convertSRGBToLinear();
    if (!(this.scene.background instanceof THREE.Color) || !this.scene.background.equals(bgColor)) this.scene.background = bgColor;
    const amb = env ? env.ambientColor : GsColor.WHITE;
    this.ambient.color.setRGB(amb.r, amb.g, amb.b, THREE.SRGBColorSpace);
    this.ambient.intensity = (env ? env.ambientEnergy : 0.4) * LIGHT_SCALE.ambient;
    if (env?.fogEnabled) {
      const fc = new THREE.Color(env.fogColor.r, env.fogColor.g, env.fogColor.b).convertSRGBToLinear();
      if (!(this.scene.fog instanceof THREE.FogExp2)) this.scene.fog = new THREE.FogExp2(fc, env.fogDensity);
      this.scene.fog.color.copy(fc);
      (this.scene.fog as THREE.FogExp2).density = env.fogDensity;
    } else this.scene.fog = null;
  }

  private sync(n: Node3D, parent: THREE.Object3D): Visual {
    let v = this.visuals.get(n);
    if (!v) {
      const group = new THREE.Group();
      group.userData.gsNode = n;
      v = { group, content: null, key: '', matKey: '', seen: 0 };
      this.visuals.set(n, v);
    }
    v.seen = this.frame;
    const g = v.group;
    if (g.parent !== parent) parent.add(g);
    g.position.set(n.position.x, n.position.y, n.position.z);
    g.rotation.set(n.rotation.x, n.rotation.y, n.rotation.z, 'YXZ');
    g.scale.set(n.scale.x, n.scale.y, n.scale.z);
    g.visible = n.visible;

    if (n instanceof MeshInstance3D) this.syncMesh(n, v);
    else if (n instanceof DirectionalLight3D || n instanceof PointLight3D || n instanceof SpotLight3D) this.syncLight(n, v);
    else if (n instanceof Camera3D) this.syncCamera(n, v);
    else if (n instanceof CollisionShape3D) this.syncShape(n, v);
    else if (n instanceof Sprite3D) this.syncSprite(n, v);
    else if (n instanceof Label3D) this.syncLabel(n, v);
    else if (n instanceof CPUParticles3D) this.syncParticles(n, v);
    else if (this.opts.editor) this.syncEditorHelper(n, v);
    return v;
  }

  private setContent(v: Visual, obj: THREE.Object3D | null) {
    if (v.content) {
      v.group.remove(v.content);
      disposeTree(v.content);
    }
    v.content = obj;
    if (obj) v.group.add(obj);
  }

  private syncMesh(n: MeshInstance3D, v: Visual) {
    const key = JSON.stringify(n.mesh);
    const isModel = n.mesh?.type === 'model';
    if (key !== v.key || (isModel && v.content === null)) {
      v.key = key;
      v.matKey = '';
      this.setContent(v, n.mesh ? this.meshObject(n.mesh) : null);
    }
    const mat = n.material;
    const overrides = !isModel || (mat !== null && JSON.stringify(mat) !== JSON.stringify(DEFAULT_MATERIAL));
    const matKey = overrides ? JSON.stringify(mat) : 'model';
    if (v.content && matKey !== v.matKey) {
      v.matKey = matKey;
      if (overrides) {
        const material = this.material(mat ?? DEFAULT_MATERIAL);
        v.content.traverse((o) => {
          if (o instanceof THREE.Mesh) o.material = material;
        });
      }
    }
    v.content?.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.castShadow = n.castShadow;
        o.receiveShadow = n.receiveShadow;
      }
    });
  }

  private meshObject(mesh: MeshData): THREE.Object3D | null {
    if (mesh.type === 'model') {
      const cached = this.models.get(mesh.path) ?? this.loadModel(mesh.path);
      if (!(cached instanceof THREE.Object3D)) return null;
      const copy = cloneSkinned(cached);
      // Clones share geometry and materials with the cached model: never dispose them per instance.
      copy.userData.gsShared = true;
      return copy;
    }
    let geo: THREE.BufferGeometry;
    switch (mesh.type) {
      case 'box':
        geo = new THREE.BoxGeometry(...mesh.size);
        break;
      case 'sphere':
        geo = new THREE.SphereGeometry(mesh.radius, 40, 20);
        break;
      case 'plane':
        geo = new THREE.PlaneGeometry(mesh.size[0], mesh.size[1]).rotateX(-Math.PI / 2);
        break;
      case 'cylinder':
        geo = new THREE.CylinderGeometry(mesh.radius, mesh.radius, mesh.height, 40);
        break;
      case 'capsule':
        geo = new THREE.CapsuleGeometry(mesh.radius, Math.max(0, mesh.height - 2 * mesh.radius), 8, 24);
        break;
    }
    return new THREE.Mesh(geo, this.material(DEFAULT_MATERIAL));
  }

  private loadModel(path: string) {
    this.models.set(path, 'loading');
    const url = this.opts.assets.url(path);
    if (!url) {
      this.models.set(path, 'error');
      return 'error' as const;
    }
    this.gltf.load(
      url,
      (g) => {
        this.models.set(path, g.scene);
        for (const v of this.visuals.values()) if (v.key.includes(JSON.stringify(path))) v.key = '';
        this.onAssetLoaded?.();
      },
      undefined,
      (e) => {
        this.models.set(path, 'error');
        this.tree?.log('error', `Could not load model "${path}": ${e instanceof Error ? e.message : String(e)}`);
        this.onAssetLoaded?.();
      },
    );
    return 'loading' as const;
  }

  private material(m: MaterialData): THREE.Material {
    const albedo = GsColor.fromHex(m.albedo);
    const color = new THREE.Color().setRGB(albedo.r, albedo.g, albedo.b, THREE.SRGBColorSpace);
    const map = m.albedoTexture ? this.texture(m.albedoTexture) : null;
    const transparent = m.transparent || albedo.a < 1;
    if (m.unshaded) return new THREE.MeshBasicMaterial({ color, map, transparent, opacity: albedo.a });
    const em = GsColor.fromHex(m.emission);
    return new THREE.MeshStandardMaterial({
      color,
      map,
      metalness: m.metallic,
      roughness: m.roughness,
      emissive: new THREE.Color().setRGB(em.r, em.g, em.b, THREE.SRGBColorSpace),
      emissiveIntensity: m.emissionEnergy,
      transparent,
      opacity: albedo.a,
    });
  }

  private texture(path: string): THREE.Texture | null {
    const hit = this.textures.get(path);
    if (hit instanceof THREE.Texture) return hit;
    if (hit) return null;
    const url = this.opts.assets.url(path);
    if (!url) return null;
    this.textures.set(path, 'loading');
    new THREE.TextureLoader().load(
      url,
      (t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        if (this.opts.pixelArt) t.magFilter = THREE.NearestFilter;
        this.textures.set(path, t);
        for (const v of this.visuals.values()) v.matKey = '';
        this.onAssetLoaded?.();
      },
      undefined,
      () => this.textures.set(path, 'error'),
    );
    return null;
  }

  private syncLight(n: DirectionalLight3D | PointLight3D | SpotLight3D, v: Visual) {
    const kind = n instanceof DirectionalLight3D ? 'dir' : n instanceof PointLight3D ? 'point' : 'spot';
    if (v.key !== kind) {
      v.key = kind;
      let light: THREE.DirectionalLight | THREE.PointLight | THREE.SpotLight;
      if (kind === 'dir') {
        const l = new THREE.DirectionalLight();
        l.target.position.set(0, 0, -1);
        l.add(l.target);
        const cam = l.shadow.camera;
        cam.left = cam.bottom = -20;
        cam.right = cam.top = 20;
        cam.near = -60;
        cam.far = 60;
        light = l;
      } else if (kind === 'point') light = new THREE.PointLight();
      else {
        const l = new THREE.SpotLight();
        l.target.position.set(0, 0, -1);
        l.add(l.target);
        l.penumbra = 0.2;
        light = l;
      }
      light.shadow.mapSize.set(2048, 2048);
      light.shadow.bias = -0.0005;
      light.shadow.normalBias = 0.02;
      this.setContent(v, light);
    }
    const light = v.content as THREE.Light;
    light.color.setRGB(n.color.r, n.color.g, n.color.b, THREE.SRGBColorSpace);
    light.castShadow = n.shadowEnabled;
    if (light instanceof THREE.DirectionalLight) light.intensity = n.energy * LIGHT_SCALE.directional;
    else if (light instanceof THREE.PointLight && n instanceof PointLight3D) {
      light.intensity = n.energy * LIGHT_SCALE.point;
      light.distance = n.range;
      light.decay = 2;
    } else if (light instanceof THREE.SpotLight && n instanceof SpotLight3D) {
      light.intensity = n.energy * LIGHT_SCALE.spot;
      light.distance = n.range;
      light.angle = (n.spotAngle * Math.PI) / 180;
      light.decay = 2;
    }
  }

  private syncCamera(n: Camera3D, v: Visual) {
    const kind = n.projection;
    if (v.key !== kind) {
      v.key = kind;
      this.setContent(v, kind === 'perspective' ? new THREE.PerspectiveCamera() : new THREE.OrthographicCamera());
    }
    const cam = v.content as THREE.PerspectiveCamera | THREE.OrthographicCamera;
    let dirty = cam.near !== n.near || cam.far !== n.far;
    cam.near = n.near;
    cam.far = n.far;
    if (cam instanceof THREE.PerspectiveCamera) {
      dirty ||= cam.fov !== n.fov;
      cam.fov = n.fov;
    } else if (cam.top !== n.size / 2) {
      cam.top = n.size / 2;
      cam.bottom = -n.size / 2;
      dirty = true;
    }
    if (dirty) cam.updateProjectionMatrix();
  }

  private syncShape(n: CollisionShape3D, v: Visual) {
    if (!this.opts.editor) return;
    const key = JSON.stringify([n.shape, n.disabled]);
    if (key === v.key) return;
    v.key = key;
    const s = n.shape;
    let geo: THREE.BufferGeometry | null = null;
    if (s?.type === 'box') geo = new THREE.BoxGeometry(...s.size);
    else if (s?.type === 'sphere') geo = new THREE.SphereGeometry(s.radius, 16, 10);
    else if (s?.type === 'capsule') geo = new THREE.CapsuleGeometry(s.radius, Math.max(0, s.height - 2 * s.radius), 4, 12);
    else if (s?.type === 'cylinder') geo = new THREE.CylinderGeometry(s.radius, s.radius, s.height, 16);
    this.setContent(v, geo ? new THREE.LineSegments(new THREE.EdgesGeometry(geo, 20), new THREE.LineBasicMaterial({ color: n.disabled ? 0x8b93a4 : 0x38bdf8, depthTest: false, transparent: true, opacity: 0.85 })) : null);
    geo?.dispose();
    if (v.content) v.content.renderOrder = 10;
  }

  // --- sprites and labels -----------------------------------------------------------------------------

  /** A quad for a sprite or label: size in metres, UVs for the frame, flags from the node. */
  private quad(n: SpriteBase3D, widthPx: number, heightPx: number, map: THREE.Texture, uv: [number, number, number, number]): THREE.Mesh {
    const w = widthPx * n.pixelSize;
    const h = heightPx * n.pixelSize;
    const geo = new THREE.PlaneGeometry(w, h);
    let [u0, v0, u1, v1] = uv;
    if (n.flipH) [u0, u1] = [u1, u0];
    if (n.flipV) [v0, v1] = [v1, v0];
    const uvs = geo.getAttribute('uv') as THREE.BufferAttribute;
    // PlaneGeometry vertex order: top-left, top-right, bottom-left, bottom-right.
    uvs.setXY(0, u0, v1);
    uvs.setXY(1, u1, v1);
    uvs.setXY(2, u0, v0);
    uvs.setXY(3, u1, v0);
    uvs.needsUpdate = true;
    // Centred quads sit on the node; otherwise the node is the top-left corner. Offset is in pixels (y down).
    const ox = (n.centered ? 0 : w / 2) + n.offset.x * n.pixelSize;
    const oy = (n.centered ? 0 : -h / 2) - n.offset.y * n.pixelSize;
    geo.translate(ox, oy, 0);
    const color = new THREE.Color().setRGB(n.modulate.r, n.modulate.g, n.modulate.b, THREE.SRGBColorSpace);
    const params = { map, color, transparent: true, opacity: n.modulate.a, alphaTest: 0.01, side: n.doubleSided ? THREE.DoubleSide : THREE.FrontSide, depthTest: !n.noDepthTest, depthWrite: !n.noDepthTest };
    const mesh = new THREE.Mesh(geo, n.shaded ? new THREE.MeshStandardMaterial({ ...params, roughness: 1, metalness: 0 }) : new THREE.MeshBasicMaterial(params));
    if (n.noDepthTest) mesh.renderOrder = 100;
    return mesh;
  }

  private spriteFlags(n: SpriteBase3D) {
    return [n.pixelSize, n.centered, n.offset.x, n.offset.y, n.flipH, n.flipV, n.modulate.toHex(), n.shaded, n.doubleSided, n.noDepthTest].join('|');
  }

  private trackBillboard(n: SpriteBase3D, v: Visual) {
    if (n.billboard !== 'disabled') this.billboards.push({ v, mode: n.billboard });
    else v.content?.quaternion.identity();
  }

  private syncSprite(n: Sprite3D, v: Visual) {
    const path = n.texture?.resourcePath ?? null;
    const tex = path ? this.texture(path) : null;
    const key = `${path}|${!!tex}|${n.hframes}|${n.vframes}|${n.frame}|${this.spriteFlags(n)}`;
    if (key !== v.key) {
      v.key = key;
      if (!tex || !n.texture) this.setContent(v, null);
      else {
        const img = tex.image as { width?: number; height?: number } | undefined;
        const tw = n.texture.width || img?.width || 1;
        const th = n.texture.height || img?.height || 1;
        const hf = Math.max(1, n.hframes);
        const vf = Math.max(1, n.vframes);
        const frame = Math.max(0, Math.min(hf * vf - 1, Math.floor(n.frame)));
        const fx = frame % hf;
        const fy = Math.floor(frame / hf);
        // Texture v runs bottom-up; frames are numbered top-down.
        const uv: [number, number, number, number] = [fx / hf, 1 - (fy + 1) / vf, (fx + 1) / hf, 1 - fy / vf];
        this.setContent(v, this.quad(n, tw / hf, th / vf, tex, uv));
      }
    }
    this.trackBillboard(n, v);
  }

  private syncLabel(n: Label3D, v: Visual) {
    const key = `${n.text}|${n.fontSize}|${n.outlineSize}|${n.outlineColor.toHex()}|${n.horizontalAlignment}|${this.spriteFlags(n)}`;
    if (key !== v.key) {
      v.key = key;
      const canvas = drawLabel(n);
      if (!canvas) this.setContent(v, null);
      else {
        const tex = new THREE.CanvasTexture(canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        const mesh = this.quad(n, canvas.width, canvas.height, tex, [0, 0, 1, 1]);
        // The label's text colour is baked into the texture; modulate only adds transparency.
        (mesh.material as THREE.MeshBasicMaterial).color.set(0xffffff);
        mesh.userData.gsOwnTexture = tex;
        this.setContent(v, mesh);
      }
    }
    this.trackBillboard(n, v);
  }

  // --- particles ----------------------------------------------------------------------------------------

  private syncParticles(n: CPUParticles3D, v: Visual) {
    const sim = n.sim;
    const count = sim.count;
    const path = n.texture?.resourcePath ?? null;
    const tex = path ? this.texture(path) : null;
    let points = v.extra as THREE.Points | undefined;
    const key = `${count}|${path}|${!!tex}`;
    if (!points || v.key !== key) {
      v.key = key;
      if (points) {
        points.removeFromParent();
        disposeTree(points);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('size', new THREE.BufferAttribute(new Float32Array(count), 1).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 4), 4).setUsage(THREE.DynamicDrawUsage));
      const mat = new THREE.ShaderMaterial({
        vertexShader: PARTICLE_VERTEX,
        fragmentShader: PARTICLE_FRAGMENT,
        uniforms: { uHalfHeight: { value: 300 }, map: { value: tex }, useMap: { value: !!tex } },
        transparent: true,
        depthWrite: false,
      });
      this.particleMaterials.add(mat);
      mat.addEventListener('dispose', () => this.particleMaterials.delete(mat));
      points = new THREE.Points(geo, mat);
      points.frustumCulled = false;
      points.userData.gsNode = n;
      v.extra = points;
    }
    // World-space particles stay where they were emitted; local ones move with the emitter.
    const parent = n.localCoords ? v.group : this.worldRoot;
    if (points.parent !== parent) parent.add(points);
    points.visible = n.isVisibleInTree();
    const geo = points.geometry;
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const size = geo.getAttribute('size') as THREE.BufferAttribute;
    const col = geo.getAttribute('color') as THREE.BufferAttribute;
    const p = pos.array as Float32Array;
    const sz = size.array as Float32Array;
    const c = col.array as Float32Array;
    const a = n.color;
    const b = n.colorEnd;
    for (let i = 0; i < count; i++) {
      if (!sim.alive[i]) {
        sz[i] = 0;
        c[i * 4 + 3] = 0;
        continue;
      }
      p[i * 3] = sim.pos[i * 3];
      p[i * 3 + 1] = sim.pos[i * 3 + 1];
      p[i * 3 + 2] = sim.pos[i * 3 + 2];
      sz[i] = n.particleSize * sim.scale[i];
      const t = sim.ageRatio(i);
      c[i * 4] = a.r + (b.r - a.r) * t;
      c[i * 4 + 1] = a.g + (b.g - a.g) * t;
      c[i * 4 + 2] = a.b + (b.b - a.b) * t;
      c[i * 4 + 3] = a.a + (b.a - a.a) * t;
    }
    pos.needsUpdate = true;
    size.needsUpdate = true;
    col.needsUpdate = true;
  }

  // --- editor helpers ------------------------------------------------------------------------------------

  private syncEditorHelper(n: Node3D, v: Visual) {
    let key: string;
    let build: () => THREE.Object3D | null;
    if (n instanceof Marker3D) {
      const e = n.gizmoExtents;
      key = `marker|${e}`;
      build = () => {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute([-e, 0, 0, e, 0, 0, 0, -e, 0, 0, e, 0, 0, 0, -e, 0, 0, e], 3));
        geo.setAttribute('color', new THREE.Float32BufferAttribute([1, 0.3, 0.3, 1, 0.3, 0.3, 0.4, 1, 0.4, 0.4, 1, 0.4, 0.35, 0.55, 1, 0.35, 0.55, 1], 3));
        return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true }));
      };
    } else if (n instanceof Path3D) {
      const pts = n.getCurve().points;
      key = `path|${JSON.stringify(pts)}`;
      build = () => {
        if (pts.length < 2) return null;
        const arr: number[] = [];
        for (let i = 1; i < pts.length; i++) arr.push(...pts[i - 1], ...pts[i]);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
        return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x7dd3fc }));
      };
    } else if (n instanceof RayCast3D) {
      const t = n.targetPosition;
      key = `ray|${t.x},${t.y},${t.z}|${n.enabled}`;
      build = () => {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, t.x, t.y, t.z], 3));
        return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: n.enabled ? 0xf87171 : 0x8b93a4, depthTest: false, transparent: true }));
      };
    } else if (n instanceof VisibleOnScreenNotifier3D) {
      const p = n.aabbPosition;
      const s = n.aabbSize;
      key = `notifier|${p.x},${p.y},${p.z}|${s.x},${s.y},${s.z}`;
      build = () => {
        const box = new THREE.BoxGeometry(Math.max(1e-3, s.x), Math.max(1e-3, s.y), Math.max(1e-3, s.z));
        box.translate(p.x + s.x / 2, p.y + s.y / 2, p.z + s.z / 2);
        const lines = new THREE.LineSegments(new THREE.EdgesGeometry(box), new THREE.LineBasicMaterial({ color: 0xc084fc, transparent: true, opacity: 0.8 }));
        box.dispose();
        return lines;
      };
    } else return;
    if (key === v.key) return;
    v.key = key;
    this.setContent(v, build());
  }

  dispose() {
    for (const v of this.visuals.values()) {
      disposeTree(v.group);
      if (v.extra) disposeTree(v.extra);
    }
    this.visuals.clear();
    for (const t of this.textures.values()) if (t instanceof THREE.Texture) t.dispose();
    for (const m of this.models.values()) if (m instanceof THREE.Object3D) disposeTree(m, true);
    this.renderer.dispose();
  }
}

function disposeTree(obj: THREE.Object3D, includeShared = false) {
  if (obj.userData.gsShared && !includeShared) return;
  obj.traverse((o) => {
    if (o !== obj && o.userData.gsShared && !includeShared) return;
    if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments || o instanceof THREE.Points) {
      o.geometry?.dispose();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) m?.dispose();
      (o.userData.gsOwnTexture as THREE.Texture | undefined)?.dispose();
    }
    if (o instanceof THREE.Light) o.dispose();
  });
}

/** Renders a Label3D's text (with outline) to a canvas; null when there's nothing to draw. */
function drawLabel(n: Label3D): HTMLCanvasElement | null {
  if (typeof document === 'undefined' || !n.text) return null;
  const lines = n.text.split('\n');
  const font = `${Math.max(1, n.fontSize)}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.font = font;
  const pad = Math.ceil(n.outlineSize / 2) + 2;
  const lineHeight = Math.ceil(n.fontSize * 1.2);
  const width = Math.ceil(Math.max(1, ...lines.map((l) => ctx.measureText(l).width))) + pad * 2;
  canvas.width = width;
  canvas.height = lineHeight * lines.length + pad * 2;
  ctx.font = font;
  ctx.textBaseline = 'middle';
  ctx.textAlign = n.horizontalAlignment;
  ctx.lineJoin = 'round';
  const x = n.horizontalAlignment === 'left' ? pad : n.horizontalAlignment === 'right' ? width - pad : width / 2;
  lines.forEach((line, i) => {
    const y = pad + lineHeight * (i + 0.5);
    if (n.outlineSize > 0) {
      ctx.lineWidth = n.outlineSize;
      ctx.strokeStyle = n.outlineColor.toHex().slice(0, 7);
      ctx.globalAlpha = n.outlineColor.a;
      ctx.strokeText(line, x, y);
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = n.modulate.toHex().slice(0, 7);
    ctx.fillText(line, x, y);
  });
  return canvas;
}
