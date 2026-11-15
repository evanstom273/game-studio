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
import { Camera3D, CollisionShape3D, DEFAULT_MATERIAL, DirectionalLight3D, MeshInstance3D, Node3D, PointLight3D, SpotLight3D, WorldEnvironment, type MaterialData, type MeshData, type Node, type RenderServer, type SceneTree } from '@gs/core';

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
}

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

  constructor(private opts: Renderer3DOptions) {
    this.renderer = new THREE.WebGLRenderer({ canvas: opts.canvas, antialias: !opts.pixelArt, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.scene.add(this.ambient, this.helpers);
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

  dispose() {
    for (const v of this.visuals.values()) disposeTree(v.group);
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
    if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
      o.geometry?.dispose();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) m?.dispose();
    }
    if (o instanceof THREE.Light) o.dispose();
  });
}
