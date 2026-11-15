/**
 * UI nodes (Godot's Control family): HUDs, menus and buttons.
 *
 * Differences from Godot, on purpose:
 *  - Control derives from Node2D (Godot: both derive from CanvasItem), so controls get position,
 *    rotation, scale, z index, visibility and modulate, interleave with 2D nodes, and the 2D
 *    editor tools work on them unchanged.
 *  - Anchoring uses a single `layoutPreset`. `position` is the offset of the control's anchored
 *    point (its top-left for "topLeft", its centre for "center", its bottom-right corner for
 *    "bottomRight"…). On a stretched axis (the "…Wide" presets and "fullRect") `position` is the
 *    inset from both edges and `size` is ignored on that axis.
 *  - `size` is the requested size; a control is never smaller than its content (getMinimumSize).
 *
 * Controls under a CanvasLayer are drawn in screen space; elsewhere they are part of the 2D canvas
 * (in a 3D game that is screen space too, since there is no 2D camera).
 *
 * Input: pointer events go to the topmost control under the pointer before any `_input` handler
 * runs. A control with mouseFilter "stop" consumes the press, so game actions bound to mouse
 * buttons don't fire and `_input` never sees it.
 */
import { Color, Rect2, Signal, Transform2D, Vector2 } from '@gs/shared';
import { Node } from './node';
import { Node2D } from './nodes2d';
import type { InputEvent, InputEventPointer } from './input';
import type { Texture } from './resources';
import type { SceneTree } from './scene-tree';

export type LayoutPreset = 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight' | 'centerLeft' | 'centerTop' | 'centerRight' | 'centerBottom' | 'center' | 'leftWide' | 'topWide' | 'rightWide' | 'bottomWide' | 'vcenterWide' | 'hcenterWide' | 'fullRect';

/** Anchors (left, top, right, bottom) as fractions of the parent area, like Godot's presets. */
export const LAYOUT_ANCHORS: Record<LayoutPreset, readonly [number, number, number, number]> = {
  topLeft: [0, 0, 0, 0],
  topRight: [1, 0, 1, 0],
  bottomLeft: [0, 1, 0, 1],
  bottomRight: [1, 1, 1, 1],
  centerLeft: [0, 0.5, 0, 0.5],
  centerTop: [0.5, 0, 0.5, 0],
  centerRight: [1, 0.5, 1, 0.5],
  centerBottom: [0.5, 1, 0.5, 1],
  center: [0.5, 0.5, 0.5, 0.5],
  leftWide: [0, 0, 0, 1],
  topWide: [0, 0, 1, 0],
  rightWide: [1, 0, 1, 1],
  bottomWide: [0, 1, 1, 1],
  vcenterWide: [0, 0.5, 1, 0.5],
  hcenterWide: [0.5, 0, 0.5, 1],
  fullRect: [0, 0, 1, 1],
};
export const LAYOUT_PRESETS = Object.keys(LAYOUT_ANCHORS) as LayoutPreset[];

/** How a control uses the space a container gives it on one axis. */
export type SizeFlag = 'fill' | 'expandFill' | 'shrinkBegin' | 'shrinkCenter' | 'shrinkEnd';
export const SIZE_FLAGS: readonly SizeFlag[] = ['fill', 'expandFill', 'shrinkBegin', 'shrinkCenter', 'shrinkEnd'];

/** stop: receives and consumes pointer presses · pass: receives them, controls below get them too · ignore: invisible to the pointer. */
export type MouseFilter = 'stop' | 'pass' | 'ignore';

export type HAlign = 'left' | 'center' | 'right';
export type VAlign = 'top' | 'center' | 'bottom';

/** Rough text size when no renderer has measured it (headless, first frame). */
export function estimateTextSize(text: string, fontSize: number): Vector2 {
  const lines = text.split('\n');
  return new Vector2(Math.max(0, ...lines.map((l) => l.length)) * fontSize * 0.55, lines.length * fontSize * 1.25);
}

let currentEvent: InputEvent | null = null;

