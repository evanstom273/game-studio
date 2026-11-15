/**
 * New projects. Every template is a working game: the 2D one is a small platformer, the 3D one
 * a character on a floor with physics crates. Both are built with the command layer, so they are
 * always valid documents.
 */
import { newId, sha256Hex } from '@gs/shared';
import { DEFAULT_SETTINGS, PROJECT_FORMAT, PROJECT_FORMAT_VERSION, type ProjectDoc } from './schema';
import { applyCommands, type Command } from './commands';
import { generateIconPng } from './png';

export type TemplateId = '2d-platformer' | '3d-starter' | 'empty-2d' | 'empty-3d';

export const TEMPLATES: { id: TemplateId; name: string; description: string }[] = [
  { id: '2d-platformer', name: '2D platformer', description: 'A character that runs and jumps on platforms. Arrow keys / WASD and Space.' },
  { id: '3d-starter', name: '3D starter', description: 'A capsule character, a floor, a sun and physics crates.' },
  { id: 'empty-2d', name: 'Empty 2D', description: 'One Node2D scene.' },
  { id: 'empty-3d', name: 'Empty 3D', description: 'One Node3D scene with a camera and a light.' },
];

export const PLAYER_2D_SCRIPT = `import { CharacterBody2D, Input } from 'gamestudio';

/** Platformer movement: ← → / A D to run, Space / ↑ / W to jump. */
export default class Player extends CharacterBody2D {
  static exports = {
    speed: { min: 0, max: 2000 },
    jumpVelocity: { min: -3000, max: 0 },
    gravity: { min: 0, max: 10000 },
  };

  speed = 320;
  jumpVelocity = -680;
  gravity = 1600;

  override _physicsProcess(delta: number) {
    const v = this.velocity;
    if (!this.isOnFloor()) v.y += this.gravity * delta;
    const jump = Input.isActionJustPressed('ui_accept') || Input.isActionJustPressed('ui_up');
    if (jump && this.isOnFloor()) v.y = this.jumpVelocity;
    v.x = Input.getAxis('ui_left', 'ui_right') * this.speed;
    this.moveAndSlide();

    // Fell off the world: start again.
    if (this.position.y > 1500) {
      this.position.set(576, 200);
      this.velocity.set(0, 0);
    }
  }
}
`;

export const PLAYER_3D_SCRIPT = `import { CharacterBody3D, Input } from 'gamestudio';

/** Walks with ← → ↑ ↓ / WASD, jumps with Space. */
export default class Player extends CharacterBody3D {
  static exports = ['speed', 'jumpVelocity', 'gravity'];

  speed = 5;
  jumpVelocity = 6;
  gravity = 16;

  override _physicsProcess(delta: number) {
    const v = this.velocity;
    if (!this.isOnFloor()) v.y -= this.gravity * delta;
    if (this.isOnFloor() && Input.isActionJustPressed('ui_accept')) v.y = this.jumpVelocity;
    const dir = Input.getVector('ui_left', 'ui_right', 'ui_up', 'ui_down');
    v.x = dir.x * this.speed;
    v.z = dir.y * this.speed;
    this.moveAndSlide();
    if (this.position.y < -20) this.position.set(0, 2, 0);
  }
}
`;

export const SPINNER_SCRIPT = `import { Node3D } from 'gamestudio';

/** Spins around the Y axis. */
export default class Spinner extends Node3D {
  static exports = { degreesPerSecond: { min: -720, max: 720 } };
  degreesPerSecond = 45;

  override _process(delta: number) {
    this.rotateY((this.degreesPerSecond * Math.PI / 180) * delta);
  }
}
`;

const MAIN = 'scenes/main.scene';
const ICON = 'icon.png';

function template2D(): Command[] {
  const s = MAIN;
  return [
    { op: 'create_scene', path: s, rootType: 'Node2D', rootName: 'Main' },
    { op: 'write_script', path: 'scripts/player.ts', source: PLAYER_2D_SCRIPT },
    { op: 'add_node', scene: s, type: 'Label2D', name: 'Hint', props: { position: [40, 32], text: '← → to run · Space to jump', fontSize: 22, color: '#cbd2de' } },
    { op: 'add_node', scene: s, type: 'CharacterBody2D', name: 'Player', ref: 'player', script: 'scripts/player.ts', props: { position: [576, 300] } },
    { op: 'add_node', scene: s, parent: '$player', type: 'Sprite2D', name: 'Sprite', props: { texture: ICON, scale: [0.5, 0.5] } },
    { op: 'add_node', scene: s, parent: '$player', type: 'CollisionShape2D', name: 'Shape', props: { shape: { type: 'rectangle', size: [52, 56] } } },
    { op: 'add_node', scene: s, type: 'StaticBody2D', name: 'Floor', ref: 'floor', props: { position: [576, 600] } },
    { op: 'add_node', scene: s, parent: '$floor', type: 'Polygon2D', name: 'Visual', props: { color: '#3b4357', polygon: [[-560, -24], [560, -24], [560, 24], [-560, 24]] } },
    { op: 'add_node', scene: s, parent: '$floor', type: 'CollisionShape2D', name: 'Shape', props: { shape: { type: 'rectangle', size: [1120, 48] } } },
    { op: 'add_node', scene: s, type: 'StaticBody2D', name: 'Platform', ref: 'plat', props: { position: [860, 430] } },
    { op: 'add_node', scene: s, parent: '$plat', type: 'Polygon2D', name: 'Visual', props: { color: '#4f8cff', polygon: [[-120, -12], [120, -12], [120, 12], [-120, 12]] } },
    { op: 'add_node', scene: s, parent: '$plat', type: 'CollisionShape2D', name: 'Shape', props: { shape: { type: 'rectangle', size: [240, 24] } } },
    { op: 'duplicate_node', scene: s, node: '$plat', name: 'Platform', ref: 'plat2' },
    { op: 'set_props', scene: s, node: '$plat2', props: { position: [300, 330] } },
    { op: 'set_main_scene', path: s },
  ];
}

