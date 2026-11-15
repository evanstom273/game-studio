/**
 * Drawing for UI controls (Panel, ColorRect, Label, Button, TextureRect, ProgressBar). Each
 * control is one Container in local space (origin = the control's top-left), rebuilt only when
 * what it shows changes. Text sizes are measured here and handed back to the control, so layout
 * (containers, auto-sized buttons) uses real text metrics.
 */
import { Container, Graphics, Rectangle, Sprite, Text, Texture, TilingSprite, type TextStyleOptions } from 'pixi.js';
import { Color, Vector2 } from '@gs/shared';
import { Button, ColorRect, Control, Label, Panel, ProgressBar, TextureRect, type HAlign, type VAlign } from '@gs/core';

export const FONT_FAMILY = 'Inter, system-ui, -apple-system, Segoe UI, sans-serif';

export interface UiVisual {
  obj: Container;
  key: string;
}

export interface UiContext {
  /** A loaded texture for a project path (null while loading or missing). */
  texture(path: string): Texture | null;
  /** Called when a measured text size changed (layout depends on it). */
  measured(): void;
}

const num = (c: Color) => c.toNumber();

export function isDrawnControl(n: Control) {
  return n instanceof Panel || n instanceof ColorRect || n instanceof Label || n instanceof Button || n instanceof TextureRect || n instanceof ProgressBar;
}

function setMeasured(n: Label | Button, w: number, h: number, ctx: UiContext) {
  const prev = n.__measuredTextSize;
  if (prev && Math.abs(prev.x - w) < 0.5 && Math.abs(prev.y - h) < 0.5) return;
  n.__measuredTextSize = new Vector2(w, h);
  ctx.measured();
}

function textStyle(size: number, color: Color, align: HAlign, outline = 0, outlineColor: Color | null = null, wrapWidth = 0): TextStyleOptions {
  return {
    fontFamily: FONT_FAMILY,
    fontSize: size,
    fill: num(color),
    align,
    ...(outline > 0 && outlineColor ? { stroke: { color: num(outlineColor), width: outline } } : {}),
    ...(wrapWidth > 0 ? { wordWrap: true, wordWrapWidth: Math.max(1, wrapWidth), breakWords: true } : {}),
  };
}

/** Places text inside a w×h box by alignment. */
function align(t: Text, w: number, h: number, ha: HAlign, va: VAlign) {
  t.x = ha === 'center' ? (w - t.width) / 2 : ha === 'right' ? w - t.width : 0;
  t.y = va === 'center' ? (h - t.height) / 2 : va === 'bottom' ? h - t.height : 0;
}

function box(g: Graphics, w: number, h: number, fill: Color | null, radius: number, border: Color | null, borderWidth: number) {
  g.clear();
  if (w <= 0 || h <= 0) return;
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  if (fill && fill.a > 0) (r > 0 ? g.roundRect(0, 0, w, h, r) : g.rect(0, 0, w, h)).fill({ color: num(fill), alpha: fill.a });
  if (border && borderWidth > 0 && border.a > 0) {
    const i = borderWidth / 2;
    (r > 0 ? g.roundRect(i, i, w - borderWidth, h - borderWidth, Math.max(0, r - i)) : g.rect(i, i, w - borderWidth, h - borderWidth)).stroke({ width: borderWidth, color: num(border), alpha: border.a });
  }
}

export function createControlVisual(): Container {
  return new Container();
}