/** Base of all UI nodes: a rectangle laid out by anchors or by a parent container. */
export class Control extends Node2D {
  static override readonly typeName: string = 'Control';
  /** Parent area for top-level controls when there's no running game (the editor sets the project's display size). */
  static editorViewportSize = new Vector2(1152, 648);

  size = new Vector2();
  layoutPreset: LayoutPreset = 'topLeft';
  /** Rotation and scale happen around this point (local pixels from the top-left). */
  pivotOffset = new Vector2();
  sizeFlagsHorizontal: SizeFlag = 'fill';
  sizeFlagsVertical: SizeFlag = 'fill';
  mouseFilter: MouseFilter = 'stop';

  readonly mouseEntered = new Signal<[]>('mouseEntered');
  readonly mouseExited = new Signal<[]>('mouseExited');
  /** Pointer events over this control (before _input). */
  readonly guiInput = new Signal<[event: InputEvent]>('guiInput');
  /** @internal maintained by the GUI router */
  __hovered = false;

  /** Override in scripts to handle pointer events on this control (Godot's _gui_input). */
  _guiInput(_event: InputEvent): void {}
  /** @internal Engine-side handling (buttons). `inside`: whether the pointer is over this control. */
  __gui(_event: InputEventPointer, _inside: boolean): void {}

  /** Marks the event being handled as consumed (Godot's accept_event). */
  acceptEvent() {
    if (currentEvent) currentEvent.handled = true;
  }

  /** The smallest size the content needs (text, children). */
  getMinimumSize(): Vector2 {
    return new Vector2();
  }
  /** max(size, minimum size): the size this control asks for. */
  getCombinedMinimumSize(): Vector2 {
    const m = this.getMinimumSize();
    return new Vector2(Math.max(this.size.x, m.x), Math.max(this.size.y, m.y));
  }

  /** Size of the area this control is anchored in: the parent control, or the viewport. */
  getParentAreaSize(): Vector2 {
    const p = this.parent;
    if (p instanceof Control) return p.getRect().size;
    return this.tree?.viewportSize.clone() ?? Control.editorViewportSize.clone();
  }

  /** The laid-out rectangle in the parent's space (before rotation and scale). */
  getRect(): Rect2 {
    const p = this.parent;
    if (p instanceof Container) {
      const r = p.__childRect(this);
      if (r) return r;
    }
    const area = this.getParentAreaSize();
    const want = this.getCombinedMinimumSize();
    const min = this.getMinimumSize();
    const [aL, aT, aR, aB] = LAYOUT_ANCHORS[this.layoutPreset] ?? LAYOUT_ANCHORS.topLeft;
    const axis = (a0: number, a1: number, len: number, pos: number, size: number, minLen: number): [number, number] => (a0 === a1 ? [a0 * len + pos - a0 * size, size] : [a0 * len + pos, Math.max(minLen, (a1 - a0) * len - 2 * pos)]);
    const [x, w] = axis(aL, aR, area.x, this.position.x, want.x, min.x);
    const [y, h] = axis(aT, aB, area.y, this.position.y, want.y, min.y);
    return new Rect2(x, y, Math.max(0, w), Math.max(0, h));
  }

  /** The laid-out size. */
  getSize(): Vector2 {
    return this.getRect().size;
  }
  setSize(v: Vector2) {
    this.size = v.clone();
  }

  override get transform(): Transform2D {
    const r = this.getRect();
    const pv = this.pivotOffset;
    const t = Transform2D.compose(new Vector2(r.x + pv.x, r.y + pv.y), this.rotation, this.scale);
    return pv.x || pv.y ? t.multiply(new Transform2D(1, 0, 0, 1, -pv.x, -pv.y)) : t;
  }

  // Anchored controls aren't placed by `position` directly: move them by the difference instead.
  override get globalPosition(): Vector2 {
    return this.globalTransform.origin;
  }
  override set globalPosition(v: { x: number; y: number }) {
    const cur = this.globalTransform.origin;
    const d = new Vector2(v.x - cur.x, v.y - cur.y);
    const p = this.parent2D;
    this.position = this.position.add(p ? p.globalTransform.invert().applyVector(d) : d);
  }

