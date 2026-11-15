/**
 * Node type registry: every node type the editor, the command layer, MCP and the runtime know
 * about, with its class and property metadata. New node types are added with `register()`; the
 * editor (palette, inspector) and MCP schemas pick them up automatically.
 */
import { GameStudioError, degToRad } from '@gs/shared';
import type { Node } from './node';
import { DEFAULT_MATERIAL, type PropDef } from './properties';
import type { NodeDoc } from './scene-format';
import * as N from './nodes2d';
import * as D from './nodes3d';
import * as P from './physics';
import * as M from './nodes-misc';
import { Node as BaseNode } from './node';

export type NodeCategory = 'Core' | '2D' | '3D' | 'Physics 2D' | 'Physics 3D' | 'Audio' | 'Utility';

export interface ConfigWarningContext {
  node: NodeDoc;
  parentType: string | null;
  childTypes: string[];
  isA(type: string, base: string): boolean;
}

export interface NodeTypeInfo {
  name: string;
  base: string | null;
  ctor: new () => Node;
  category: NodeCategory;
  /** Which kind of viewport the type belongs to. */
  dimension: '2d' | '3d' | null;
  description: string;
  /** Lucide icon name for the editor. */
  icon: string;
  /** Own properties (inherited ones come from the base). */
  properties: PropDef[];
  /** Abstract types are bases only and can't be created. */
  abstract?: boolean;
  /** Problems with how the node is set up (Godot's configuration warnings). */
  warnings?: (ctx: ConfigWarningContext) => string[];
}

export class NodeRegistry {
  private types = new Map<string, NodeTypeInfo>();
  private propCache = new Map<string, PropDef[]>();

  register(info: NodeTypeInfo) {
    if (info.base && !this.types.has(info.base)) throw new GameStudioError('E_UNKNOWN_TYPE', `Base type ${info.base} of ${info.name} is not registered`);
    this.types.set(info.name, info);
    this.propCache.clear();
  }

  has(name: string) {
    return this.types.has(name);
  }

  get(name: string) {
    return this.types.get(name);
  }

  require(name: string): NodeTypeInfo {
    const t = this.types.get(name);
    if (!t) throw new GameStudioError('E_UNKNOWN_TYPE', `Unknown node type "${name}". Use one of: ${this.list().map((x) => x.name).join(', ')}`);
    return t;
  }

  /** Creatable types, in registration order. */
  list(): NodeTypeInfo[] {
    return [...this.types.values()].filter((t) => !t.abstract);
  }

  all(): NodeTypeInfo[] {
    return [...this.types.values()];
  }

  /** Type name and its bases, most derived first. */
  chain(name: string): string[] {
    const out: string[] = [];
    for (let t = this.types.get(name); t; t = t.base ? this.types.get(t.base) : undefined) out.push(t.name);
    return out;
  }

  isA(name: string, base: string) {
    return this.chain(name).includes(base);
  }

  /** All properties of a type (base properties first). */
  properties(name: string): PropDef[] {
    let hit = this.propCache.get(name);
    if (!hit) {
      hit = this.chain(name)
        .reverse()
        .flatMap((t) => this.types.get(t)!.properties);
      this.propCache.set(name, hit);
    }
    return hit;
  }

  property(type: string, prop: string): PropDef | undefined {
    return this.properties(type).find((p) => p.name === prop);
  }

  dimension(name: string): '2d' | '3d' | null {
    for (const t of this.chain(name)) {
      const d = this.types.get(t)!.dimension;
      if (d) return d;
    }
    return null;
  }

  /** The registered type a class (e.g. a script) belongs to: the closest registered ancestor. */
  typeOfClass(cls: abstract new () => Node): NodeTypeInfo | null {
    for (let c: unknown = cls; c && c !== Function.prototype; c = Object.getPrototypeOf(c)) {
      const hit = [...this.types.values()].find((t) => t.ctor === c);
      if (hit) return hit;
    }
    return null;
  }

  warnings(ctx: Omit<ConfigWarningContext, 'isA'>): string[] {
    const full: ConfigWarningContext = { ...ctx, isA: (a, b) => this.isA(a, b) };
    return this.chain(ctx.node.type).flatMap((t) => this.types.get(t)!.warnings?.(full) ?? []);
  }
}

// --- built-in types ----------------------------------------------------------------------------------------------

