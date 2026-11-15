/**
 * Registrations for the extended node set: markers, lines, paths, particles, 2D lights, parallax,
 * notifiers, tile maps, ray casts, animatable bodies, positional audio, UI controls, 3D sprites and
 * text, and AnimationPlayer. Kept apart from registry.ts so the core set stays easy to read.
 */
import type { Node } from './node';
import type { PropDef } from './properties';
import type { ConfigWarningContext, NodeRegistry } from './registry';
import { CanvasLayer } from './nodes2d';
import * as X from './nodes2d-extra';
import * as X3 from './nodes3d-extra';
import * as P from './physics';
import * as UI from './nodes-ui';
import { CPUParticles2D, CPUParticles3D } from './nodes-particles';
import { TileMapLayer } from './nodes-tilemap';
import { AnimationPlayer } from './nodes-animation';
import { AudioStreamPlayer2D, AudioStreamPlayer3D } from './nodes-audio';

const f = (name: string, def: number, extra: Partial<PropDef> = {}): PropDef => ({ name, type: 'float', default: def, ...extra });
const i = (name: string, def: number, extra: Partial<PropDef> = {}): PropDef => ({ name, type: 'int', default: def, step: 1, ...extra });
const b = (name: string, def: boolean, extra: Partial<PropDef> = {}): PropDef => ({ name, type: 'bool', default: def, ...extra });
const s = (name: string, def: string, extra: Partial<PropDef> = {}): PropDef => ({ name, type: 'string', default: def, ...extra });
const v2 = (name: string, def: [number, number], extra: Partial<PropDef> = {}): PropDef => ({ name, type: 'vector2', default: def, ...extra });
const v3 = (name: string, def: [number, number, number], extra: Partial<PropDef> = {}): PropDef => ({ name, type: 'vector3', default: def, ...extra });
const c = (name: string, def: string, extra: Partial<PropDef> = {}): PropDef => ({ name, type: 'color', default: def, ...extra });
const e = (name: string, def: string, options: readonly string[], extra: Partial<PropDef> = {}): PropDef => ({ name, type: 'enum', default: def, options, ...extra });
const tex = (name: string, extra: Partial<PropDef> = {}): PropDef => ({ name, type: 'resource', resource: 'texture', default: null, nullable: true, ...extra });
const audio = (): PropDef => ({ name: 'stream', type: 'resource', resource: 'audio', default: null, nullable: true });

const MAX_LAYER = 0xffffffff;
const H_ALIGN = ['left', 'center', 'right'] as const;
const V_ALIGN = ['top', 'center', 'bottom'] as const;

const ctor = <T>(cls: T) => cls as unknown as new () => Node;

/** Ray-cast warnings shared by RayCast2D and RayCast3D. */
const rayWarnings = (ctx: ConfigWarningContext) => {
  const p = ctx.node.props ?? {};
  const out: string[] = [];
  if (p.collisionMask === 0) out.push('collisionMask is 0, so the ray cannot hit anything. Set at least one layer.');
  if (p.collideWithBodies === false && p.collideWithAreas !== true) out.push('collideWithBodies and collideWithAreas are both off, so the ray cannot hit anything.');
  if (p.enabled === false) out.push('Disabled: it only casts when you call forceRaycastUpdate().');
  return out;
};