  /** The rectangle's bounding box in canvas coordinates. */
  getGlobalRect(): Rect2 {
    const t = this.globalTransform;
    const s = this.getSize();
    return Rect2.fromPoints([t.apply({ x: 0, y: 0 }), t.apply({ x: s.x, y: 0 }), t.apply({ x: 0, y: s.y }), t.apply({ x: s.x, y: s.y })]);
  }

  /** Local point inside the rectangle? */
  hasPoint(local: Vector2) {
    const s = this.getSize();
    return local.x >= 0 && local.y >= 0 && local.x <= s.x && local.y <= s.y;
  }

  /** Viewport pixel → this control's local coordinates. */
  viewportToLocal(p: Vector2): Vector2 {
    return this.getCanvasTransform().multiply(this.globalTransform).invert().apply(p);
  }

  isHovered() {
    return this.__hovered;
  }

  override getLocalBounds() {
    const s = this.getSize();
    return new Rect2(0, 0, s.x, s.y);
  }
}

/** A filled rectangle (backgrounds, bars, overlays). */
export class ColorRect extends Control {
  static override readonly typeName: string = 'ColorRect';
  override size = new Vector2(100, 100);
  color = Color.WHITE;
}

/** A background box with an optional border and rounded corners. */
export class Panel extends Control {
  static override readonly typeName: string = 'Panel';
  override size = new Vector2(200, 120);
  bgColor = Color.fromHex('#262b36');
  borderColor = Color.fromHex('#5b6478');
  borderWidth = 0;
  cornerRadius = 4;
}

/** Text in the UI, aligned inside its rectangle. */
export class Label extends Control {
  static override readonly typeName: string = 'Label';
  override mouseFilter: MouseFilter = 'ignore';
  text = 'Label';
  fontSize = 16;
  fontColor = Color.WHITE;
  outlineSize = 0;
  outlineColor = Color.BLACK;
  horizontalAlignment: HAlign = 'left';
  verticalAlignment: VAlign = 'top';
  /** Wrap lines at the control's width. */
  autowrap = false;
  /** @internal Measured by the renderer (falls back to an estimate). */
  __measuredTextSize: Vector2 | null = null;

  getTextSize(): Vector2 {
    return this.__measuredTextSize?.clone() ?? estimateTextSize(this.text, this.fontSize);
  }
  override getMinimumSize() {
    const t = this.getTextSize();
    return this.autowrap ? new Vector2(0, t.y) : t;
  }
}

export type ButtonState = 'normal' | 'hover' | 'pressed' | 'disabled';

/** A clickable / tappable button. Emits `pressed` when released over it (mouse and touch). */
export class Button extends Control {
  static override readonly typeName: string = 'Button';
  text = 'Button';
  disabled = false;
  /** Stays pressed until clicked again (a toggle); emits `toggled`. */
  toggleMode = false;
  /** The toggle state (toggle mode only). */
  buttonPressed = false;
  /** No background unless hovered or pressed. */
  flat = false;
  fontSize = 16;
  fontColor = Color.WHITE;
  color = Color.fromHex('#3d4455');
  hoverColor = Color.fromHex('#4b5468');
  pressedColor = Color.fromHex('#2b303c');
  borderColor = Color.fromHex('#5b6478');
  borderWidth = 1;
  cornerRadius = 4;
  horizontalAlignment: HAlign = 'center';
  readonly pressed = new Signal<[]>('pressed');
  readonly buttonDown = new Signal<[]>('buttonDown');
  readonly buttonUp = new Signal<[]>('buttonUp');
  readonly toggled = new Signal<[toggledOn: boolean]>('toggled');
  /** @internal Measured by the renderer. */
  __measuredTextSize: Vector2 | null = null;
  private held: number | null = null;
  private holdInside = false;

  /** Held down right now, or toggled on. */
  isPressed() {
    return (this.held !== null && this.holdInside) || (this.toggleMode && this.buttonPressed);
  }
  getDrawState(): ButtonState {
    if (this.disabled) return 'disabled';
    if (this.isPressed()) return 'pressed';
    return this.__hovered ? 'hover' : 'normal';
  }
  override getMinimumSize() {
    const t = this.__measuredTextSize ?? estimateTextSize(this.text, this.fontSize);
    return new Vector2(t.x + 24, t.y + 12);
  }

