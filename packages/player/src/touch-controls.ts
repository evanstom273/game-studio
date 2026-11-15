/**
 * On-screen controls for touch screens: a stick (ui_left/right/up/down, analogue) and two buttons
 * (ui_accept, ui_cancel). Plain DOM, so exported games need no UI framework.
 */
import { Input } from '@gs/core';

export function createTouchControls(container: HTMLElement): () => void {
  const root = document.createElement('div');
  root.dataset.gsTouchControls = '';
  root.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:5;user-select:none;-webkit-user-select:none;touch-action:none';
  const ring = document.createElement('div');
  ring.style.cssText = 'position:absolute;left:calc(24px + env(safe-area-inset-left));bottom:calc(24px + env(safe-area-inset-bottom));width:132px;height:132px;border-radius:50%;background:rgba(255,255,255,.10);border:2px solid rgba(255,255,255,.28);pointer-events:auto;touch-action:none';
  const knob = document.createElement('div');
  knob.style.cssText = 'position:absolute;left:41px;top:41px;width:50px;height:50px;border-radius:50%;background:rgba(255,255,255,.45);transition:transform .05s';
  ring.appendChild(knob);
  root.appendChild(ring);

  const actions = ['ui_left', 'ui_right', 'ui_up', 'ui_down'] as const;
  let stickId: number | null = null;
  const setStick = (dx: number, dy: number) => {
    const len = Math.hypot(dx, dy);
    const max = 50;
    const k = len > max ? max / len : 1;
    knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
    const nx = (dx * k) / max;
    const ny = (dy * k) / max;
    const dead = 0.2;
    const strengths = [Math.max(0, -nx), Math.max(0, nx), Math.max(0, -ny), Math.max(0, ny)];
    actions.forEach((a, i) => (strengths[i] > dead ? Input.actionPress(a, strengths[i], 'touch-stick') : Input.actionRelease(a, 'touch-stick')));
  };
  ring.addEventListener('pointerdown', (e) => {
    stickId = e.pointerId;
    ring.setPointerCapture(e.pointerId);
    const r = ring.getBoundingClientRect();
    setStick(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
    e.preventDefault();
  });
  ring.addEventListener('pointermove', (e) => {
    if (e.pointerId !== stickId) return;
    const r = ring.getBoundingClientRect();
    setStick(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
  });
  const endStick = (e: PointerEvent) => {
    if (e.pointerId !== stickId) return;
    stickId = null;
    setStick(0, 0);
  };
  ring.addEventListener('pointerup', endStick);
  ring.addEventListener('pointercancel', endStick);

  const button = (label: string, action: string, right: number, bottom: number) => {
    const b = document.createElement('div');
    b.textContent = label;
    b.setAttribute('role', 'button');
    b.setAttribute('aria-label', action);
    b.style.cssText = `position:absolute;right:calc(${right}px + env(safe-area-inset-right));bottom:calc(${bottom}px + env(safe-area-inset-bottom));width:68px;height:68px;border-radius:50%;background:rgba(255,255,255,.16);border:2px solid rgba(255,255,255,.32);color:rgba(255,255,255,.85);font:600 22px system-ui,sans-serif;display:flex;align-items:center;justify-content:center;pointer-events:auto;touch-action:none`;
    const down = (e: PointerEvent) => {
      b.setPointerCapture(e.pointerId);
      b.style.background = 'rgba(255,255,255,.36)';
      Input.actionPress(action, 1, `touch-${action}`);
      e.preventDefault();
    };
    const up = () => {
      b.style.background = 'rgba(255,255,255,.16)';
      Input.actionRelease(action, `touch-${action}`);
    };
    b.addEventListener('pointerdown', down);
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    root.appendChild(b);
  };
  button('A', 'ui_accept', 28, 64);
  button('B', 'ui_cancel', 108, 28);
  container.appendChild(root);
  return () => {
    for (const a of actions) Input.actionRelease(a, 'touch-stick');
    Input.actionRelease('ui_accept', 'touch-ui_accept');
    Input.actionRelease('ui_cancel', 'touch-ui_cancel');
    root.remove();
  };
}
