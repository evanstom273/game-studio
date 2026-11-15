/**
 * Input: keyboard, pointer/touch, gamepad and named actions (Godot's InputMap + Input).
 *
 * The platform layer (packages/player) feeds raw events with `Input.feed()`; the engine applies
 * them at the start of each frame, updates action state and then calls `_input(event)` on nodes.
 * Scripts query state:
 *
 *   if (Input.isActionPressed('ui_right')) …
 *   if (Input.isActionJustPressed('jump')) …       // works in _process and _physicsProcess
 *   const dir = Input.getVector('ui_left', 'ui_right', 'ui_up', 'ui_down');
 */
import { Vector2 } from '@gs/shared';

export type InputBinding =
  | { type: 'key'; code: string }
  | { type: 'mouseButton'; button: number }
  | { type: 'gamepadButton'; button: number }
  | { type: 'gamepadAxis'; axis: number; direction: 1 | -1 };

/** Godot's built-in ui_* actions (keyboard, D-pad and left stick). Projects can change them. */
export const DEFAULT_ACTIONS: Record<string, InputBinding[]> = {
  ui_left: [
    { type: 'key', code: 'ArrowLeft' },
    { type: 'key', code: 'KeyA' },
    { type: 'gamepadButton', button: 14 },
    { type: 'gamepadAxis', axis: 0, direction: -1 },
  ],
  ui_right: [
    { type: 'key', code: 'ArrowRight' },
    { type: 'key', code: 'KeyD' },
    { type: 'gamepadButton', button: 15 },
    { type: 'gamepadAxis', axis: 0, direction: 1 },
  ],
  ui_up: [
    { type: 'key', code: 'ArrowUp' },
    { type: 'key', code: 'KeyW' },
    { type: 'gamepadButton', button: 12 },
    { type: 'gamepadAxis', axis: 1, direction: -1 },
  ],
  ui_down: [
    { type: 'key', code: 'ArrowDown' },
    { type: 'key', code: 'KeyS' },
    { type: 'gamepadButton', button: 13 },
    { type: 'gamepadAxis', axis: 1, direction: 1 },
  ],
  ui_accept: [
    { type: 'key', code: 'Enter' },
    { type: 'key', code: 'Space' },
    { type: 'gamepadButton', button: 0 },
  ],
  ui_cancel: [
    { type: 'key', code: 'Escape' },
    { type: 'gamepadButton', button: 1 },
  ],
};

interface EventBase {
  /** Set to true in `_input` to stop the event reaching other nodes. */
  handled: boolean;
}
export interface InputEventKey extends EventBase {
  type: 'key';
  /** Physical key (KeyboardEvent.code), e.g. "KeyA", "Space", "ArrowLeft". */
  code: string;
  /** Character/meaning (KeyboardEvent.key), e.g. "a", "A", " ". */
  key: string;
  pressed: boolean;
  echo: boolean;
}
export interface InputEventPointer extends EventBase {
  type: 'pointer';
  phase: 'down' | 'up' | 'move' | 'cancel';
  pointerId: number;
  pointerType: 'mouse' | 'touch' | 'pen';
  /** Position in game viewport pixels (the project's display size). */
  position: Vector2;
  button: number;
}
export interface InputEventWheel extends EventBase {
  type: 'wheel';
  delta: Vector2;
  position: Vector2;
}
export interface InputEventAction extends EventBase {
  type: 'action';
  action: string;
  pressed: boolean;
  strength: number;
}
export type InputEvent = InputEventKey | InputEventPointer | InputEventWheel | InputEventAction;
export type RawInputEvent = Omit<InputEventKey, 'handled'> | Omit<InputEventPointer, 'handled'> | Omit<InputEventWheel, 'handled'>;

/** A gamepad snapshot (shape of the browser Gamepad API). */
export interface GamepadLike {
  index: number;
  connected: boolean;
  buttons: readonly { pressed: boolean; value: number }[];
  axes: readonly number[];
}

interface ActionState {
  strength: number;
  pressedFrame: number;
  pressedTick: number;
  releasedFrame: number;
  releasedTick: number;
}

