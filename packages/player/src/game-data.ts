/** The data a running game needs (a subset of the project: no script sources, no editor state). */
import { nodeTypes, walkDoc, type AssetInfo, type NodeRegistry, type SceneDoc } from '@gs/core';
import type { ProjectSettings } from '@gs/project';

export interface GameData {
  name: string;
  settings: ProjectSettings;
  scenes: Record<string, SceneDoc>;
  assets: Record<string, AssetInfo>;
  /** Scene to start with (the main scene, or the one being tested in the editor). */
  startScene: string;
}

export type RuntimeModuleName = 'render2d' | 'render3d' | 'physics2d' | 'physics3d';

/** Which optional runtime modules the game uses, so exports ship only what's needed. */
export function requiredModules(scenes: Record<string, SceneDoc>, registry: NodeRegistry = nodeTypes): RuntimeModuleName[] {
  const need = new Set<RuntimeModuleName>();
  for (const scene of Object.values(scenes)) {
    walkDoc(scene.root, (n) => {
      const info = registry.get(n.type);
      if (!info) return;
      const dim = registry.dimension(n.type);
      if (dim === '2d') need.add('render2d');
      if (dim === '3d' || n.type === 'WorldEnvironment') need.add('render3d');
      if (info.category === 'Physics 2D') need.add('physics2d');
      // Tile maps collide through the 2D physics server unless collision is switched off.
      if (registry.isA(n.type, 'TileMapLayer') && n.props?.collisionEnabled !== false) need.add('physics2d');
      if (info.category === 'Physics 3D') need.add('physics3d');
    });
  }
  return (['render2d', 'render3d', 'physics2d', 'physics3d'] as const).filter((m) => need.has(m));
}