/** Updates a control's visual (its Container is positioned by the caller). */
export function updateControl(v: UiVisual, n: Control, ctx: UiContext) {
  const size = n.getSize();
  const w = size.x;
  const h = size.y;
  const c = v.obj;
  if (n instanceof ColorRect) {
    const key = `cr|${w}|${h}|${n.color.toHex(true)}`;
    if (key === v.key) return;
    v.key = key;
    const g = ensure(c, 0, () => new Graphics());
    box(g, w, h, n.color, 0, null, 0);
  } else if (n instanceof Panel) {
    const key = `p|${w}|${h}|${n.bgColor.toHex(true)}|${n.borderColor.toHex(true)}|${n.borderWidth}|${n.cornerRadius}`;
    if (key === v.key) return;
    v.key = key;
    box(ensure(c, 0, () => new Graphics()), w, h, n.bgColor, n.cornerRadius, n.borderColor, n.borderWidth);
  } else if (n instanceof Label) {
    const key = `l|${w}|${h}|${n.text}|${n.fontSize}|${n.fontColor.toHex(true)}|${n.outlineSize}|${n.outlineColor.toHex(true)}|${n.horizontalAlignment}|${n.verticalAlignment}|${n.autowrap}`;
    if (key === v.key) return;
    v.key = key;
    const t = ensure(c, 0, () => new Text({ text: '' }));
    t.style = textStyle(n.fontSize, n.fontColor, n.horizontalAlignment, n.outlineSize, n.outlineColor, n.autowrap ? w : 0);
    t.text = n.text;
    t.alpha = n.fontColor.a;
    setMeasured(n, t.width, t.height, ctx);
    align(t, w, h, n.horizontalAlignment, n.verticalAlignment);
  } else if (n instanceof Button) {
    const state = n.getDrawState();
    const key = `b|${w}|${h}|${n.text}|${state}|${n.flat}|${n.fontSize}|${n.fontColor.toHex(true)}|${n.color.toHex(true)}|${n.hoverColor.toHex(true)}|${n.pressedColor.toHex(true)}|${n.borderColor.toHex(true)}|${n.borderWidth}|${n.cornerRadius}|${n.horizontalAlignment}`;
    if (key === v.key) return;
    v.key = key;
    const bg = state === 'pressed' ? n.pressedColor : state === 'hover' ? n.hoverColor : n.color;
    const showBg = !n.flat || state === 'hover' || state === 'pressed';
    box(ensure(c, 0, () => new Graphics()), w, h, showBg ? bg : null, n.cornerRadius, showBg ? n.borderColor : null, n.borderWidth);
    const t = ensure(c, 1, () => new Text({ text: '' }));
    t.style = textStyle(n.fontSize, n.fontColor, n.horizontalAlignment);
    t.text = n.text;
    t.alpha = n.fontColor.a * (state === 'disabled' ? 0.45 : 1);
    setMeasured(n, t.width, t.height, ctx);
    align(t, w, h, n.horizontalAlignment, 'center');
    if (n.horizontalAlignment === 'left') t.x = 12;
    else if (n.horizontalAlignment === 'right') t.x = w - t.width - 12;
    c.alpha = state === 'disabled' ? 0.6 : 1;
  } else if (n instanceof ProgressBar) {
    const pct = Math.round(n.ratio * 100);
    const key = `pb|${w}|${h}|${n.ratio}|${n.fillMode}|${n.showPercentage}|${n.bgColor.toHex(true)}|${n.fillColor.toHex(true)}|${n.fontColor.toHex(true)}|${n.fontSize}`;
    if (key === v.key) return;
    v.key = key;
    const g = ensure(c, 0, () => new Graphics());
    box(g, w, h, n.bgColor, Math.min(4, h / 2), null, 0);
    const r = n.ratio;
    if (r > 0) {
      let rect: [number, number, number, number];
      if (n.fillMode === 'beginToEnd') rect = [0, 0, w * r, h];
      else if (n.fillMode === 'endToBegin') rect = [w * (1 - r), 0, w * r, h];
      else if (n.fillMode === 'topToBottom') rect = [0, 0, w, h * r];
      else rect = [0, h * (1 - r), w, h * r];
      g.roundRect(...rect, Math.min(4, rect[2] / 2, rect[3] / 2)).fill({ color: num(n.fillColor), alpha: n.fillColor.a });
    }
    const t = ensure(c, 1, () => new Text({ text: '' }));
    t.visible = n.showPercentage;
    if (n.showPercentage) {
      t.style = textStyle(n.fontSize, n.fontColor, 'center');
      t.text = `${pct}%`;
      t.alpha = n.fontColor.a;
      align(t, w, h, 'center', 'center');
    }
  } else if (n instanceof TextureRect) {
    const path = n.texture?.resourcePath ?? null;
    const tex = path ? ctx.texture(path) : null;
    const key = `tr|${w}|${h}|${path}|${!!tex}|${n.stretchMode}|${n.flipH}|${n.flipV}`;
    if (key === v.key) return;
    v.key = key;
    for (const old of c.removeChildren()) old.destroy();
    c.mask = null;
    if (!tex || w <= 0 || h <= 0) return;
    drawTextureRect(c, tex, w, h, n);
  }
}

/** The child at `index` of `c`, created on first use. */
function ensure<T extends Container>(c: Container, index: number, make: () => T): T {
  const existing = c.children[index] as T | undefined;
  if (existing) return existing;
  const obj = make();
  c.addChildAt(obj, Math.min(index, c.children.length));
  return obj;
}

function drawTextureRect(c: Container, tex: Texture, w: number, h: number, n: TextureRect) {
  const tw = tex.width;
  const th = tex.height;
  const flip = (s: Sprite | TilingSprite, x: number, y: number, sw: number, sh: number) => {
    s.width = sw;
    s.height = sh;
    s.x = n.flipH ? x + sw : x;
    s.y = n.flipV ? y + sh : y;
    if (n.flipH) s.scale.x *= -1;
    if (n.flipV) s.scale.y *= -1;
  };
  switch (n.stretchMode) {
    case 'tile': {
      const s = new TilingSprite({ texture: tex, width: w, height: h });
      c.addChild(s);
      return;
    }
    case 'keep':
    case 'keepCentered': {
      const s = new Sprite(tex);
      c.addChild(s);
      const x = n.stretchMode === 'keepCentered' ? (w - tw) / 2 : 0;
      const y = n.stretchMode === 'keepCentered' ? (h - th) / 2 : 0;
      flip(s, x, y, tw, th);
      clip(c, w, h);
      return;
    }
    case 'keepAspect':
    case 'keepAspectCentered':
    case 'keepAspectCovered': {
      const k = n.stretchMode === 'keepAspectCovered' ? Math.max(w / tw, h / th) : Math.min(w / tw, h / th);
      const sw = tw * k;
      const sh = th * k;
      const centred = n.stretchMode !== 'keepAspect';
      const s = new Sprite(tex);
      c.addChild(s);
      flip(s, centred ? (w - sw) / 2 : 0, centred ? (h - sh) / 2 : 0, sw, sh);
      if (n.stretchMode === 'keepAspectCovered') clip(c, w, h);
      return;
    }
    default: {
      const s = new Sprite(tex);
      c.addChild(s);
      flip(s, 0, 0, w, h);
    }
  }
}

/** Clips a container's content to its w×h box. */
function clip(c: Container, w: number, h: number) {
  const m = new Graphics().rect(0, 0, w, h).fill({ color: 0xffffff });
  c.addChild(m);
  c.mask = m;
}

/** A sub-rectangle of a texture (sprite sheets, tile atlases). */
export function subTexture(source: Texture, x: number, y: number, w: number, h: number): Texture | null {
  if (x < 0 || y < 0 || x + w > source.width + 1e-6 || y + h > source.height + 1e-6 || w <= 0 || h <= 0) return null;
  return new Texture({ source: source.source, frame: new Rectangle(x, y, w, h) });
}
