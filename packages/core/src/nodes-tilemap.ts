/**
 * TileMapLayer (Godot 4.3's name): a grid of tiles cut from one atlas texture.
 *
 * Simplifications compared with Godot: the "tile set" is a single texture split into `tileSize`
 * cells (no margins or separation), tiles are addressed by their atlas coordinates, and collision
 * is per tile: every tile (or only the atlas tiles listed in `solidTiles`) is a solid square.
 * Without a texture tiles are drawn as coloured squares, which is handy for prototyping.
 *
 * Cells are stored compactly as a flat list: x, y, atlasX, atlasY for each tile.
 */
import { Color, Rect2, Vector2 } from '@gs/shared';
import { CollisionObject2D } from './physics';
import type { Texture } from './resources';

const OFFSET = 1 << 20;
const key = (x: number, y: number) => (x + OFFSET) * 2 * OFFSET + (y + OFFSET);
const unkey = (k: number): [number, number] => [Math.floor(k / (2 * OFFSET)) - OFFSET, (k % (2 * OFFSET)) - OFFSET];

/** Colour of an atlas tile when the layer has no texture (stable per atlas coordinate). */
export function tileFallbackColor(ax: number, ay: number): Color {
  const palette = ['#5b8def', '#4ade80', '#f5a524', '#f87171', '#a78bfa', '#2dd4bf', '#f472b6', '#94a3b8'];
  return Color.fromHex(palette[(ax + ay * 3) % palette.length]);
}

export class TileMapLayer extends CollisionObject2D {
  static override readonly typeName: string = 'TileMapLayer';
  /** Atlas texture the tiles are cut from. */
  tileSet: Texture | null = null;
  private _tileSize = new Vector2(16, 16);
  /** Tiles collide (as static geometry) with bodies whose mask includes this layer. */
  collisionEnabled = true;
  /** Atlas tiles that collide; empty = every tile. */
  solidTiles: Vector2[] = [];
  friction = 1;
  bounce = 0;
  private map = new Map<number, number>();
  /** @internal Bumped on every change, so renderers and physics rebuild only when needed. */
  __version = 0;

  get tileSize(): Vector2 {
    return this._tileSize;
  }
  set tileSize(v: { x: number; y: number }) {
    this._tileSize = new Vector2(Math.max(1, v.x), Math.max(1, v.y));
    this.changed();
  }

  /** All tiles as a flat list: x, y, atlasX, atlasY for each (sorted by row, then column). */
  get cells(): number[] {
    const out: number[] = [];
    const keys = [...this.map.keys()].sort((a, b) => {
      const [ax, ay] = unkey(a);
      const [bx, by] = unkey(b);
      return ay - by || ax - bx;
    });
    for (const k of keys) {
      const [x, y] = unkey(k);
      const atlas = this.map.get(k)!;
      out.push(x, y, atlas >> 12, atlas & 0xfff);
    }
    return out;
  }
  set cells(flat: readonly number[]) {
    this.map.clear();
    for (let i = 0; i + 3 < flat.length; i += 4) {
      const [x, y, ax, ay] = [flat[i], flat[i + 1], flat[i + 2], flat[i + 3]];
      if ([x, y, ax, ay].every(Number.isInteger) && ax >= 0 && ay >= 0 && ax < 4096 && ay < 4096) this.map.set(key(x, y), (ax << 12) | ay);
    }
    this.changed();
  }

  private changed() {
    this.__version++;
    this.__shapesChanged();
  }

