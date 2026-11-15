/**
 * 3D scene viewport: the real 3D renderer (three.js) with an orbit camera, grid, light/camera
 * markers, click/tap selection and a transform gizmo for the selection.
 *
 * Mouse: left-drag orbits, right/middle-drag pans, wheel zooms, click selects.
 * Touch: one finger orbits, two fingers pan and pinch-zoom, tap selects; the gizmo is enlarged.
 */
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { errorMessage } from '@gs/shared';
import { CPUParticles3D, Camera3D, DirectionalLight3D, Node3D, PointLight3D, SpotLight3D, type Node } from '@gs/core';
import { Renderer3D } from '@gs/render3d';
import { useEditor } from '@editor/store/editor';
import { useUi } from '@editor/store/ui';
import { toast } from '@editor/store/toasts';
import { assetUrl } from '@editor/services/assets';
import { LiveScene } from './live-scene';
import { viewportEvents } from './Viewport';

const r5 = (n: number) => Math.round(n * 1e4) / 1e4 + 0;
let sessionSeq = 0;

export default function Viewport3D({ scenePath, cameraPreview }: { scenePath: string; cameraPreview: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const previewRef = useRef(cameraPreview);
  const api = useRef<{ redraw(): void } | null>(null);

  useEffect(() => {
    previewRef.current = cameraPreview;
    api.current?.redraw();
  }, [cameraPreview]);

  useEffect(() => {
    const el = host.current!;
    const cv = document.createElement('canvas');
    cv.className = 'absolute inset-0 block h-full w-full';
    el.appendChild(cv);
    const project0 = useEditor.getState().project!;
    const live = new LiveScene();
    const renderer = new Renderer3D({ canvas: cv, assets: { url: assetUrl }, width: project0.settings.display.width, height: project0.settings.display.height, editor: true });
    const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 2000);
    camera.position.set(6, 5, 9);
    const orbit = new OrbitControls(camera, el);
    orbit.target.set(0, 0.5, 0);
    orbit.enableDamping = false;
    orbit.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    orbit.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    orbit.update();
    renderer.editorCamera = camera;
    const grid = new THREE.GridHelper(40, 40, 0x4b5262, 0x2a303c);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.7;
    const axes = new THREE.AxesHelper(1.2);
    (axes.material as THREE.Material).depthTest = false;
    axes.renderOrder = 5;
    renderer.helpers.add(grid, axes);
    const markers = new THREE.Group();
    renderer.helpers.add(markers);
    const selectionBox = new THREE.BoxHelper(new THREE.Object3D(), 0xf5a524);
    selectionBox.visible = false;
    renderer.helpers.add(selectionBox);
    const gizmo = new TransformControls(camera, el);
    const gizmoHelper = gizmo.getHelper();
    renderer.helpers.add(gizmoHelper);
    let raf = 0;
    let lastParticleTick = 0;
    let dragSession = 0;
    let disposed = false;

    const schedule = () => {
      if (!raf && !disposed) raf = requestAnimationFrame(draw);
    };
    renderer.onAssetLoaded = schedule;

    const syncScene = () => {
      const s = useEditor.getState();
      const scene = s.project?.scenes[scenePath];
      if (!s.project || !scene) return;
      try {
        live.sync(s.project, scene);
      } catch (e) {
        console.error(e);
      }
      renderer.root = live.root;
      schedule();
    };

    const selected = (): Node3D | null => {
      const ids = useEditor.getState().selection;
      const n = ids.length ? live.node(ids[ids.length - 1]) : null;
      return n instanceof Node3D ? n : null;
    };

    const updateGizmo = () => {
      const n = selected();
      const tool = useUi.getState().tool;
      const obj = n ? renderer.objectFor(n) : null;
      if (obj && n !== live.root) {
        if (gizmo.object !== obj) gizmo.attach(obj);
        gizmo.setMode(tool === 'rotate' ? 'rotate' : tool === 'scale' ? 'scale' : 'translate');
        gizmo.setSize(matchMedia('(pointer: coarse)').matches ? 1.6 : 1);
        gizmo.setTranslationSnap(useUi.getState().snap ? 0.5 : null);
        gizmo.setRotationSnap(useUi.getState().snap ? THREE.MathUtils.degToRad(15) : null);
        gizmo.setScaleSnap(useUi.getState().snap ? 0.1 : null);
        gizmoHelper.visible = !previewRef.current;
      } else if (gizmo.object) gizmo.detach();
      if (obj) {
        selectionBox.setFromObject(obj);
        selectionBox.visible = !previewRef.current;
      } else selectionBox.visible = false;
    };

    const rebuildMarkers = () => {
      markers.clear();
      live.root?.walk((n: Node) => {
        if (!(n instanceof Node3D)) return;
        const obj = renderer.objectFor(n);
        if (!obj) return;
        let helper: THREE.Object3D | null = null;
        if (n instanceof Camera3D) {
          const g = new THREE.BufferGeometry();
          const s = 0.4;
          const v = [0, 0, 0, -s, -s * 0.6, -s * 1.4, 0, 0, 0, s, -s * 0.6, -s * 1.4, 0, 0, 0, s, s * 0.6, -s * 1.4, 0, 0, 0, -s, s * 0.6, -s * 1.4, -s, -s * 0.6, -s * 1.4, s, -s * 0.6, -s * 1.4, s, -s * 0.6, -s * 1.4, s, s * 0.6, -s * 1.4, s, s * 0.6, -s * 1.4, -s, s * 0.6, -s * 1.4, -s, s * 0.6, -s * 1.4, -s, -s * 0.6, -s * 1.4];
          g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
          helper = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xd6dae3 }));
        } else if (n instanceof DirectionalLight3D || n instanceof SpotLight3D) {
          helper = new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(), 1.4, 0xfbbf24, 0.3, 0.2);
        } else if (n instanceof PointLight3D) {
          helper = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 8), new THREE.MeshBasicMaterial({ color: 0xfbbf24, wireframe: true }));
        }
        if (helper) {
          helper.userData.followNode = obj;
          markers.add(helper);
        }
      });
    };

    function draw() {
      raf = 0;
      // Particles animate in the editor too: there's no game loop here, so step them per frame.
      const now = performance.now();
      const dt = Math.min(0.1, lastParticleTick ? (now - lastParticleTick) / 1000 : 1 / 60);
      let animating = false;
      live.root?.walk((n: Node) => {
        if (!(n instanceof CPUParticles3D) || !n.isVisibleInTree()) return;
        if (!n.emitting && n.sim.aliveCount() === 0) return;
        n.simulate(dt);
        animating = true;
      });
      lastParticleTick = animating ? now : 0;
      const preview = previewRef.current;
      renderer.editorCamera = preview ? null : camera;
      renderer.tree = null;
      // Scene cameras are found through the tree at runtime; in preview use the first Camera3D.
      if (preview) {
        let cam: Camera3D | null = null;
        live.root?.walk((n) => {
          if (n instanceof Camera3D && (!cam || n.current)) cam = n;
        });
        const obj = cam ? renderer.objectFor(cam)?.children.find((c) => c instanceof THREE.Camera) : null;
        renderer.editorCamera = (obj as THREE.Camera | undefined) ?? camera;
      }
      grid.visible = !preview;
      axes.visible = !preview;
      markers.visible = !preview;
      renderer.render();
      // Markers follow their nodes (after render has positioned the groups).
      let rebuild = false;
      for (const m of markers.children) {
        const target = m.userData.followNode as THREE.Object3D;
        if (!target.parent) rebuild = true;
        target.updateWorldMatrix(true, false);
        m.matrixAutoUpdate = false;
        m.matrix.copy(target.matrixWorld);
      }
      updateGizmo();
      if (rebuild || markers.children.length === 0) {
        const before = markers.children.length;
        rebuildMarkers();
        if (markers.children.length !== before || rebuild) schedule();
      }
      renderer.render();
      if (animating) schedule();
    }

    // Gizmo edits → commands (one undo step per drag).
    gizmo.addEventListener('dragging-changed', (e) => {
      orbit.enabled = !e.value;
      if (e.value) dragSession = ++sessionSeq;
      else commitGizmo(true);
    });
    gizmo.addEventListener('objectChange', () => commitGizmo(false));
    const commitGizmo = (final: boolean) => {
      const obj = gizmo.object;
      const id = obj?.userData.gsNode ? live.docId(obj.userData.gsNode as Node) : null;
      if (!obj || !id) return;
      const e = new THREE.Euler().setFromQuaternion(obj.quaternion, 'YXZ');
      try {
        useEditor.getState().dispatch([{ op: 'set_props', scene: scenePath, node: id, props: { position: obj.position.toArray().map(r5), rotation: [r5(e.x), r5(e.y), r5(e.z)], scale: obj.scale.toArray().map(r5) } }], { label: gizmo.getMode() === 'rotate' ? 'Rotate' : gizmo.getMode() === 'scale' ? 'Scale' : 'Move', mergeKey: `gizmo3d:${dragSession}` });
      } catch (err) {
        if (final) toast('error', errorMessage(err));
      }
    };

    // Click / tap to select (ignore drags and gizmo use).
    const raycaster = new THREE.Raycaster();
    let downAt: { x: number; y: number; t: number } | null = null;
    const onDown = (e: PointerEvent) => {
      downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
    };
    const onUp = (e: PointerEvent) => {
      if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 6 || gizmo.dragging || previewRef.current) return;
      const r = el.getBoundingClientRect();
      raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
      raycaster.params.Line = { threshold: 0.08 };
      const candidates: THREE.Object3D[] = [];
      renderer.scene.traverse((o) => {
        if ((o instanceof THREE.Mesh || o instanceof THREE.LineSegments) && !renderer.helpers.getObjectById(o.id) && o.visible) candidates.push(o);
      });
      const hits = raycaster.intersectObjects(candidates, false);
      let id: string | null = null;
      for (const h of hits) {
        const n = renderer.nodeForObject(h.object);
        if (n) {
          id = live.docId(n);
          if (id) break;
        }
      }
      // Markers (cameras, lights) are helpers; pick them by proximity on screen.
      if (!id) {
        let best = 22;
        live.root?.walk((n) => {
          if (!(n instanceof Camera3D || n instanceof DirectionalLight3D || n instanceof PointLight3D || n instanceof SpotLight3D)) return;
          const obj = renderer.objectFor(n);
          if (!obj) return;
          const p = new THREE.Vector3().setFromMatrixPosition(obj.matrixWorld).project(camera);
          const d = Math.hypot(((p.x + 1) / 2) * r.width - (e.clientX - r.left), ((1 - p.y) / 2) * r.height - (e.clientY - r.top));
          if (d < best && p.z < 1) {
            best = d;
            id = live.docId(n);
          }
        });
      }
      const s = useEditor.getState();
      s.select(id ? (e.shiftKey ? [...s.selection, id] : [id]) : []);
    };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointerup', onUp);
    orbit.addEventListener('change', schedule);
    gizmo.addEventListener('change', schedule);

    const frame = () => {
      const n = selected();
      const obj = n ? renderer.objectFor(n) : null;
      if (obj) {
        const box = new THREE.Box3().setFromObject(obj);
        const center = box.isEmpty() ? new THREE.Vector3().setFromMatrixPosition(obj.matrixWorld) : box.getCenter(new THREE.Vector3());
        const size = box.isEmpty() ? 2 : Math.max(1, box.getSize(new THREE.Vector3()).length());
        const dir = camera.position.clone().sub(orbit.target).normalize();
        orbit.target.copy(center);
        camera.position.copy(center.clone().add(dir.multiplyScalar(size * 1.6)));
      } else {
        orbit.target.set(0, 0.5, 0);
        camera.position.set(6, 5, 9);
      }
      orbit.update();
      schedule();
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input,textarea,.cm-editor')) return;
      if (e.key.toLowerCase() === 'f' && !e.ctrlKey && !e.metaKey) frame();
    };
    window.addEventListener('keydown', onKey);
    viewportEvents.addEventListener('frame', frame);

    const resize = () => {
      const r = el.getBoundingClientRect();
      renderer.resize(r.width, r.height);
      camera.aspect = r.width / Math.max(1, r.height);
      camera.updateProjectionMatrix();
      schedule();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();
    syncScene();
    api.current = { redraw: schedule };

    const unsubEditor = useEditor.subscribe((s, prev) => {
      if (s.project !== prev.project) {
        syncScene();
        markers.clear();
      } else if (s.selection !== prev.selection) schedule();
    });
    const unsubUi = useUi.subscribe(schedule);
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      unsubEditor();
      unsubUi();
      window.removeEventListener('keydown', onKey);
      viewportEvents.removeEventListener('frame', frame);
      gizmo.detach();
      gizmo.dispose();
      orbit.dispose();
      renderer.dispose();
      cv.remove();
      api.current = null;
    };
  }, [scenePath]);

  return (
    <div ref={host} className="absolute inset-0 touch-none select-none overflow-hidden" data-testid="viewport-3d" />
  );
}