/** Particle settings shared by the 2D and 3D emitters (2D units in pixels, 3D in metres). */
function particleProps(threeD: boolean): PropDef[] {
  const g = 'Emission';
  return [
    b('emitting', true, { group: g }),
    i('amount', 8, { min: 1, max: 10000, group: g, hint: 'Particles alive at most (emitted once per lifetime)' }),
    f('lifetime', 1, { min: 0.01, max: 600, group: g, hint: 'Seconds each particle lives' }),
    b('oneShot', false, { group: g, hint: 'Emit one burst, then stop (emits finished)' }),
    f('explosiveness', 0, { min: 0, max: 1, step: 0.05, group: g, hint: '0 = steady stream, 1 = all at once' }),
    f('randomness', 0, { min: 0, max: 1, step: 0.05, group: g, hint: 'Random reduction of each lifetime' }),
    f('preprocess', 0, { min: 0, max: 60, group: g, hint: 'Seconds simulated before the first frame' }),
    f('speedScale', 1, { min: 0, max: 64, step: 0.1, group: g }),
    b('localCoords', false, { group: g, hint: 'Particles move with the emitter (off: they stay where emitted)' }),
    e('emissionShape', 'point', ['point', 'sphere', 'box'], { group: 'Shape' }),
    f('emissionSphereRadius', threeD ? 1 : 16, { min: 0, max: threeD ? 1000 : 100000, group: 'Shape' }),
    threeD ? v3('emissionBoxExtents', [1, 1, 1], { group: 'Shape', hint: 'Half size of the box' }) : v2('emissionRectExtents', [16, 16], { group: 'Shape', hint: 'Half size of the rectangle' }),
    threeD ? v3('direction', [1, 0, 0], { group: 'Motion', step: 0.1 }) : v2('direction', [1, 0], { group: 'Motion', step: 0.1 }),
    f('spread', 45, { min: 0, max: 180, group: 'Motion', hint: 'Degrees either side of the direction' }),
    threeD ? v3('gravity', [0, -9.8, 0], { group: 'Motion', hint: 'm/s², world space' }) : v2('gravity', [0, 980], { group: 'Motion', hint: 'px/s², world space' }),
    f('initialVelocityMin', 0, { min: 0, max: 100000, group: 'Motion' }),
    f('initialVelocityMax', 0, { min: 0, max: 100000, group: 'Motion' }),
    f('damping', 0, { min: 0, max: 100000, group: 'Motion', hint: 'Slows particles down (units/s²)' }),
    f('scaleAmountMin', 1, { min: 0, max: 1000, step: 0.1, group: 'Look' }),
    f('scaleAmountMax', 1, { min: 0, max: 1000, step: 0.1, group: 'Look' }),
    ...(threeD ? [f('particleSize', 0.1, { min: 0.001, max: 100, step: 0.01, group: 'Look', hint: 'Width at scale 1, metres' })] : []),
    c('color', '#ffffff', { group: 'Look', hint: 'Colour at birth' }),
    c('colorEnd', '#ffffff', { group: 'Look', hint: 'Colour at death (alpha 0 to fade out)' }),
    tex('texture', { group: 'Look', hint: threeD ? 'Optional; default is a soft dot' : 'Optional; default is an 8 px dot' }),
  ];
}