  /** Places the atlas tile `atlasCoords` at map cell `coords`. */
  setCell(coords: Vector2, atlasCoords: Vector2 = new Vector2(0, 0)) {
    const ax = Math.floor(atlasCoords.x);
    const ay = Math.floor(atlasCoords.y);
    if (ax < 0 || ay < 0) return this.eraseCell(coords);
    this.map.set(key(Math.floor(coords.x), Math.floor(coords.y)), (Math.min(ax, 4095) << 12) | Math.min(ay, 4095));
    this.changed();
  }
  eraseCell(coords: Vector2) {
    if (this.map.delete(key(Math.floor(coords.x), Math.floor(coords.y)))) this.changed();
  }
  /** The atlas coordinates at a cell, or null when it is empty. */
  getCell(coords: Vector2): Vector2 | null {
    const v = this.map.get(key(Math.floor(coords.x), Math.floor(coords.y)));
    return v === undefined ? null : new Vector2(v >> 12, v & 0xfff);
  }
  /** Godot's get_cell_atlas_coords: (-1, -1) for an empty cell. */
  getCellAtlasCoords(coords: Vector2): Vector2 {
    return this.getCell(coords) ?? new Vector2(-1, -1);
  }
  hasCell(coords: Vector2) {
    return this.map.has(key(Math.floor(coords.x), Math.floor(coords.y)));
  }
  getUsedCells(): Vector2[] {
    return [...this.map.keys()].map((k) => Vector2.fromArray(unkey(k)));
  }
  /** Cells using one atlas tile. */
  getUsedCellsByAtlas(atlasCoords: Vector2): Vector2[] {
    const want = (atlasCoords.x << 12) | atlasCoords.y;
    return [...this.map.entries()].filter(([, v]) => v === want).map(([k]) => Vector2.fromArray(unkey(k)));
  }
  /** Bounding rectangle of the used cells, in cells. */
  getUsedRect(): Rect2 {
    if (!this.map.size) return new Rect2();
    const cells = this.getUsedCells();
    const r = Rect2.fromPoints(cells);
    return new Rect2(r.x, r.y, r.width + 1, r.height + 1);
  }
  getCellCount() {
    return this.map.size;
  }
  clear() {
    if (!this.map.size) return;
    this.map.clear();
    this.changed();
  }
  /** Calls `fn` for every tile (fast iteration for renderers and physics). */
  forEachCell(fn: (x: number, y: number, atlasX: number, atlasY: number) => void) {
    for (const [k, v] of this.map) {
      const [x, y] = unkey(k);
      fn(x, y, v >> 12, v & 0xfff);
    }
  }

  /** Local position → map cell. */
  localToMap(local: Vector2): Vector2 {
    return new Vector2(Math.floor(local.x / this._tileSize.x), Math.floor(local.y / this._tileSize.y));
  }
  /** Map cell → local position of the cell's centre. */
  mapToLocal(cell: Vector2): Vector2 {
    return new Vector2((Math.floor(cell.x) + 0.5) * this._tileSize.x, (Math.floor(cell.y) + 0.5) * this._tileSize.y);
  }

  /** Whether an atlas tile collides. */
  isSolidTile(ax: number, ay: number) {
    return this.collisionEnabled && (this.solidTiles.length === 0 || this.solidTiles.some((t) => t.x === ax && t.y === ay));
  }

  /**
   * Solid areas as rectangles in local pixels: runs of solid tiles in each row are merged, so a
   * floor is one collider and characters slide along it without catching on tile seams.
   */
  getCollisionRects(): Rect2[] {
    if (!this.collisionEnabled) return [];
    const rows = new Map<number, number[]>();
    this.forEachCell((x, y, ax, ay) => {
      if (!this.isSolidTile(ax, ay)) return;
      let row = rows.get(y);
      if (!row) rows.set(y, (row = []));
      row.push(x);
    });
    const { x: tw, y: th } = this._tileSize;
    const out: Rect2[] = [];
    for (const [y, xs] of rows) {
      xs.sort((a, b) => a - b);
      let start = xs[0];
      let prev = xs[0];
      for (let i = 1; i <= xs.length; i++) {
        const x = xs[i];
        if (x === prev + 1) {
          prev = x;
          continue;
        }
        out.push(new Rect2(start * tw, y * th, (prev - start + 1) * tw, th));
        start = prev = x;
      }
    }
    return out;
  }

  /** @internal Physics rebuilds the colliders when this changes. */
  __collisionKey() {
    return `${this.__version}|${this._tileSize.x},${this._tileSize.y}|${this.collisionEnabled}|${this.solidTiles.map((t) => `${t.x},${t.y}`).join(';')}|${this.collisionLayer},${this.collisionMask}`;
  }

  override getLocalBounds() {
    if (!this.map.size) return null;
    const r = this.getUsedRect();
    return new Rect2(r.x * this._tileSize.x, r.y * this._tileSize.y, r.width * this._tileSize.x, r.height * this._tileSize.y);
  }
}