function template3D(): Command[] {
  const s = MAIN;
  return [
    { op: 'create_scene', path: s, rootType: 'Node3D', rootName: 'Main' },
    { op: 'write_script', path: 'scripts/player.ts', source: PLAYER_3D_SCRIPT },
    { op: 'write_script', path: 'scripts/spinner.ts', source: SPINNER_SCRIPT },
    { op: 'add_node', scene: s, type: 'WorldEnvironment', name: 'Environment' },
    { op: 'add_node', scene: s, type: 'DirectionalLight3D', name: 'Sun', props: { rotationDegrees: [-50, 30, 0], shadowEnabled: true, energy: 1.4 } },
    { op: 'add_node', scene: s, type: 'Camera3D', name: 'Camera', props: { position: [0, 5, 9], rotationDegrees: [-28, 0, 0], current: true } },
    { op: 'add_node', scene: s, type: 'StaticBody3D', name: 'Floor', ref: 'floor' },
    { op: 'add_node', scene: s, parent: '$floor', type: 'MeshInstance3D', name: 'Mesh', props: { position: [0, -0.25, 0], mesh: { type: 'box', size: [20, 0.5, 20] }, material: { albedo: '#3b4357' } } },
    { op: 'add_node', scene: s, parent: '$floor', type: 'CollisionShape3D', name: 'Shape', props: { position: [0, -0.25, 0], shape: { type: 'box', size: [20, 0.5, 20] } } },
    { op: 'add_node', scene: s, type: 'CharacterBody3D', name: 'Player', ref: 'player', script: 'scripts/player.ts', props: { position: [0, 1, 0] } },
    { op: 'add_node', scene: s, parent: '$player', type: 'MeshInstance3D', name: 'Mesh', props: { mesh: { type: 'capsule', radius: 0.4, height: 1.6 }, material: { albedo: '#4f8cff', roughness: 0.5 } } },
    { op: 'add_node', scene: s, parent: '$player', type: 'CollisionShape3D', name: 'Shape', props: { shape: { type: 'capsule', radius: 0.4, height: 1.6 } } },
    { op: 'add_node', scene: s, type: 'RigidBody3D', name: 'Crate', ref: 'crate', props: { position: [2, 3, -1], rotationDegrees: [10, 20, 5] } },
    { op: 'add_node', scene: s, parent: '$crate', type: 'MeshInstance3D', name: 'Mesh', props: { material: { albedo: '#f5a524', roughness: 0.7 } } },
    { op: 'add_node', scene: s, parent: '$crate', type: 'CollisionShape3D', name: 'Shape' },
    { op: 'duplicate_node', scene: s, node: '$crate', ref: 'crate2' },
    { op: 'set_props', scene: s, node: '$crate2', props: { position: [-2.5, 5, 0.5] } },
    { op: 'add_node', scene: s, type: 'MeshInstance3D', name: 'Gem', script: 'scripts/spinner.ts', props: { position: [0, 2.5, -4], rotationDegrees: [35, 0, 45], mesh: { type: 'box', size: [0.8, 0.8, 0.8] }, material: { albedo: '#4ade80', emission: '#4ade80', emissionEnergy: 0.4 } } },
    { op: 'set_main_scene', path: s },
  ];
}

export interface NewProject {
  doc: ProjectDoc;
  /** Asset bytes by SHA-256 (store them with the project). */
  blobs: Map<string, Uint8Array>;
}

export function emptyProjectDoc(name: string, now = Date.now()): ProjectDoc {
  return {
    format: PROJECT_FORMAT,
    formatVersion: PROJECT_FORMAT_VERSION,
    id: newId('p'),
    name: name.trim() || 'New game',
    createdAt: now,
    updatedAt: now,
    settings: structuredClone(DEFAULT_SETTINGS),
    scenes: {},
    scripts: {},
    assets: {},
  };
}

export async function createProject(name: string, template: TemplateId = '2d-platformer'): Promise<NewProject> {
  const icon = generateIconPng(128);
  const hash = await sha256Hex(icon);
  const doc = emptyProjectDoc(name);
  const commands: Command[] = [{ op: 'add_asset', path: ICON, info: { kind: 'image', mime: 'image/png', size: icon.length, hash, width: 128, height: 128 } }];
  if (template === '2d-platformer') commands.push(...template2D());
  else if (template === '3d-starter') commands.push(...template3D());
  else if (template === 'empty-3d')
    commands.push(
      { op: 'create_scene', path: MAIN, rootType: 'Node3D', rootName: 'Main' },
      { op: 'add_node', scene: MAIN, type: 'DirectionalLight3D', name: 'Sun', props: { rotationDegrees: [-50, 30, 0] } },
      { op: 'add_node', scene: MAIN, type: 'Camera3D', name: 'Camera', props: { position: [0, 2, 6], rotationDegrees: [-15, 0, 0] } },
      { op: 'set_main_scene', path: MAIN },
    );
  else commands.push({ op: 'create_scene', path: MAIN, rootType: 'Node2D', rootName: 'Main' }, { op: 'set_main_scene', path: MAIN });
  const { project } = applyCommands(doc, commands);
  return { doc: { ...project, updatedAt: doc.createdAt }, blobs: new Map([[hash, icon]]) };
}