export class InputManager {
  /** Below this, stick axes count as 0. */
  deadzone = 0.2;
  private actions = new Map<string, InputBinding[]>();
  private keys = new Set<string>();
  private mouseButtons = new Set<number>();
  private pads: GamepadLike[] = [];
  /** Strength each action gets from each source (key, pad, virtual control…). */
  private sources = new Map<string, Map<string, number>>();
  private state = new Map<string, ActionState>();
  private queue: RawInputEvent[] = [];
  private frame = 0;
  private tick = 0;
  private inPhysics = false;
  private _pointer = new Vector2();
  private touches = new Map<number, Vector2>();
  /** Pointers whose press a UI control consumed: their release is the UI's too. */
  private guiPointers = new Set<number>();

  constructor() {
    this.setActions(DEFAULT_ACTIONS);
  }

  /** Replaces the action map (the ui_* defaults stay unless overridden). */
  setActions(map: Record<string, InputBinding[]>) {
    this.actions = new Map(Object.entries({ ...DEFAULT_ACTIONS, ...map }));
  }
  addAction(name: string, bindings: InputBinding[] = []) {
    this.actions.set(name, [...(this.actions.get(name) ?? []), ...bindings]);
  }
  hasAction(name: string) {
    return this.actions.has(name);
  }
  getActions() {
    return [...this.actions.keys()];
  }

  // --- feeding (platform layer) -------------------------------------------------------------------------------
  feed(e: RawInputEvent) {
    this.queue.push(e);
  }

  /** Presses an action directly (on-screen touch controls). */
  actionPress(action: string, strength = 1, source = 'virtual') {
    this.setSource(action, source, strength);
  }
  actionRelease(action: string, source = 'virtual') {
    this.setSource(action, source, 0);
  }

  // --- engine hooks -----------------------------------------------------------------------------------------------
  /**
   * @internal Applies queued events for a new frame; returns them as events for `_input`.
   * `gui` sees pointer events first (UI controls); when it returns true the event is consumed:
   * it doesn't press mouse-button actions and is marked handled.
   */
  beginFrame(frame: number, physicsTick: number, pads: GamepadLike[] = [], gui?: (e: InputEventPointer) => boolean): InputEvent[] {
    this.frame = frame;
    this.tick = physicsTick;
    this.inPhysics = false;
    const out: InputEvent[] = [];
    for (const raw of this.queue.splice(0)) {
      const e = { ...raw, handled: false } as InputEvent;
      out.push(e);
      if (e.type === 'key') {
        if (e.pressed) this.keys.add(e.code);
        else this.keys.delete(e.code);
        if (!e.echo) for (const a of this.actionsFor((b) => b.type === 'key' && b.code === e.code)) out.push(this.actionEvent(a, `key:${e.code}`, e.pressed ? 1 : 0));
      } else if (e.type === 'pointer') {
        this._pointer = e.position.clone();
        const captured = this.guiPointers.has(e.pointerId);
        const consumed = (gui?.(e) ?? false) || (captured && e.phase !== 'move');
        if (consumed) e.handled = true;
        if (e.phase === 'down' && consumed) this.guiPointers.add(e.pointerId);
        if (e.phase === 'up' || e.phase === 'cancel') this.guiPointers.delete(e.pointerId);
        if (consumed) continue;
        if (e.pointerType === 'touch') {
          if (e.phase === 'down' || e.phase === 'move') this.touches.set(e.pointerId, e.position.clone());
          else this.touches.delete(e.pointerId);
        }
        if (e.phase === 'down' || e.phase === 'up' || e.phase === 'cancel') {
          const down = e.phase === 'down';
          if (down) this.mouseButtons.add(e.button);
          else this.mouseButtons.delete(e.button);
          for (const a of this.actionsFor((b) => b.type === 'mouseButton' && b.button === e.button)) out.push(this.actionEvent(a, `mouse:${e.button}`, down ? 1 : 0));
        }
      }
    }
    this.pollPads(pads);
    return out.filter((e) => e !== null);
  }

  /** @internal */
  beginPhysicsTick(tick: number) {
    this.tick = tick;
    this.inPhysics = true;
  }
  /** @internal */
  endPhysics() {
    this.inPhysics = false;
  }