const f = (name: string, def: number, extra: Partial<PropDef> = {}): PropDef => ({ name, type: 'float', default: def, ...extra });
const i = (name: string, def: number, extra: Partial<PropDef> = {}): PropDef => ({ name, type: 'int', default: def, step: 1, ...extra });
const b = (name: string, def: boolean, extra: Partial<PropDef> = {}): PropDef => ({ name, type: 'bool', default: def, ...extra });
const v2 = (name: string, def: [number, number], extra: Partial<PropDef> = {}): PropDef => ({ name, type: 'vector2', default: def, ...extra });
const v3 = (name: string, def: [number, number, number], extra: Partial<PropDef> = {}): PropDef => ({ name, type: 'vector3', default: def, ...extra });
const c = (name: string, def: string, extra: Partial<PropDef> = {}): PropDef => ({ name, type: 'color', default: def, ...extra });
const e = (name: string, def: string, options: readonly string[], extra: Partial<PropDef> = {}): PropDef => ({ name, type: 'enum', default: def, options, ...extra });

const MAX_LAYER = 0xffffffff;
const layers = (group: string): PropDef[] => [
  i('collisionLayer', 1, { min: 0, max: MAX_LAYER, group, hint: 'Bitmask of the layers this object is in' }),
  i('collisionMask', 1, { min: 0, max: MAX_LAYER, group, hint: 'Bitmask of the layers this object collides with / detects' }),
];

const needsShapes2D = (ctx: ConfigWarningContext) => (ctx.childTypes.some((t) => ctx.isA(t, 'CollisionShape2D')) ? [] : ['Has no CollisionShape2D child, so it cannot collide with anything. Add one.']);
const needsShapes3D = (ctx: ConfigWarningContext) => (ctx.childTypes.some((t) => ctx.isA(t, 'CollisionShape3D')) ? [] : ['Has no CollisionShape3D child, so it cannot collide with anything. Add one.']);

