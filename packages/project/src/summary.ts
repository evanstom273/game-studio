/** Compact descriptions of projects and scenes for MCP clients and the console. */
import { fnv1a64 } from '@gs/shared';
import { nodeTypes, walkDoc, type NodeRegistry, type SceneDoc } from '@gs/core';
import type { ProjectDoc } from './schema';

/** A revision string for optimistic concurrency (changes whenever the document changes). */
export function projectRevision(project: ProjectDoc) {
  const { updatedAt: _u, ...rest } = project;
  return fnv1a64(JSON.stringify(rest));
}

export function projectSummary(project: ProjectDoc) {
  return {
    id: project.id,
    name: project.name,
    revision: projectRevision(project),
    mainScene: project.settings.mainScene,
    display: `${project.settings.display.width}×${project.settings.display.height} (${project.settings.display.stretch})`,
    scenes: Object.entries(project.scenes).map(([path, s]) => ({ path, rootType: s.root.type, rootName: s.root.name, nodes: countNodes(s) })),
    scripts: Object.keys(project.scripts),
    assets: Object.values(project.assets).map((a) => ({ path: a.path, kind: a.kind, size: a.size, ...(a.width ? { width: a.width, height: a.height } : {}) })),
    inputActions: Object.keys(project.settings.input.actions),
  };
}

export function countNodes(scene: SceneDoc) {
  let n = 0;
  walkDoc(scene.root, () => {
    n++;
  });
  return n;
}

/** Plain-text outline of a scene ("Main (Node2D) #id\n  Player (CharacterBody2D) …"). */
export function sceneOutline(scene: SceneDoc, registry: NodeRegistry = nodeTypes) {
  const lines: string[] = [];
  walkDoc(scene.root, (n, _p, depth) => {
    const known = registry.has(n.type);
    const bits = [`${'  '.repeat(depth)}${n.name} (${n.type}${known ? '' : '?'})`, `#${n.id}`];
    if (n.script) bits.push(`script=${n.script}`);
    if (n.instance) bits.push(`instance=${n.instance}`);
    lines.push(bits.join(' '));
  });
  return lines.join('\n');
}