  private pollPads(pads: GamepadLike[]) {
    this.pads = pads.filter((p) => p?.connected);
    for (const [name, bindings] of this.actions) {
      let s = 0;
      for (const pad of this.pads) {
        for (const b of bindings) {
          if (b.type === 'gamepadButton') s = Math.max(s, pad.buttons[b.button]?.value ?? 0);
          else if (b.type === 'gamepadAxis') {
            const v = (pad.axes[b.axis] ?? 0) * b.direction;
            if (v > this.deadzone) s = Math.max(s, (v - this.deadzone) / (1 - this.deadzone));
          }
        }
      }
      this.setSource(name, 'gamepad', s);
    }
  }

  private actionsFor(match: (b: InputBinding) => boolean) {
    const out: string[] = [];
    for (const [name, bindings] of this.actions) if (bindings.some(match)) out.push(name);
    return out;
  }

  private actionEvent(action: string, source: string, strength: number): InputEventAction {
    this.setSource(action, source, strength);
    return { type: 'action', action, pressed: strength > 0, strength, handled: false };
  }

  private setSource(action: string, source: string, strength: number) {
    let m = this.sources.get(action);
    if (!m) this.sources.set(action, (m = new Map()));
    if (strength > 0) m.set(source, strength);
    else m.delete(source);
    const next = Math.min(1, Math.max(0, ...m.values()));
    let st = this.state.get(action);
    if (!st) this.state.set(action, (st = { strength: 0, pressedFrame: -1, pressedTick: -1, releasedFrame: -1, releasedTick: -1 }));
    if (st.strength === 0 && next > 0) {
      // "Just pressed" in the current idle frame and in the next physics tick.
      st.pressedFrame = this.frame;
      st.pressedTick = this.inPhysics ? this.tick : this.tick + 1;
    } else if (st.strength > 0 && next === 0) {
      st.releasedFrame = this.frame;
      st.releasedTick = this.inPhysics ? this.tick : this.tick + 1;
    }
    st.strength = next;
  }

  // --- queries (scripts) ---------------------------------------------------------------------------------------------
  isActionPressed(action: string) {
    return (this.state.get(action)?.strength ?? 0) > 0;
  }
  isActionJustPressed(action: string) {
    const st = this.state.get(action);
    if (!st || st.strength === 0) return false;
    return this.inPhysics ? st.pressedTick === this.tick : st.pressedFrame === this.frame;
  }
  isActionJustReleased(action: string) {
    const st = this.state.get(action);
    if (!st || st.strength > 0) return false;
    return this.inPhysics ? st.releasedTick === this.tick : st.releasedFrame === this.frame;
  }
  getActionStrength(action: string) {
    return this.state.get(action)?.strength ?? 0;
  }
  /** strength(positive) − strength(negative), in [-1, 1]. */
  getAxis(negative: string, positive: string) {
    return this.getActionStrength(positive) - this.getActionStrength(negative);
  }
  /** A direction from four actions, length ≤ 1. */
  getVector(negX: string, posX: string, negY: string, posY: string) {
    const v = new Vector2(this.getAxis(negX, posX), this.getAxis(negY, posY));
    return v.length() > 1 ? v.normalized() : v;
  }
  isKeyPressed(code: string) {
    return this.keys.has(code);
  }
  isMouseButtonPressed(button = 0) {
    return this.mouseButtons.has(button);
  }
  /** Last pointer position in viewport pixels. */
  getPointerPosition() {
    return this._pointer.clone();
  }
  getTouches(): Map<number, Vector2> {
    return new Map(this.touches);
  }
  getConnectedGamepads() {
    return this.pads.map((p) => p.index);
  }

  /** Clears all state (scene restarts, tests). */
  reset() {
    this.keys.clear();
    this.mouseButtons.clear();
    this.sources.clear();
    this.state.clear();
    this.queue = [];
    this.touches.clear();
    this.guiPointers.clear();
  }
}

/** The global Input (one engine per page, like Godot's singleton). */
export const Input = new InputManager();