  override __gui(e: InputEventPointer, inside: boolean) {
    if (e.phase === 'down') {
      if (this.disabled || this.held !== null || e.button !== 0) return;
      this.held = e.pointerId;
      this.holdInside = true;
      this.buttonDown.emit();
    } else if (e.phase === 'move') {
      if (this.held === e.pointerId) this.holdInside = inside;
    } else if (this.held === e.pointerId) {
      this.held = null;
      this.buttonUp.emit();
      if (e.phase === 'up' && inside && !this.disabled) {
        if (this.toggleMode) {
          this.buttonPressed = !this.buttonPressed;
          this.toggled.emit(this.buttonPressed);
        }
        this.pressed.emit();
      }
    }
  }
}

export type StretchMode = 'scale' | 'tile' | 'keep' | 'keepCentered' | 'keepAspect' | 'keepAspectCentered' | 'keepAspectCovered';

/** Shows a texture in the UI (icons, portraits, backgrounds). */
export class TextureRect extends Control {
  static override readonly typeName: string = 'TextureRect';
  override mouseFilter: MouseFilter = 'pass';
  texture: Texture | null = null;
  stretchMode: StretchMode = 'scale';
  /** keepSize: at least as big as the texture · ignoreSize: any size. */
  expandMode: 'keepSize' | 'ignoreSize' = 'keepSize';
  flipH = false;
  flipV = false;
  override getMinimumSize() {
    return this.expandMode === 'keepSize' && this.texture ? new Vector2(this.texture.width, this.texture.height) : new Vector2();
  }
}

export type FillMode = 'beginToEnd' | 'endToBegin' | 'topToBottom' | 'bottomToTop';

/** A bar showing a value between min and max (health, loading, cooldowns). */
export class ProgressBar extends Control {
  static override readonly typeName: string = 'ProgressBar';
  override size = new Vector2(200, 24);
  minValue = 0;
  maxValue = 100;
  private _value = 0;
  /** Values are rounded to this (0 = no rounding). */
  step = 0.01;
  showPercentage = true;
  fillMode: FillMode = 'beginToEnd';
  bgColor = Color.fromHex('#262b36');
  fillColor = Color.fromHex('#4f8cff');
  fontColor = Color.WHITE;
  fontSize = 14;
  readonly valueChanged = new Signal<[value: number]>('valueChanged');

  get value() {
    return this._value;
  }
  set value(v: number) {
    let x = Math.min(Math.max(v, Math.min(this.minValue, this.maxValue)), Math.max(this.minValue, this.maxValue));
    if (this.step > 0) x = Math.round((x - this.minValue) / this.step) * this.step + this.minValue;
    x = Math.round(x * 1e9) / 1e9;
    if (x === this._value) return;
    this._value = x;
    this.valueChanged.emit(x);
  }
  /** (value − min) / (max − min), 0–1. */
  get ratio() {
    const span = this.maxValue - this.minValue;
    return span !== 0 ? Math.min(1, Math.max(0, (this._value - this.minValue) / span)) : 0;
  }
  set ratio(r: number) {
    this.value = this.minValue + r * (this.maxValue - this.minValue);
  }
}

// --- containers -------------------------------------------------------------------------------------------------

/** Base of layout containers: they place and size their Control children; children's position and anchors are ignored. */
export abstract class Container extends Control {
  override mouseFilter: MouseFilter = 'pass';
  /** @internal */
  __childRect(child: Control): Rect2 | null {
    return this.layoutChildren().get(child) ?? null;
  }
  /** Children taking part in the layout (visible Controls). */
  protected layoutItems(): Control[] {
    return this.children.filter((c): c is Control => c instanceof Control && c.visible);
  }
  protected abstract layoutChildren(): Map<Control, Rect2>;
}

/** Places a child in `avail` px starting at `start` according to its size flag. */
function fit(flag: SizeFlag, start: number, avail: number, want: number): [number, number] {
  switch (flag) {
    case 'fill':
    case 'expandFill':
      return [start, Math.max(avail, 0)];
    case 'shrinkBegin':
      return [start, want];
    case 'shrinkCenter':
      return [start + (avail - want) / 2, want];
    case 'shrinkEnd':
      return [start + avail - want, want];
  }
}

