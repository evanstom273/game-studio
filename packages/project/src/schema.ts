/**
 * The project document: everything about a game except binary asset bytes (those are stored by
 * content hash next to it). Validated with zod whenever it comes from outside (storage,
 * archives, MCP), versioned, and migrated forward.
 */
import { z } from 'zod';
import type { AssetInfo, InputBinding, SceneDoc } from '@gs/core';

export const PROJECT_FORMAT = 'game-studio';
export const PROJECT_FORMAT_VERSION = 1;

export const LIMITS = {
  nameLength: 100,
  idLength: 64,
  pathLength: 240,
  scriptBytes: 1_000_000,
  nodesPerScene: 10_000,
  depth: 128,
  scenes: 2_000,
  assets: 20_000,
  assetBytes: 100 * 1024 * 1024,
} as const;

export type StretchMode = 'fit' | 'expand' | 'stretch' | 'none';

export interface ProjectSettings {
  mainScene: string | null;
  display: {
    width: number;
    height: number;
    /** fit: letterbox · expand: show more world, no bars · stretch: fill, ignore aspect · none: 1:1 pixels */
    stretch: StretchMode;
    background: string;
    /** Nearest-neighbour texture filtering. */
    pixelArt: boolean;
  };
  physics: {
    ticksPerSecond: number;
    /** px/s² (y down) */
    gravity2d: [number, number];
    /** m/s² */
    gravity3d: [number, number, number];
  };
  input: {
    actions: Record<string, InputBinding[]>;
    /** On-screen controls in exported games and play mode. auto = on touch screens. */
    touchControls: 'auto' | 'always' | 'off';
  };
}

export interface ProjectDoc {
  format: typeof PROJECT_FORMAT;
  formatVersion: number;
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  settings: ProjectSettings;
  /** path → scene, e.g. "scenes/main.scene" */
  scenes: Record<string, SceneDoc>;
  /** path → TypeScript source, e.g. "scripts/player.ts" */
  scripts: Record<string, string>;
  /** path → metadata; bytes are stored by `hash` */
  assets: Record<string, AssetInfo>;
}

export const DEFAULT_SETTINGS: ProjectSettings = {
  mainScene: null,
  display: { width: 1152, height: 648, stretch: 'fit', background: '#1e2230', pixelArt: false },
  physics: { ticksPerSecond: 60, gravity2d: [0, 980], gravity3d: [0, -9.8, 0] },
  input: { actions: {}, touchControls: 'auto' },
};

// --- zod -------------------------------------------------------------------------------------------------------------

const name = z.string().min(1).max(LIMITS.nameLength);
const id = z.string().min(1).max(LIMITS.idLength).regex(/^[A-Za-z0-9_-]+$/, 'ids use letters, digits, _ and -');
const path = z.string().min(1).max(LIMITS.pathLength);
const json: z.ZodType<unknown> = z.unknown();

export interface NodeDocInput {
  id: string;
  name: string;
  type: string;
  props?: Record<string, unknown>;
  script?: string | null;
  scriptProps?: Record<string, unknown>;
  instance?: string;
  groups?: string[];
  children?: NodeDocInput[];
}

export const NodeDocSchema: z.ZodType<NodeDocInput> = z.lazy(() =>
  z.object({
    id,
    name,
    type: z.string().min(1).max(64),
    props: z.record(z.string(), json).optional(),
    script: path.nullable().optional(),
    scriptProps: z.record(z.string(), json).optional(),
    instance: path.optional(),
    groups: z.array(z.string().min(1).max(64)).max(64).optional(),
    children: z.array(NodeDocSchema).max(LIMITS.nodesPerScene).optional(),
  }),
);

export const ConnectionSchema = z.object({ from: id, signal: z.string().min(1).max(64), to: id, method: z.string().min(1).max(64) });

export const SceneDocSchema = z.object({ root: NodeDocSchema, connections: z.array(ConnectionSchema).max(10_000).optional() });

export const InputBindingSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('key'), code: z.string().min(1).max(32) }),
  z.object({ type: z.literal('mouseButton'), button: z.number().int().min(0).max(15) }),
  z.object({ type: z.literal('gamepadButton'), button: z.number().int().min(0).max(31) }),
  z.object({ type: z.literal('gamepadAxis'), axis: z.number().int().min(0).max(15), direction: z.union([z.literal(1), z.literal(-1)]) }),
]);

export const SettingsSchema = z.object({
  mainScene: path.nullable(),
  display: z.object({
    width: z.number().int().min(16).max(8192),
    height: z.number().int().min(16).max(8192),
    stretch: z.enum(['fit', 'expand', 'stretch', 'none']),
    background: z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/),
    pixelArt: z.boolean(),
  }),
  physics: z.object({
    ticksPerSecond: z.number().int().min(10).max(240),
    gravity2d: z.tuple([z.number(), z.number()]),
    gravity3d: z.tuple([z.number(), z.number(), z.number()]),
  }),
  input: z.object({
    actions: z.record(z.string().min(1).max(64), z.array(InputBindingSchema).max(32)),
    touchControls: z.enum(['auto', 'always', 'off']),
  }),
});

export const AssetInfoSchema = z.object({
  path,
  kind: z.enum(['image', 'audio', 'model', 'font', 'other']),
  mime: z.string().max(128),
  size: z.number().int().min(0).max(LIMITS.assetBytes),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  width: z.number().int().min(0).max(65536).optional(),
  height: z.number().int().min(0).max(65536).optional(),
});

export const ProjectDocSchema = z.object({
  format: z.literal(PROJECT_FORMAT),
  formatVersion: z.number().int().min(1),
  id,
  name,
  createdAt: z.number(),
  updatedAt: z.number(),
  settings: SettingsSchema,
  scenes: z.record(path, SceneDocSchema),
  scripts: z.record(path, z.string().max(LIMITS.scriptBytes)),
  assets: z.record(path, AssetInfoSchema),
});