export function registerBuiltinTypes(r: NodeRegistry) {
  r.register({
    name: 'Node',
    base: null,
    ctor: BaseNode,
    category: 'Core',
    dimension: null,
    icon: 'circle',
    description: 'Base of all nodes. Use it to group nodes or to hold a script with no visual.',
    properties: [e('processMode', 'inherit', ['inherit', 'pausable', 'whenPaused', 'always', 'disabled'], { group: 'Process', hint: 'Whether it runs while the game is paused' })],
  });

  // 2D
  r.register({
    name: 'Node2D',
    base: 'Node',
    ctor: N.Node2D,
    category: '2D',
    dimension: '2d',
    icon: 'move',
    description: 'A 2D object with position, rotation and scale. Children inherit its transform.',
    properties: [
      v2('position', [0, 0], { group: 'Transform', hint: 'Pixels, y down' }),
      f('rotation', 0, { degrees: true, step: 1, group: 'Transform', hint: 'Radians (edited in degrees), clockwise' }),
      v2('scale', [1, 1], { group: 'Transform', step: 0.1 }),
      i('zIndex', 0, { min: -4096, max: 4096, group: 'Ordering', hint: 'Higher draws on top' }),
      b('zAsRelative', true, { group: 'Ordering' }),
      b('visible', true, { group: 'Visibility' }),
      c('modulate', '#ffffff', { group: 'Visibility', hint: 'Tint (multiplies colours, alpha fades)' }),
    ],
  });
  r.register({
    name: 'Sprite2D',
    base: 'Node2D',
    ctor: N.Sprite2D,
    category: '2D',
    dimension: '2d',
    icon: 'image',
    description: 'Draws a texture (or one frame of a sprite sheet).',
    properties: [
      { name: 'texture', type: 'resource', resource: 'texture', default: null, nullable: true, group: 'Texture' },
      b('centered', true, { group: 'Offset' }),
      v2('offset', [0, 0], { group: 'Offset' }),
      b('flipH', false, { group: 'Offset' }),
      b('flipV', false, { group: 'Offset' }),
      i('hframes', 1, { min: 1, max: 256, group: 'Animation', hint: 'Sprite-sheet columns' }),
      i('vframes', 1, { min: 1, max: 256, group: 'Animation', hint: 'Sprite-sheet rows' }),
      i('frame', 0, { min: 0, max: 65535, group: 'Animation' }),
    ],
  });
  r.register({
    name: 'AnimatedSprite2D',
    base: 'Sprite2D',
    ctor: N.AnimatedSprite2D,
    category: '2D',
    dimension: '2d',
    icon: 'film',
    description: 'Plays a sprite sheet (frames left to right, top to bottom).',
    properties: [f('fps', 10, { min: 0, max: 240, group: 'Animation' }), b('playing', true, { group: 'Animation' }), b('loop', true, { group: 'Animation' }), i('frameCount', 0, { min: 0, max: 65535, group: 'Animation', hint: '0 = all frames' })],
  });
  r.register({
    name: 'Polygon2D',
    base: 'Node2D',
    ctor: N.Polygon2D,
    category: '2D',
    dimension: '2d',
    icon: 'hexagon',
    description: 'A filled polygon in one colour. Handy for prototyping without art.',
    properties: [
      c('color', '#4f8cff'),
      {
        name: 'polygon',
        type: 'vector2[]',
        default: [
          [-32, -32],
          [32, -32],
          [32, 32],
          [-32, 32],
        ],
        hint: 'Points in local pixels',
      },
    ],
  });
  r.register({
    name: 'Label2D',
    base: 'Node2D',
    ctor: N.Label2D,
    category: '2D',
    dimension: '2d',
    icon: 'type',
    description: 'Text in the 2D world.',
    properties: [
      { name: 'text', type: 'multiline', default: 'Label' },
      i('fontSize', 24, { min: 1, max: 512 }),
      c('color', '#ffffff'),
      e('horizontalAlignment', 'left', ['left', 'center', 'right']),
      i('outlineSize', 0, { min: 0, max: 64 }),
      c('outlineColor', '#000000'),
    ],
  });
  r.register({
    name: 'Camera2D',
    base: 'Node2D',
    ctor: N.Camera2D,
    category: '2D',
    dimension: '2d',
    icon: 'video',
    description: 'The view into the 2D world. The first enabled camera is used.',
    properties: [b('enabled', true), v2('zoom', [1, 1], { step: 0.1, hint: '2 = twice as close' }), v2('offset', [0, 0]), b('positionSmoothing', false, { group: 'Smoothing' }), f('positionSmoothingSpeed', 5, { min: 0.1, max: 100, group: 'Smoothing' })],
  });

  // Physics 2D
  r.register({ name: 'CollisionObject2D', base: 'Node2D', ctor: P.CollisionObject2D as unknown as new () => Node, category: 'Physics 2D', dimension: '2d', icon: 'shapes', description: 'Base of 2D bodies and areas.', properties: layers('Collision'), abstract: true });
  r.register({
    name: 'StaticBody2D',
    base: 'CollisionObject2D',
    ctor: P.StaticBody2D,
    category: 'Physics 2D',
    dimension: '2d',
    icon: 'square',
    description: 'A body that never moves: floors, walls, platforms.',
    properties: [f('friction', 1, { min: 0, max: 10 }), f('bounce', 0, { min: 0, max: 1 })],
    warnings: needsShapes2D,
  });
  r.register({
    name: 'RigidBody2D',
    base: 'CollisionObject2D',
    ctor: P.RigidBody2D,
    category: 'Physics 2D',
    dimension: '2d',
    icon: 'box',
    description: 'A body moved by the physics simulation (gravity, collisions, impulses).',
    properties: [
      f('mass', 1, { min: 0.001, max: 100000 }),
      f('gravityScale', 1, { min: -100, max: 100 }),
      v2('linearVelocity', [0, 0], { group: 'Velocity' }),
      f('angularVelocity', 0, { group: 'Velocity' }),
      f('linearDamp', 0, { min: 0, max: 100, group: 'Damping' }),
      f('angularDamp', 0, { min: 0, max: 100, group: 'Damping' }),
      f('friction', 1, { min: 0, max: 10 }),
      f('bounce', 0, { min: 0, max: 1 }),
      b('lockRotation', false),
      b('freeze', false),
      b('contactMonitor', false, { hint: 'Emit bodyEntered/bodyExited' }),
    ],
    warnings: needsShapes2D,
  });
  r.register({
    name: 'CharacterBody2D',
    base: 'CollisionObject2D',
    ctor: P.CharacterBody2D,
    category: 'Physics 2D',
    dimension: '2d',
    icon: 'person-standing',
    description: 'A body moved by script with moveAndSlide(): players and enemies.',
    properties: [v2('velocity', [0, 0], { hint: 'Pixels per second' }), v2('upDirection', [0, -1]), f('floorMaxAngle', degToRad(45), { degrees: true, min: 0, max: Math.PI / 2 }), f('floorSnapLength', 4, { min: 0, max: 64 })],
    warnings: needsShapes2D,
  });
  r.register({
    name: 'Area2D',
    base: 'CollisionObject2D',
    ctor: P.Area2D,
    category: 'Physics 2D',
    dimension: '2d',
    icon: 'scan',
    description: 'Detects bodies entering and leaving it (pickups, triggers, hitboxes).',
    properties: [b('monitoring', true)],
    warnings: needsShapes2D,
  });
  r.register({
    name: 'CollisionShape2D',
    base: 'Node2D',
    ctor: P.CollisionShape2D,
    category: 'Physics 2D',
    dimension: '2d',
    icon: 'square-dashed',
    description: 'Gives its parent body or area a shape.',
    properties: [{ name: 'shape', type: 'shape2d', default: { type: 'rectangle', size: [64, 64] }, nullable: true }, b('disabled', false)],
    warnings: (ctx) => [...(ctx.parentType && ctx.isA(ctx.parentType, 'CollisionObject2D') ? [] : ['Only works as a direct child of a StaticBody2D, RigidBody2D, CharacterBody2D or Area2D.']), ...(ctx.node.props?.shape === null ? ['Has no shape.'] : [])],
  });

  // 3D
  r.register({
    name: 'Node3D',
    base: 'Node',
    ctor: D.Node3D,
    category: '3D',
    dimension: '3d',
    icon: 'move-3d',
    description: 'A 3D object with position, rotation and scale. Children inherit its transform.',
    properties: [v3('position', [0, 0, 0], { group: 'Transform', step: 0.1, hint: 'Metres' }), v3('rotation', [0, 0, 0], { degrees: true, step: 1, group: 'Transform', hint: 'Euler YXZ, radians (edited in degrees)' }), v3('scale', [1, 1, 1], { step: 0.1, group: 'Transform' }), b('visible', true, { group: 'Visibility' })],
  });
  r.register({
    name: 'MeshInstance3D',
    base: 'Node3D',
    ctor: D.MeshInstance3D,
    category: '3D',
    dimension: '3d',
    icon: 'box',
    description: 'Draws a mesh: a primitive (box, sphere, plane, cylinder, capsule) or a .glb/.gltf model.',
    properties: [
      { name: 'mesh', type: 'mesh', default: { type: 'box', size: [1, 1, 1] }, nullable: true },
      { name: 'material', type: 'material', default: { ...DEFAULT_MATERIAL }, nullable: true },
      b('castShadow', true, { group: 'Shadows' }),
      b('receiveShadow', true, { group: 'Shadows' }),
    ],
  });
  r.register({
    name: 'Camera3D',
    base: 'Node3D',
    ctor: D.Camera3D,
    category: '3D',
    dimension: '3d',
    icon: 'video',
    description: 'The view into the 3D world. Looks along -Z.',
    properties: [b('current', false, { hint: 'Use this camera (otherwise the first one)' }), e('projection', 'perspective', ['perspective', 'orthogonal']), f('fov', 75, { min: 1, max: 179 }), f('size', 10, { min: 0.01, max: 10000 }), f('near', 0.05, { min: 0.001, max: 100 }), f('far', 1000, { min: 0.01, max: 100000 })],
  });
  r.register({ name: 'Light3D', base: 'Node3D', ctor: D.Light3D as unknown as new () => Node, category: '3D', dimension: '3d', icon: 'sun', description: 'Base of lights.', properties: [c('color', '#ffffff', { group: 'Light' }), f('energy', 1, { min: 0, max: 16, group: 'Light' }), b('shadowEnabled', false, { group: 'Shadow' })], abstract: true });
  r.register({ name: 'DirectionalLight3D', base: 'Light3D', ctor: D.DirectionalLight3D, category: '3D', dimension: '3d', icon: 'sun', description: 'Sunlight: parallel rays along the node’s -Z.', properties: [] });
  r.register({ name: 'PointLight3D', base: 'Light3D', ctor: D.PointLight3D, category: '3D', dimension: '3d', icon: 'lightbulb', description: 'Light shining in all directions from a point.', properties: [f('range', 5, { min: 0.01, max: 4096 })] });
  r.register({ name: 'SpotLight3D', base: 'Light3D', ctor: D.SpotLight3D, category: '3D', dimension: '3d', icon: 'flashlight', description: 'A cone of light along -Z.', properties: [f('range', 5, { min: 0.01, max: 4096 }), f('spotAngle', 45, { min: 0.1, max: 90 })] });
  r.register({
    name: 'WorldEnvironment',
    base: 'Node',
    ctor: D.WorldEnvironment,
    category: '3D',
    dimension: null,
    icon: 'globe',
    description: 'Background colour, ambient light and fog for the 3D world.',
    properties: [c('backgroundColor', '#3a4150'), c('ambientColor', '#ffffff'), f('ambientEnergy', 0.4, { min: 0, max: 16 }), b('fogEnabled', false, { group: 'Fog' }), c('fogColor', '#3a4150', { group: 'Fog' }), f('fogDensity', 0.02, { min: 0, max: 1, group: 'Fog' })],
  });

  // Physics 3D
  r.register({ name: 'CollisionObject3D', base: 'Node3D', ctor: P.CollisionObject3D as unknown as new () => Node, category: 'Physics 3D', dimension: '3d', icon: 'shapes', description: 'Base of 3D bodies and areas.', properties: layers('Collision'), abstract: true });
  r.register({ name: 'StaticBody3D', base: 'CollisionObject3D', ctor: P.StaticBody3D, category: 'Physics 3D', dimension: '3d', icon: 'square', description: 'A body that never moves: floors, walls, terrain.', properties: [f('friction', 1, { min: 0, max: 10 }), f('bounce', 0, { min: 0, max: 1 })], warnings: needsShapes3D });
  r.register({
    name: 'RigidBody3D',
    base: 'CollisionObject3D',
    ctor: P.RigidBody3D,
    category: 'Physics 3D',
    dimension: '3d',
    icon: 'box',
    description: 'A body moved by the physics simulation.',
    properties: [
      f('mass', 1, { min: 0.001, max: 100000 }),
      f('gravityScale', 1, { min: -100, max: 100 }),
      v3('linearVelocity', [0, 0, 0], { group: 'Velocity' }),
      v3('angularVelocity', [0, 0, 0], { group: 'Velocity' }),
      f('linearDamp', 0, { min: 0, max: 100, group: 'Damping' }),
      f('angularDamp', 0, { min: 0, max: 100, group: 'Damping' }),
      f('friction', 1, { min: 0, max: 10 }),
      f('bounce', 0, { min: 0, max: 1 }),
      b('lockRotation', false),
      b('freeze', false),
      b('contactMonitor', false, { hint: 'Emit bodyEntered/bodyExited' }),
    ],
    warnings: needsShapes3D,
  });
  r.register({
    name: 'CharacterBody3D',
    base: 'CollisionObject3D',
    ctor: P.CharacterBody3D,
    category: 'Physics 3D',
    dimension: '3d',
    icon: 'person-standing',
    description: 'A body moved by script with moveAndSlide(): players and NPCs.',
    properties: [v3('velocity', [0, 0, 0], { hint: 'Metres per second' }), v3('upDirection', [0, 1, 0]), f('floorMaxAngle', degToRad(45), { degrees: true, min: 0, max: Math.PI / 2 }), f('floorSnapLength', 0.1, { min: 0, max: 4 })],
    warnings: needsShapes3D,
  });
  r.register({ name: 'Area3D', base: 'CollisionObject3D', ctor: P.Area3D, category: 'Physics 3D', dimension: '3d', icon: 'scan', description: 'Detects bodies entering and leaving it.', properties: [b('monitoring', true)], warnings: needsShapes3D });
  r.register({
    name: 'CollisionShape3D',
    base: 'Node3D',
    ctor: P.CollisionShape3D,
    category: 'Physics 3D',
    dimension: '3d',
    icon: 'square-dashed',
    description: 'Gives its parent body or area a shape.',
    properties: [{ name: 'shape', type: 'shape3d', default: { type: 'box', size: [1, 1, 1] }, nullable: true }, b('disabled', false)],
    warnings: (ctx) => [...(ctx.parentType && ctx.isA(ctx.parentType, 'CollisionObject3D') ? [] : ['Only works as a direct child of a StaticBody3D, RigidBody3D, CharacterBody3D or Area3D.']), ...(ctx.node.props?.shape === null ? ['Has no shape.'] : [])],
  });

  // Utility & audio
  r.register({
    name: 'Timer',
    base: 'Node',
    ctor: M.Timer,
    category: 'Utility',
    dimension: null,
    icon: 'timer',
    description: 'Emits timeout after a delay, once or repeatedly.',
    properties: [f('waitTime', 1, { min: 0.001, max: 86400, hint: 'Seconds' }), b('oneShot', false), b('autostart', false), e('processCallback', 'idle', ['idle', 'physics']), b('paused', false)],
  });
  r.register({
    name: 'AudioStreamPlayer',
    base: 'Node',
    ctor: M.AudioStreamPlayer,
    category: 'Audio',
    dimension: null,
    icon: 'volume-2',
    description: 'Plays a sound or music track.',
    properties: [{ name: 'stream', type: 'resource', resource: 'audio', default: null, nullable: true }, f('volumeDb', 0, { min: -80, max: 24 }), f('pitchScale', 1, { min: 0.01, max: 4 }), b('autoplay', false), b('loop', false)],
  });
}

/** The default registry with all built-in node types. */
export const nodeTypes = new NodeRegistry();
registerBuiltinTypes(nodeTypes);