export type BoxAlignment = 'begin' | 'center' | 'end';

/** Lines children up in a row (HBoxContainer) or column (VBoxContainer). */
export abstract class BoxContainer extends Container {
  protected abstract readonly vertical: boolean;
  /** Gap between children in pixels. */
  separation = 4;
  /** Where the children sit when none of them expands. */
  alignment: BoxAlignment = 'begin';

  override getMinimumSize() {
    const items = this.layoutItems();
    let main = 0;
    let cross = 0;
    for (const c of items) {
      const m = c.getCombinedMinimumSize();
      main += this.vertical ? m.y : m.x;
      cross = Math.max(cross, this.vertical ? m.x : m.y);
    }
    main += this.separation * Math.max(0, items.length - 1);
    return this.vertical ? new Vector2(cross, main) : new Vector2(main, cross);
  }

  protected layoutChildren() {
    const out = new Map<Control, Rect2>();
    const items = this.layoutItems();
    if (!items.length) return out;
    const size = this.getRect().size;
    const mainLen = this.vertical ? size.y : size.x;
    const crossLen = this.vertical ? size.x : size.y;
    const mins = items.map((c) => c.getCombinedMinimumSize());
    const mainFlag = (c: Control) => (this.vertical ? c.sizeFlagsVertical : c.sizeFlagsHorizontal);
    const crossFlag = (c: Control) => (this.vertical ? c.sizeFlagsHorizontal : c.sizeFlagsVertical);
    const total = mins.reduce((s, m) => s + (this.vertical ? m.y : m.x), 0) + this.separation * (items.length - 1);
    const extra = Math.max(0, mainLen - total);
    const expanders = items.filter((c) => mainFlag(c) === 'expandFill').length;
    let offset = expanders ? 0 : this.alignment === 'center' ? extra / 2 : this.alignment === 'end' ? extra : 0;
    items.forEach((c, i) => {
      const m = mins[i];
      const len = (this.vertical ? m.y : m.x) + (expanders && mainFlag(c) === 'expandFill' ? extra / expanders : 0);
      const [cs, cl] = fit(crossFlag(c), 0, crossLen, this.vertical ? m.x : m.y);
      out.set(c, this.vertical ? new Rect2(cs, offset, cl, len) : new Rect2(offset, cs, len, cl));
      offset += len + this.separation;
    });
    return out;
  }
}

export class HBoxContainer extends BoxContainer {
  static override readonly typeName: string = 'HBoxContainer';
  protected readonly vertical = false;
}

export class VBoxContainer extends BoxContainer {
  static override readonly typeName: string = 'VBoxContainer';
  protected readonly vertical = true;
}

/** Keeps its children inside margins (padding around a menu or HUD). */
export class MarginContainer extends Container {
  static override readonly typeName: string = 'MarginContainer';
  marginLeft = 0;
  marginTop = 0;
  marginRight = 0;
  marginBottom = 0;

  override getMinimumSize() {
    let w = 0;
    let h = 0;
    for (const c of this.layoutItems()) {
      const m = c.getCombinedMinimumSize();
      w = Math.max(w, m.x);
      h = Math.max(h, m.y);
    }
    return new Vector2(w + this.marginLeft + this.marginRight, h + this.marginTop + this.marginBottom);
  }

  protected layoutChildren() {
    const out = new Map<Control, Rect2>();
    const size = this.getRect().size;
    const w = size.x - this.marginLeft - this.marginRight;
    const h = size.y - this.marginTop - this.marginBottom;
    for (const c of this.layoutItems()) {
      const m = c.getCombinedMinimumSize();
      const [x, cw] = fit(c.sizeFlagsHorizontal, this.marginLeft, w, m.x);
      const [y, ch] = fit(c.sizeFlagsVertical, this.marginTop, h, m.y);
      out.set(c, new Rect2(x, y, cw, ch));
    }
    return out;
  }
}