export function registerExtraTypes(r: NodeRegistry) {
  // --- 2D ---------------------------------------------------------------------------------------------------------
  r.register({
    name: 'CanvasLayer',
    base: 'Node',
    ctor: CanvasLayer,
    category: '2D',
    dimension: '2d',
    icon: 'layers',
    description: 'Draws its children on their own layer, ignoring the camera: HUDs, menus, fixed backgrounds.',
    properties: [i('layer', 1, { min: -128, max: 128, hint: 'Draw order; the game world is 0, negative goes behind it' }), b('visible', true), v2('offset', [0, 0], { group: 'Transform' }), f('rotation', 0, { degrees: true, group: 'Transform' }), v2('scale', [1, 1], { step: 0.1, group: 'Transform' })],
  });
  r.register({ name: 'Marker2D', base: 'Node2D', ctor: X.Marker2D, category: '2D', dimension: '2d', icon: 'crosshair', description: 'A named position (spawn points, targets). Shows a cross in the editor only.', properties: [f('gizmoExtents', 10, { min: 1, max: 1000, hint: 'Size of the editor cross' })] });
  r.register({
    name: 'Line2D',
    base: 'Node2D',
    ctor: X.Line2D,
    category: '2D',
    dimension: '2d',
    icon: 'spline',
    description: 'A polyline with a width: trails, lasers, ropes, outlines.',
    properties: [
      { name: 'points', type: 'vector2[]', default: [[-64, 0], [64, 0]], minItems: 0, hint: 'Points in local pixels' },
      f('width', 10, { min: 0, max: 1000 }),
      c('defaultColor', '#6680ff'),
      b('closed', false, { hint: 'Join the last point back to the first' }),
      e('jointMode', 'sharp', ['sharp', 'bevel', 'round'], { group: 'Style' }),
      e('capMode', 'none', ['none', 'box', 'round'], { group: 'Style', hint: 'Shape of both ends' }),
    ],
  });
  r.register({
    name: 'Path2D',
    base: 'Node2D',
    ctor: X.Path2D,
    category: '2D',
    dimension: '2d',
    icon: 'route',
    description: 'A path for PathFollow2D children to move along (patrols, moving platforms). Drawn in the editor only.',
    properties: [{ name: 'points', type: 'vector2[]', default: [[0, 0], [128, 0], [128, 128]], minItems: 2, hint: 'Points in local pixels' }, b('closed', false, { hint: 'Loop back to the first point' }), b('curved', false, { hint: 'Smooth corners (Catmull-Rom spline)' })],
  });
  r.register({
    name: 'PathFollow2D',
    base: 'Node2D',
    ctor: X.PathFollow2D,
    category: '2D',
    dimension: '2d',
    icon: 'navigation',
    description: 'Moves itself and its children along the parent Path2D. Animate progress (or progressRatio from scripts).',
    properties: [f('progress', 0, { hint: 'Pixels along the path' }), f('hOffset', 0, { hint: 'Offset along the path' }), f('vOffset', 0, { hint: 'Offset across the path' }), b('rotates', true, { hint: 'Turn to face along the path' }), b('loop', true, { hint: 'Wrap around at the end' })],
    warnings: (ctx) => (ctx.parentType && ctx.isA(ctx.parentType, 'Path2D') ? [] : ['Only works as a direct child of a Path2D.']),
  });
  r.register({
    name: 'CPUParticles2D',
    base: 'Node2D',
    ctor: CPUParticles2D,
    category: '2D',
    dimension: '2d',
    icon: 'sparkles',
    description: 'Particle effects: sparks, smoke, dust, explosions, trails. Simulated on the CPU.',
    properties: particleProps(false),
    warnings: (ctx) => {
      const p = ctx.node.props ?? {};
      const vmax = typeof p.initialVelocityMax === 'number' ? p.initialVelocityMax : 0;
      const vmin = typeof p.initialVelocityMin === 'number' ? p.initialVelocityMin : 0;
      return vmin > vmax ? ['initialVelocityMin is larger than initialVelocityMax.'] : [];
    },
  });
  r.register({ name: 'CanvasModulate', base: 'Node2D', ctor: X.CanvasModulate, category: '2D', dimension: '2d', icon: 'contrast', description: 'Tints the whole 2D world (not CanvasLayers). Darken it, then light it with PointLight2D.', properties: [c('color', '#ffffff')] });
  r.register({
    name: 'PointLight2D',
    base: 'Node2D',
    ctor: X.PointLight2D,
    category: '2D',
    dimension: '2d',
    icon: 'lamp',
    description: 'A soft light that brightens the 2D world around it (shows best with a darkening CanvasModulate).',
    properties: [b('enabled', true), c('color', '#ffffff'), f('energy', 1, { min: 0, max: 16, step: 0.1 }), f('range', 128, { min: 1, max: 100000, hint: 'Radius in pixels (without a texture)' }), tex('texture', { hint: 'Optional light shape (white = lit); default is a soft circle' }), f('textureScale', 1, { min: 0.01, max: 100, step: 0.1 })],
  });
  r.register({
    name: 'Parallax2D',
    base: 'Node2D',
    ctor: X.Parallax2D,
    category: '2D',
    dimension: '2d',
    icon: 'mountain',
    description: 'A parallax background layer: children scroll slower or faster than the camera and can repeat endlessly.',
    properties: [
      v2('scrollScale', [1, 1], { step: 0.05, hint: 'Camera speed multiplier: 0.5 = half as fast (far away), 0 = fixed' }),
      v2('scrollOffset', [0, 0]),
      v2('repeatSize', [0, 0], { hint: 'Repeat the children every this many pixels (0 = no repeat); use the art’s width for endless backgrounds' }),
      v2('autoscroll', [0, 0], { hint: 'Constant scrolling, px/s' }),
    ],
  });
  r.register({
    name: 'VisibleOnScreenNotifier2D',
    base: 'Node2D',
    ctor: X.VisibleOnScreenNotifier2D,
    category: '2D',
    dimension: '2d',
    icon: 'scan-eye',
    description: 'Emits screenEntered / screenExited when its rectangle enters or leaves the screen.',
    properties: [v2('rectPosition', [-10, -10], { hint: 'Top-left of the rectangle (local pixels)' }), v2('rectSize', [20, 20], { hint: 'Size of the rectangle' })],
    warnings: (ctx) => {
      const sz = ctx.node.props?.rectSize;
      return Array.isArray(sz) && (Number(sz[0]) <= 0 || Number(sz[1]) <= 0) ? ['The rectangle has no area, so it is never on screen.'] : [];
    },
  });
  r.register({
    name: 'TileMapLayer',
    base: 'CollisionObject2D',
    ctor: TileMapLayer,
    category: '2D',
    dimension: '2d',
    icon: 'grid-3x3',
    description: 'A grid of tiles cut from an atlas texture, with optional per-tile collision. Paint tiles in the 2D viewport.',
    properties: [
      tex('tileSet', { group: 'Tiles', hint: 'Atlas texture, split into tileSize cells. Without one, tiles are coloured squares' }),
      v2('tileSize', [16, 16], { group: 'Tiles', step: 1, hint: 'Pixels per tile' }),
      { name: 'cells', type: 'json', jsonKind: 'tilecells', default: [], group: 'Tiles', hint: 'Flat list, four integers per tile: x, y, atlasX, atlasY' },
      b('collisionEnabled', true, { group: 'Collision', hint: 'Tiles are solid' }),
      { name: 'solidTiles', type: 'vector2[]', default: [], minItems: 0, group: 'Collision', hint: 'Atlas coordinates of the tiles that collide (empty = all)' },
      f('friction', 1, { min: 0, max: 10, group: 'Collision' }),
      f('bounce', 0, { min: 0, max: 1, group: 'Collision' }),
    ],
  });

  // --- Physics 2D ----------------------------------------------------------------------------------------------------
  r.register({
    name: 'AnimatableBody2D',
    base: 'StaticBody2D',
    ctor: P.AnimatableBody2D,
    category: 'Physics 2D',
    dimension: '2d',
    icon: 'move-horizontal',
    description: 'A body you move yourself (script, tween, AnimationPlayer, PathFollow2D): moving platforms and doors. Carries characters standing on it.',
    properties: [],
  });
  r.register({
    name: 'RayCast2D',
    base: 'Node2D',
    ctor: P.RayCast2D,
    category: 'Physics 2D',
    dimension: '2d',
    icon: 'radar',
    description: 'Casts a ray every physics tick and reports the first body it hits (ground checks, line of sight).',
    properties: [
      b('enabled', true),
      v2('targetPosition', [0, 50], { hint: 'End of the ray, local pixels' }),
      i('collisionMask', 1, { min: 0, max: MAX_LAYER, hint: 'Layers the ray can hit' }),
      b('excludeParent', true, { hint: 'Ignore the body this ray belongs to' }),
      b('collideWithBodies', true),
      b('collideWithAreas', false),
      b('hitFromInside', false, { hint: 'Report a hit when the ray starts inside a shape' }),
    ],
    warnings: rayWarnings,
  });

  // --- UI ----------------------------------------------------------------------------------------------------------------
  const notUnderNode2D = (ctx: ConfigWarningContext) =>
    ctx.parentType && ctx.isA(ctx.parentType, 'Node2D') && !ctx.isA(ctx.parentType, 'Control') ? ['A Control under a Node2D is drawn in the game world and moves with the camera. Put HUD and menu controls under a CanvasLayer.'] : [];
  r.register({
    name: 'Control',
    base: 'Node2D',
    ctor: UI.Control,
    category: 'UI',
    dimension: '2d',
    icon: 'square-dashed-mouse-pointer',
    description: 'Base of UI nodes: a rectangle placed by anchors (layoutPreset) or by a parent container.',
    properties: [
      v2('size', [0, 0], { group: 'Layout', hint: 'Requested size; never smaller than the content' }),
      e('layoutPreset', 'topLeft', UI.LAYOUT_PRESETS, { group: 'Layout', hint: 'Anchor in the parent: position offsets the matching point (corner, edge or centre); "Wide"/"fullRect" stretch' }),
      v2('pivotOffset', [0, 0], { group: 'Layout', hint: 'Rotate and scale around this point' }),
      e('sizeFlagsHorizontal', 'fill', UI.SIZE_FLAGS, { group: 'Container sizing', hint: 'Inside a container: fill, take extra space (expandFill), or keep the minimum size' }),
      e('sizeFlagsVertical', 'fill', UI.SIZE_FLAGS, { group: 'Container sizing' }),
      e('mouseFilter', 'stop', ['stop', 'pass', 'ignore'], { group: 'Mouse', hint: 'stop: takes clicks/taps · pass: takes them and lets controls below see them · ignore: click-through' }),
    ],
    warnings: notUnderNode2D,
  });
  r.register({ name: 'ColorRect', base: 'Control', ctor: UI.ColorRect, category: 'UI', dimension: '2d', icon: 'paint-bucket', description: 'A filled rectangle (backgrounds, overlays, simple bars).', properties: [c('color', '#ffffff')], overrides: { size: { default: [100, 100] } } });
  r.register({
    name: 'Panel',
    base: 'Control',
    ctor: UI.Panel,
    category: 'UI',
    dimension: '2d',
    icon: 'panel-top',
    description: 'A background box with border and rounded corners.',
    properties: [c('bgColor', '#262b36'), c('borderColor', '#5b6478'), i('borderWidth', 0, { min: 0, max: 64 }), i('cornerRadius', 4, { min: 0, max: 512 })],
    overrides: { size: { default: [200, 120] } },
  });
  r.register({
    name: 'Label',
    base: 'Control',
    ctor: UI.Label,
    category: 'UI',
    dimension: '2d',
    icon: 'case-sensitive',
    description: 'UI text, aligned within its rectangle (scores, titles, dialogue).',
    properties: [
      { name: 'text', type: 'multiline', default: 'Label' },
      i('fontSize', 16, { min: 1, max: 512 }),
      c('fontColor', '#ffffff'),
      e('horizontalAlignment', 'left', H_ALIGN),
      e('verticalAlignment', 'top', V_ALIGN),
      b('autowrap', false, { hint: 'Wrap lines at the width' }),
      i('outlineSize', 0, { min: 0, max: 64, group: 'Outline' }),
      c('outlineColor', '#000000', { group: 'Outline' }),
    ],
    overrides: { mouseFilter: { default: 'ignore' } },
  });
  r.register({
    name: 'Button',
    base: 'Control',
    ctor: UI.Button,
    category: 'UI',
    dimension: '2d',
    icon: 'mouse-pointer-click',
    description: 'A button for mouse and touch. Connect its pressed signal.',
    properties: [
      s('text', 'Button'),
      b('disabled', false),
      b('toggleMode', false, { hint: 'Stays pressed until clicked again; emits toggled' }),
      b('buttonPressed', false, { hint: 'Toggle state' }),
      b('flat', false, { hint: 'No background until hovered or pressed' }),
      e('horizontalAlignment', 'center', H_ALIGN),
      i('fontSize', 16, { min: 1, max: 512, group: 'Style' }),
      c('fontColor', '#ffffff', { group: 'Style' }),
      c('color', '#3d4455', { group: 'Style', hint: 'Background' }),
      c('hoverColor', '#4b5468', { group: 'Style' }),
      c('pressedColor', '#2b303c', { group: 'Style' }),
      c('borderColor', '#5b6478', { group: 'Style' }),
      i('borderWidth', 1, { min: 0, max: 64, group: 'Style' }),
      i('cornerRadius', 4, { min: 0, max: 512, group: 'Style' }),
    ],
  });
  r.register({
    name: 'TextureRect',
    base: 'Control',
    ctor: UI.TextureRect,
    category: 'UI',
    dimension: '2d',
    icon: 'image',
    description: 'A texture in the UI: icons, portraits, backgrounds.',
    properties: [tex('texture'), e('stretchMode', 'scale', ['scale', 'tile', 'keep', 'keepCentered', 'keepAspect', 'keepAspectCentered', 'keepAspectCovered']), e('expandMode', 'keepSize', ['keepSize', 'ignoreSize'], { hint: 'keepSize: never smaller than the texture' }), b('flipH', false), b('flipV', false)],
    overrides: { mouseFilter: { default: 'pass' } },
  });
  r.register({
    name: 'ProgressBar',
    base: 'Control',
    ctor: UI.ProgressBar,
    category: 'UI',
    dimension: '2d',
    icon: 'rectangle-horizontal',
    description: 'A bar filled by value between min and max: health, loading, cooldowns.',
    properties: [
      f('minValue', 0),
      f('maxValue', 100),
      f('value', 0),
      f('step', 0.01, { min: 0, hint: 'Round the value to this (0 = no rounding)' }),
      b('showPercentage', true),
      e('fillMode', 'beginToEnd', ['beginToEnd', 'endToBegin', 'topToBottom', 'bottomToTop']),
      c('bgColor', '#262b36', { group: 'Style' }),
      c('fillColor', '#4f8cff', { group: 'Style' }),
      c('fontColor', '#ffffff', { group: 'Style' }),
      i('fontSize', 14, { min: 1, max: 512, group: 'Style' }),
    ],
    overrides: { size: { default: [200, 24] } },
  });
  r.register({ name: 'Container', base: 'Control', ctor: ctor(UI.Container), category: 'UI', dimension: '2d', icon: 'frame', description: 'Base of layout containers.', properties: [], abstract: true, overrides: { mouseFilter: { default: 'pass' } } });
  const box = (vertical: boolean): PropDef[] => [i('separation', 4, { min: 0, max: 4096, hint: 'Gap between children' }), e('alignment', 'begin', ['begin', 'center', 'end'], { hint: vertical ? 'Where children sit vertically when none expands' : 'Where children sit horizontally when none expands' })];
  r.register({ name: 'HBoxContainer', base: 'Container', ctor: UI.HBoxContainer, category: 'UI', dimension: '2d', icon: 'columns-3', description: 'Lines its children up in a row (toolbars, HUD rows).', properties: box(false) });
  r.register({ name: 'VBoxContainer', base: 'Container', ctor: UI.VBoxContainer, category: 'UI', dimension: '2d', icon: 'rows-3', description: 'Stacks its children in a column (menus, lists).', properties: box(true) });
  r.register({
    name: 'MarginContainer',
    base: 'Container',
    ctor: UI.MarginContainer,
    category: 'UI',
    dimension: '2d',
    icon: 'frame',
    description: 'Keeps its children inside margins (padding).',
    properties: [i('marginLeft', 0, { min: -4096, max: 4096 }), i('marginTop', 0, { min: -4096, max: 4096 }), i('marginRight', 0, { min: -4096, max: 4096 }), i('marginBottom', 0, { min: -4096, max: 4096 })],
  });
  r.register({ name: 'CenterContainer', base: 'Container', ctor: UI.CenterContainer, category: 'UI', dimension: '2d', icon: 'scaling', description: 'Centres its children (title screens, dialogs).', properties: [] });

  // --- 3D -----------------------------------------------------------------------------------------------------------------
  r.register({ name: 'Marker3D', base: 'Node3D', ctor: X3.Marker3D, category: '3D', dimension: '3d', icon: 'crosshair', description: 'A named position (spawn points, targets). Shows axes in the editor only.', properties: [f('gizmoExtents', 0.25, { min: 0.01, max: 100, step: 0.05 })] });
  r.register({
    name: 'SpriteBase3D',
    base: 'Node3D',
    ctor: ctor(X3.SpriteBase3D),
    category: '3D',
    dimension: '3d',
    icon: 'image',
    description: 'Base of Sprite3D and Label3D.',
    abstract: true,
    properties: [
      f('pixelSize', 0.01, { min: 0.0001, max: 128, step: 0.001, hint: 'Metres per pixel' }),
      e('billboard', 'disabled', ['disabled', 'enabled', 'yBillboard'], { hint: 'Always face the camera (yBillboard: only turn around Y)' }),
      b('centered', true, { group: 'Offset' }),
      v2('offset', [0, 0], { group: 'Offset', hint: 'Pixels' }),
      b('flipH', false, { group: 'Offset' }),
      b('flipV', false, { group: 'Offset' }),
      c('modulate', '#ffffff', { group: 'Look' }),
      b('shaded', false, { group: 'Look', hint: 'Affected by lights' }),
      b('doubleSided', true, { group: 'Look' }),
      b('noDepthTest', false, { group: 'Look', hint: 'Draw on top of everything' }),
    ],
  });
  r.register({
    name: 'Sprite3D',
    base: 'SpriteBase3D',
    ctor: X3.Sprite3D,
    category: '3D',
    dimension: '3d',
    icon: 'image',
    description: 'A 2D image in 3D space (pickups, foliage, retro characters). Supports sprite sheets.',
    properties: [tex('texture', { group: 'Texture' }), i('hframes', 1, { min: 1, max: 256, group: 'Animation' }), i('vframes', 1, { min: 1, max: 256, group: 'Animation' }), i('frame', 0, { min: 0, max: 65535, group: 'Animation' })],
  });
  r.register({
    name: 'Label3D',
    base: 'SpriteBase3D',
    ctor: X3.Label3D,
    category: '3D',
    dimension: '3d',
    icon: 'type',
    description: 'Text in 3D space: name tags, signs, damage numbers.',
    properties: [{ name: 'text', type: 'multiline', default: 'Label' }, i('fontSize', 32, { min: 1, max: 512 }), e('horizontalAlignment', 'center', H_ALIGN), i('outlineSize', 12, { min: 0, max: 127 }), c('outlineColor', '#000000')],
    overrides: { pixelSize: { default: 0.005 } },
  });
  r.register({
    name: 'Path3D',
    base: 'Node3D',
    ctor: X3.Path3D,
    category: '3D',
    dimension: '3d',
    icon: 'route',
    description: 'A 3D path for PathFollow3D children (rails, flight paths, patrols). Drawn in the editor only.',
    properties: [{ name: 'points', type: 'vector3[]', default: [[0, 0, 0], [2, 0, 0], [2, 0, -2]], minItems: 2, hint: 'Points in local metres' }, b('closed', false), b('curved', false, { hint: 'Smooth corners (Catmull-Rom spline)' })],
  });
  r.register({
    name: 'PathFollow3D',
    base: 'Node3D',
    ctor: X3.PathFollow3D,
    category: '3D',
    dimension: '3d',
    icon: 'navigation',
    description: 'Moves itself and its children along the parent Path3D, facing along it (-Z forward).',
    properties: [f('progress', 0, { step: 0.1, hint: 'Metres along the path' }), f('hOffset', 0, { step: 0.1 }), f('vOffset', 0, { step: 0.1 }), e('rotationMode', 'oriented', ['none', 'y', 'oriented'], { hint: 'none: keep rotation · y: turn around Y only · oriented: follow the path fully' }), b('loop', true)],
    warnings: (ctx) => (ctx.parentType && ctx.isA(ctx.parentType, 'Path3D') ? [] : ['Only works as a direct child of a Path3D.']),
  });
  r.register({ name: 'CPUParticles3D', base: 'Node3D', ctor: CPUParticles3D, category: '3D', dimension: '3d', icon: 'sparkles', description: 'Particle effects in 3D: sparks, smoke, fire, magic. Camera-facing dots or a texture.', properties: particleProps(true) });
  r.register({
    name: 'VisibleOnScreenNotifier3D',
    base: 'Node3D',
    ctor: X3.VisibleOnScreenNotifier3D,
    category: '3D',
    dimension: '3d',
    icon: 'scan-eye',
    description: 'Emits screenEntered / screenExited when its box enters or leaves the current camera’s view.',
    properties: [v3('aabbPosition', [-1, -1, -1], { step: 0.1, hint: 'Corner of the box (local metres)' }), v3('aabbSize', [2, 2, 2], { step: 0.1 })],
  });

  // --- Physics 3D ------------------------------------------------------------------------------------------------------
  r.register({ name: 'AnimatableBody3D', base: 'StaticBody3D', ctor: P.AnimatableBody3D, category: 'Physics 3D', dimension: '3d', icon: 'move-horizontal', description: 'A body you move yourself (script, tween, AnimationPlayer, PathFollow3D): lifts, platforms, doors. Carries characters.', properties: [] });
  r.register({
    name: 'RayCast3D',
    base: 'Node3D',
    ctor: P.RayCast3D,
    category: 'Physics 3D',
    dimension: '3d',
    icon: 'radar',
    description: 'Casts a ray every physics tick and reports the first body it hits.',
    properties: [
      b('enabled', true),
      v3('targetPosition', [0, -1, 0], { step: 0.1, hint: 'End of the ray, local metres' }),
      i('collisionMask', 1, { min: 0, max: MAX_LAYER }),
      b('excludeParent', true),
      b('collideWithBodies', true),
      b('collideWithAreas', false),
      b('hitFromInside', false),
    ],
    warnings: rayWarnings,
  });

  // --- Audio --------------------------------------------------------------------------------------------------------------
  const playback = (): PropDef[] => [audio(), f('volumeDb', 0, { min: -80, max: 24 }), f('pitchScale', 1, { min: 0.01, max: 4 }), b('autoplay', false), b('loop', false)];
  r.register({
    name: 'AudioStreamPlayer2D',
    base: 'Node2D',
    ctor: AudioStreamPlayer2D,
    category: 'Audio',
    dimension: '2d',
    icon: 'audio-lines',
    description: 'A sound in the 2D world: quieter further from the camera and panned left/right.',
    properties: [...playback(), f('maxDistance', 2000, { min: 1, max: 1e6, group: 'Attenuation', hint: 'Silent beyond this many pixels' }), f('attenuation', 1, { min: 0.01, max: 16, step: 0.1, group: 'Attenuation', hint: 'Falloff curve exponent' }), f('panningStrength', 1, { min: 0, max: 1, step: 0.05, group: 'Attenuation' })],
  });
  r.register({
    name: 'AudioStreamPlayer3D',
    base: 'Node3D',
    ctor: AudioStreamPlayer3D,
    category: 'Audio',
    dimension: '3d',
    icon: 'speaker',
    description: 'A sound in the 3D world, attenuated by distance from the camera and panned.',
    properties: [
      ...playback(),
      e('attenuationModel', 'inverse', ['inverse', 'inverseSquare', 'logarithmic', 'disabled'], { group: 'Attenuation' }),
      f('unitSize', 10, { min: 0.1, max: 100, group: 'Attenuation', hint: 'Distance (m) at normal volume' }),
      f('maxDb', 3, { min: -24, max: 6, group: 'Attenuation', hint: 'Loudest when close' }),
      f('maxDistance', 0, { min: 0, max: 4096, group: 'Attenuation', hint: 'Silent beyond this (0 = no limit)' }),
      f('panningStrength', 1, { min: 0, max: 1, step: 0.05, group: 'Attenuation' }),
    ],
  });

  // --- Utility -----------------------------------------------------------------------------------------------------------
  r.register({
    name: 'AnimationPlayer',
    base: 'Node',
    ctor: AnimationPlayer,
    category: 'Utility',
    dimension: null,
    icon: 'clapperboard',
    description: 'Plays keyframed animations of any property (and method calls) on nodes under its parent.',
    properties: [
      {
        name: 'animations',
        type: 'json',
        jsonKind: 'animations',
        default: {},
        hint: 'name → { length, loop, tracks: [{ path, property | method, interpolation: linear|nearest|cubic, keys: [[time, value], …] }] }; paths relative to the parent',
      },
      s('autoplay', '', { hint: 'Animation to play when the scene starts' }),
      f('speedScale', 1, { min: -64, max: 64, step: 0.1 }),
      e('callbackMode', 'idle', ['idle', 'physics'], { hint: 'physics: advance on physics ticks (for animating bodies)' }),
    ],
    warnings: (ctx) => {
      const p = ctx.node.props ?? {};
      const anims = p.animations && typeof p.animations === 'object' && !Array.isArray(p.animations) ? Object.keys(p.animations) : [];
      return typeof p.autoplay === 'string' && p.autoplay && !anims.includes(p.autoplay) ? [`autoplay is "${p.autoplay}", but there is no animation with that name.`] : [];
    },
  });
}
