/**
 * Adaptive layout. The editor picks its arrangement from what it can measure — the size of the
 * space it actually has (ResizeObserver on the app root, not window breakpoints), the primary
 * input (touch or mouse), and on foldables the screen segments (Viewport Segments API) and posture
 * (Device Posture API) — and re-evaluates whenever any of them changes (rotation, fold, unfold,
 * split-screen, desktop window resize).
 *
 *   compact  phones (portrait or landscape): full-screen viewport, bottom sheets, bottom bar
 *   medium   tablets, unfolded foldables, narrow windows: viewport + one tabbed side dock
 *   wide     desktops: Godot-style multi-panel editor
 *   split    a dual-screen/folded device spanning two segments: viewport on one, panels on the other
 */
import { useSyncExternalStore } from 'react';

export type LayoutMode = 'compact' | 'medium' | 'wide' | 'split';

export interface LayoutInfo {
  mode: LayoutMode;
  width: number;
  height: number;
  touch: boolean;
  orientation: 'portrait' | 'landscape';
  /** For split: how the screen is divided and where the fold is (CSS px). */
  fold: { axis: 'vertical' | 'horizontal'; first: number; gap: number } | null;
  posture: 'continuous' | 'folded' | 'unknown';
}

interface ViewportSegments {
  segments?: DOMRect[] | null;
}

function readSegments(): DOMRect[] | null {
  const vp = (window as unknown as { viewport?: ViewportSegments }).viewport;
  const segs = vp?.segments;
  return segs && segs.length > 1 ? Array.from(segs) : null;
}

function readPosture(): LayoutInfo['posture'] {
  const p = (navigator as unknown as { devicePosture?: { type?: string } }).devicePosture?.type;
  return p === 'folded' ? 'folded' : p === 'continuous' ? 'continuous' : 'unknown';
}

export function computeLayout(width: number, height: number, touch: boolean, segments: DOMRect[] | null, posture: LayoutInfo['posture'] = 'unknown'): LayoutInfo {
  const orientation = width >= height ? 'landscape' : 'portrait';
  if (segments && segments.length === 2) {
    const [a, b] = segments;
    const sideBySide = Math.abs(a.top - b.top) < 1;
    const fold = sideBySide ? { axis: 'vertical' as const, first: a.width, gap: Math.max(0, b.left - a.right) } : { axis: 'horizontal' as const, first: a.height, gap: Math.max(0, b.top - a.bottom) };
    return { mode: 'split', width, height, touch, orientation, fold, posture };
  }
  let mode: LayoutMode;
  if (width < 700 || (height < 520 && width < 1000)) mode = 'compact';
  else if (width < 1180 || (touch && width < 1366 && orientation === 'portrait')) mode = 'medium';
  else mode = 'wide';
  return { mode, width, height, touch, orientation, fold: null, posture };
}

let state: LayoutInfo = computeLayout(window.innerWidth, window.innerHeight, matchMedia('(pointer: coarse)').matches, readSegments(), readPosture());
const listeners = new Set<() => void>();
let observed: Element | null = null;
let ro: ResizeObserver | null = null;

function update(width = observed?.clientWidth ?? window.innerWidth, height = observed?.clientHeight ?? window.innerHeight) {
  const next = computeLayout(width, height, matchMedia('(pointer: coarse)').matches, readSegments(), readPosture());
  if (next.mode !== state.mode || next.width !== state.width || next.height !== state.height || next.touch !== state.touch || JSON.stringify(next.fold) !== JSON.stringify(state.fold) || next.posture !== state.posture) {
    state = next;
    for (const l of listeners) l();
  }
}

window.addEventListener('resize', () => update());
window.addEventListener('orientationchange', () => update());
matchMedia('(pointer: coarse)').addEventListener('change', () => update());
(navigator as unknown as { devicePosture?: EventTarget }).devicePosture?.addEventListener?.('change', () => update());

/** Measure this element (the app root) instead of the window. */
export function observeLayoutRoot(el: Element | null) {
  if (el === observed) return;
  ro?.disconnect();
  observed = el;
  if (!el) return;
  ro = new ResizeObserver((entries) => {
    const r = entries[0].contentRect;
    update(r.width, r.height);
  });
  ro.observe(el);
  update();
}

export function useLayout(): LayoutInfo {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
  );
}