/** Centres its children (title screens, dialogs). */
export class CenterContainer extends Container {
  static override readonly typeName: string = 'CenterContainer';
  override getMinimumSize() {
    let w = 0;
    let h = 0;
    for (const c of this.layoutItems()) {
      const m = c.getCombinedMinimumSize();
      w = Math.max(w, m.x);
      h = Math.max(h, m.y);
    }
    return new Vector2(w, h);
  }
  protected layoutChildren() {
    const out = new Map<Control, Rect2>();
    const size = this.getRect().size;
    for (const c of this.layoutItems()) {
      const m = c.getCombinedMinimumSize();
      out.set(c, new Rect2((size.x - m.x) / 2, (size.y - m.y) / 2, m.x, m.y));
    }
    return out;
  }
}

// --- GUI input routing ------------------------------------------------------------------------------------------

interface GuiState {
  /** Control that received each pointer's press (it gets the release too). */
  captures: Map<number, Control>;
  hovered: Control | null;
}
const guiStates = new WeakMap<SceneTree, GuiState>();

/** Controls that can receive pointer input, topmost first (layer, then z index, then tree order). */
export function guiControls(tree: SceneTree): Control[] {
  const list: { c: Control; layer: number; z: number; order: number }[] = [];
  let order = 0;
  tree.root.walk((n: Node) => {
    order++;
    if (!(n instanceof Control) || n.mouseFilter === 'ignore' || !n.isVisibleInTree() || !n.canProcess()) return;
    list.push({ c: n, layer: n.getCanvasLayer()?.layer ?? 0, z: n.globalZIndex, order });
  });
  list.sort((a, b) => b.layer - a.layer || b.z - a.z || b.order - a.order);
  return list.map((e) => e.c);
}

function deliver(c: Control, e: InputEventPointer, inside: boolean, tree: SceneTree) {
  const prev = currentEvent;
  currentEvent = e;
  try {
    c.__gui(e, inside);
    c.guiInput.emit(e);
    if (c._guiInput !== Control.prototype._guiInput) c._guiInput(e);
  } catch (err) {
    tree.reportError(err, c, '_guiInput');
  } finally {
    currentEvent = prev;
  }
}

/**
 * Routes a pointer event to the UI. Returns true when a control consumed it (the event is then
 * not applied to mouse-button actions and not passed to `_input`).
 */
export function routeGuiPointer(tree: SceneTree, e: InputEventPointer): boolean {
  let st = guiStates.get(tree);
  if (!st) guiStates.set(tree, (st = { captures: new Map(), hovered: null }));
  const controls = guiControls(tree);
  const hits = controls.filter((c) => c.hasPoint(c.viewportToLocal(e.position)));

  if (e.phase === 'move') {
    if (e.pointerType === 'mouse') setHovered(st, hits[0] ?? null);
    const captured = st.captures.get(e.pointerId);
    if (captured) deliver(captured, e, captured.isInsideTree() && captured.hasPoint(captured.viewportToLocal(e.position)), tree);
    else if (hits[0]) deliver(hits[0], e, true, tree);
    return false;
  }

  if (e.phase === 'up' || e.phase === 'cancel') {
    const captured = st.captures.get(e.pointerId);
    st.captures.delete(e.pointerId);
    if (e.pointerType !== 'mouse') setHovered(st, null);
    if (!captured) return false;
    if (captured.isInsideTree()) deliver(captured, e, captured.hasPoint(captured.viewportToLocal(e.position)), tree);
    return true;
  }

  // Press: the topmost control gets it; "pass" lets the ones below see it as well.
  if (e.pointerType === 'mouse') setHovered(st, hits[0] ?? null);
  for (const c of hits) {
    deliver(c, e, true, tree);
    if (c.mouseFilter === 'stop' || e.handled) {
      st.captures.set(e.pointerId, c);
      return true;
    }
  }
  return false;
}

function setHovered(st: GuiState, c: Control | null) {
  if (st.hovered === c) return;
  const old = st.hovered;
  st.hovered = c;
  if (old) {
    old.__hovered = false;
    old.mouseExited.emit();
  }
  if (c) {
    c.__hovered = true;
    c.mouseEntered.emit();
  }
}
