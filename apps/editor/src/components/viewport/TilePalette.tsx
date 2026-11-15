/**
 * Tile painting for TileMapLayer: a palette of the layer's atlas tiles shown over the 2D viewport
 * while one tile map is selected. With painting on, dragging in the viewport paints the picked
 * tile (right button, or the eraser, removes tiles). Viewport2D does the painting; this holds
 * the tool state and draws the palette.
 */
import { useMemo } from 'react';
import { create } from 'zustand';
import { Brush, Eraser } from 'lucide-react';
import { findDocNode, nodeTypes, tileFallbackColor, type NodeDoc } from '@gs/core';
import { useEditor, activeScenePath } from '@editor/store/editor';
import { assetUrl } from '@editor/services/assets';
import { IconButton, cx } from '../ui/primitives';

interface TilePaintState {
  /** Painting instead of selecting/moving (while a TileMapLayer is selected). */
  painting: boolean;
  erase: boolean;
  atlas: [number, number];
  set(patch: Partial<Omit<TilePaintState, 'set'>>): void;
}

export const useTilePaint = create<TilePaintState>()((set) => ({
  painting: false,
  erase: false,
  atlas: [0, 0],
  set: (patch) => set(patch),
}));

/** The selected TileMapLayer's scene node, when exactly one is selected. */
export function selectedTileMap(s = useEditor.getState()): { scenePath: string; node: NodeDoc } | null {
  const scenePath = activeScenePath(s);
  const scene = scenePath ? s.project?.scenes[scenePath] : undefined;
  if (!scenePath || !scene || s.selection.length !== 1) return null;
  const hit = findDocNode(scene, s.selection[0]);
  return hit && nodeTypes.isA(hit.node.type, 'TileMapLayer') ? { scenePath, node: hit.node } : null;
}

const SWATCH = 30;
const MAX_TILES = 256;

export function TilePalette() {
  const node = useEditor((s) => selectedTileMap(s)?.node ?? null);
  const assets = useEditor((s) => s.project?.assets);
  const tool = useTilePaint();
  const tiles = useMemo(() => {
    if (!node) return [];
    const props = node.props ?? {};
    const size = (Array.isArray(props.tileSize) ? props.tileSize : [16, 16]) as number[];
    const path = typeof props.tileSet === 'string' ? props.tileSet : null;
    const info = path ? assets?.[path] : undefined;
    if (!info?.width || !info.height) return Array.from({ length: 8 }, (_, i) => ({ ax: i, ay: 0, path: null as string | null, size, info: null as null | { width: number; height: number } }));
    const cols = Math.max(1, Math.floor(info.width / size[0]));
    const rows = Math.max(1, Math.floor(info.height / size[1]));
    const out: { ax: number; ay: number; path: string | null; size: number[]; info: { width: number; height: number } | null }[] = [];
    for (let y = 0; y < rows && out.length < MAX_TILES; y++) for (let x = 0; x < cols && out.length < MAX_TILES; x++) out.push({ ax: x, ay: y, path, size, info: { width: info.width, height: info.height } });
    return out;
  }, [node, assets]);
  if (!node) return null;
  return (
    <div className="pointer-events-auto absolute bottom-2 left-2 z-10 flex max-h-[45%] max-w-[min(420px,calc(100%-16px))] flex-col gap-1 rounded-lg border border-border bg-panel/95 p-1.5 shadow-xl backdrop-blur" data-testid="tile-palette">
      <div className="flex items-center gap-1">
        <IconButton label="Paint tiles (drag in the viewport)" active={tool.painting && !tool.erase} onClick={() => tool.set({ painting: !(tool.painting && !tool.erase), erase: false })} data-testid="tile-paint">
          <Brush size={14} />
        </IconButton>
        <IconButton label="Erase tiles (or right-drag while painting)" active={tool.painting && tool.erase} onClick={() => tool.set({ painting: !(tool.painting && tool.erase), erase: true })} data-testid="tile-erase">
          <Eraser size={14} />
        </IconButton>
        <span className="truncate px-1 text-[11px] text-muted">{tool.painting ? (tool.erase ? 'Erasing: drag to remove tiles' : `Painting tile ${tool.atlas[0]}, ${tool.atlas[1]}`) : 'Tiles'}</span>
      </div>
      <div className="flex flex-wrap gap-1 overflow-auto">
        {tiles.map((t) => {
          const url = t.path ? assetUrl(t.path) : null;
          const k = SWATCH / Math.max(t.size[0], t.size[1]);
          const picked = tool.atlas[0] === t.ax && tool.atlas[1] === t.ay;
          return (
            <button
              key={`${t.ax},${t.ay}`}
              title={`Tile ${t.ax}, ${t.ay}`}
              onClick={() => tool.set({ atlas: [t.ax, t.ay], painting: true, erase: false })}
              className={cx('shrink-0 rounded border', picked ? 'border-accent ring-1 ring-accent' : 'border-border hover:border-muted')}
              style={{
                width: SWATCH,
                height: SWATCH,
                imageRendering: 'pixelated',
                ...(url && t.info
                  ? { backgroundImage: `url(${url})`, backgroundSize: `${t.info.width * k}px ${t.info.height * k}px`, backgroundPosition: `${-t.ax * t.size[0] * k}px ${-t.ay * t.size[1] * k}px`, backgroundRepeat: 'no-repeat' }
                  : { background: tileFallbackColor(t.ax, t.ay).toHex() }),
              }}
              data-testid={`tile-${t.ax}-${t.ay}`}
            />
          );
        })}
      </div>
    </div>
  );
}
