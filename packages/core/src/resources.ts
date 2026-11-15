/**
 * Resources: shared, reference-counted-by-GC descriptors of project assets.
 *
 * Core never decodes binary data. A Texture is a path plus its known size; renderers turn it into
 * GPU textures through their own caches, the audio server decodes AudioStreams, and so on. That
 * keeps the core usable without a DOM (tests, the MCP Durable Object, the command layer).
 */
import { GameStudioError, extname } from '@gs/shared';
import type { ResourceKind } from './properties';
import type { SceneDoc } from './scene-format';

export type AssetKind = 'image' | 'audio' | 'model' | 'font' | 'other';

/** What the project knows about a binary asset (recorded at import time). */
export interface AssetInfo {
  path: string;
  kind: AssetKind;
  mime: string;
  size: number;
  /** SHA-256 of the bytes; the storage key. */
  hash: string;
  width?: number;
  height?: number;
}

export abstract class Resource {
  abstract readonly resourceType: string;
  constructor(readonly resourcePath: string) {}
}

export class Texture extends Resource {
  readonly resourceType = 'Texture';
  constructor(
    path: string,
    readonly width: number,
    readonly height: number,
  ) {
    super(path);
  }
}

export class AudioStream extends Resource {
  readonly resourceType = 'AudioStream';
}

export class ModelResource extends Resource {
  readonly resourceType = 'Model';
}

export class FontResource extends Resource {
  readonly resourceType = 'Font';
}

/** A scene file that can be instantiated any number of times (Godot's PackedScene). */
export class PackedScene extends Resource {
  readonly resourceType = 'PackedScene';
  constructor(
    path: string,
    readonly doc: SceneDoc,
    private readonly instantiateFn: (scene: PackedScene) => import('./node').Node,
  ) {
    super(path);
  }
  /** Creates a new node tree from this scene. Add it with `addChild`. */
  instantiate<T extends import('./node').Node = import('./node').Node>(): T {
    return this.instantiateFn(this) as T;
  }
}

export const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'];
export const AUDIO_EXT = ['.mp3', '.ogg', '.wav', '.m4a', '.aac', '.flac'];
export const MODEL_EXT = ['.glb', '.gltf'];
export const FONT_EXT = ['.ttf', '.otf', '.woff', '.woff2'];

export function assetKindForPath(path: string): AssetKind {
  const ext = extname(path);
  if (IMAGE_EXT.includes(ext)) return 'image';
  if (AUDIO_EXT.includes(ext)) return 'audio';
  if (MODEL_EXT.includes(ext)) return 'model';
  if (FONT_EXT.includes(ext)) return 'font';
  return 'other';
}

const KIND_FOR_RESOURCE: Record<ResourceKind, AssetKind | 'scene'> = { texture: 'image', audio: 'audio', model: 'model', font: 'font', scene: 'scene' };

export interface ResourceSource {
  asset(path: string): AssetInfo | undefined;
  scene(path: string): SceneDoc | undefined;
}

/**
 * Loads and caches resources by path. `load()` is synchronous: binaries are decoded lazily by the
 * servers that need them, and scene documents are already in memory.
 */
export class ResourceLoader {
  private cache = new Map<string, Resource>();
  constructor(
    private readonly source: ResourceSource,
    private readonly instantiate: (scene: PackedScene) => import('./node').Node,
  ) {}

  exists(path: string) {
    return !!(this.source.asset(path) ?? this.source.scene(path));
  }

  /** Loads any resource by path. Throws E_NOT_FOUND when the path doesn't exist. */
  load(path: string): Resource {
    const hit = this.cache.get(path);
    if (hit) return hit;
    const scene = this.source.scene(path);
    let res: Resource | undefined;
    if (scene) res = new PackedScene(path, scene, this.instantiate);
    else {
      const a = this.source.asset(path);
      if (a?.kind === 'image') res = new Texture(path, a.width ?? 0, a.height ?? 0);
      else if (a?.kind === 'audio') res = new AudioStream(path);
      else if (a?.kind === 'model') res = new ModelResource(path);
      else if (a?.kind === 'font') res = new FontResource(path);
    }
    if (!res) throw new GameStudioError('E_NOT_FOUND', `Resource "${path}" does not exist in this project`);
    this.cache.set(path, res);
    return res;
  }

  /** Like load(), but checks the kind and returns null instead of throwing (used for node properties). */
  loadKind(kind: ResourceKind, path: string): Resource | null {
    try {
      const r = this.load(path);
      const want = KIND_FOR_RESOURCE[kind];
      const got = r instanceof PackedScene ? 'scene' : r instanceof Texture ? 'image' : r instanceof AudioStream ? 'audio' : r instanceof ModelResource ? 'model' : 'font';
      return got === want ? r : null;
    } catch {
      return null;
    }
  }

  clear() {
    this.cache.clear();
  }
}
