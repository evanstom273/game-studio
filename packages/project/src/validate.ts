/**
 * Project-wide checks: broken references, duplicate ids, unknown node types, configuration
 * warnings. Used when loading, by the Problems panel and by MCP's get_diagnostics.
 */
import { nodeTypes, walkDoc, type NodeDoc, type NodeRegistry, type SceneDoc } from '@gs/core';
import type { ProjectDoc } from './schema';

export interface Diagnostic {
  severity: 'error' | 'warning';
  message: string;
  /** File the problem is in (scene, script or asset path). */
  file?: string;
  nodeId?: string;
  nodePath?: string;
  line?: number;
  column?: number;
  source: 'project' | 'script' | 'runtime';
}

/** Paths of scenes that `scenePath` instances, directly or indirectly. */
export function instancedScenes(project: ProjectDoc, scenePath: string, seen = new Set<string>()): Set<string> {
  const scene = project.scenes[scenePath];
  if (!scene || seen.has(scenePath)) return seen;
  walkDoc(scene.root, (n) => {
    if (n.instance && !seen.has(n.instance)) {
      seen.add(n.instance);
      instancedScenes(project, n.instance, seen);
    }
  });
  return seen;
}

/** Resource paths a node's props reference (textures, sounds, models, nested materials). */
export function nodeResourceRefs(n: NodeDoc, registry: NodeRegistry = nodeTypes): { prop: string; path: string; kind: string }[] {
  const out: { prop: string; path: string; kind: string }[] = [];
  for (const [key, value] of Object.entries(n.props ?? {})) {
    const def = registry.property(n.type, key);
    if (!def || value === null) continue;
    if (def.type === 'resource' && typeof value === 'string') out.push({ prop: key, path: value, kind: def.resource! });
    if (def.type === 'mesh' && (value as { type?: string }).type === 'model') out.push({ prop: key, path: String((value as { path?: unknown }).path), kind: 'model' });
    if (def.type === 'material' && typeof (value as { albedoTexture?: unknown }).albedoTexture === 'string') out.push({ prop: key, path: (value as { albedoTexture: string }).albedoTexture, kind: 'texture' });
  }
  return out;
}

const KIND_ASSET: Record<string, string> = { texture: 'image', audio: 'audio', model: 'model', font: 'font' };

export function resourceExists(project: ProjectDoc, kind: string, path: string) {
  if (kind === 'scene') return !!project.scenes[path];
  return project.assets[path]?.kind === KIND_ASSET[kind];
}

function scenePathOf(scene: SceneDoc, target: string): string {
  const parts: string[] = [];
  const visit = (n: NodeDoc, trail: string[]): boolean => {
    if (n.id === target) {
      parts.push(...trail);
      return true;
    }
    return (n.children ?? []).some((c) => visit(c, [...trail, c.name]));
  };
  visit(scene.root, []);
  return parts.join('/') || '.';
}

export function projectDiagnostics(project: ProjectDoc, registry: NodeRegistry = nodeTypes): Diagnostic[] {
  const out: Diagnostic[] = [];
  const s = project.settings;
  if (!s.mainScene) out.push({ severity: 'warning', message: 'No main scene is set, so exported games have nothing to start. Set one in Project settings.', source: 'project' });
  else if (!project.scenes[s.mainScene]) out.push({ severity: 'error', message: `The main scene "${s.mainScene}" does not exist.`, source: 'project' });

  const all = new Map<string, string>();
  for (const [kind, map] of [['scene', project.scenes], ['script', project.scripts], ['asset', project.assets]] as const) {
    for (const p of Object.keys(map)) {
      if (all.has(p)) out.push({ severity: 'error', message: `"${p}" is both a ${all.get(p)} and a ${kind}.`, file: p, source: 'project' });
      all.set(p, kind);
    }
  }

  for (const [path, scene] of Object.entries(project.scenes)) {
    const ids = new Set<string>();
    if (instancedScenes(project, path).has(path)) out.push({ severity: 'error', message: `Scene instances itself (directly or through other scenes).`, file: path, source: 'project' });
    if (scene.root.instance) out.push({ severity: 'error', message: 'A scene root cannot be an instance of another scene.', file: path, nodeId: scene.root.id, nodePath: '.', source: 'project' });
    walkDoc(scene.root, (n, parent) => {
      const at = { file: path, nodeId: n.id, nodePath: scenePathOf(scene, n.id), source: 'project' as const };
      if (ids.has(n.id)) out.push({ severity: 'error', message: `Duplicate node id "${n.id}".`, ...at });
      ids.add(n.id);
      const names = (n.children ?? []).map((c) => c.name);
      const dup = names.find((x, i) => names.indexOf(x) !== i);
      if (dup) out.push({ severity: 'error', message: `Two children are called "${dup}".`, ...at });
      if (!registry.has(n.type)) out.push({ severity: 'error', message: `Unknown node type "${n.type}".`, ...at });
      if (n.instance && !project.scenes[n.instance]) out.push({ severity: 'error', message: `Instanced scene "${n.instance}" does not exist.`, ...at });
      if (n.script && project.scripts[n.script] === undefined) out.push({ severity: 'error', message: `Script "${n.script}" does not exist.`, ...at });
      if (!registry.has(n.type)) return;
      for (const [key] of Object.entries(n.props ?? {})) if (!registry.property(n.type, key)) out.push({ severity: 'warning', message: `${n.type} has no property "${key}" (ignored).`, ...at });
      for (const ref of nodeResourceRefs(n, registry)) if (!resourceExists(project, ref.kind, ref.path)) out.push({ severity: 'error', message: `${n.name}.${ref.prop}: ${ref.kind} "${ref.path}" is not in the project.`, ...at });
      const childTypes = (n.children ?? []).map((c) => c.type);
      // An instance's own children come from its scene; count them for the warning check.
      if (n.instance && project.scenes[n.instance]) childTypes.push(...(project.scenes[n.instance].root.children ?? []).map((c) => c.type));
      for (const w of registry.warnings({ node: n, parentType: parent?.type ?? null, childTypes })) out.push({ severity: 'warning', message: `${n.name}: ${w}`, ...at });
    });
    for (const c of scene.connections ?? []) {
      if (!ids.has(c.from) || !ids.has(c.to)) out.push({ severity: 'error', message: `Signal connection ${c.signal} → ${c.method} refers to a node that no longer exists.`, file: path, source: 'project' });
    }
  }
  return out;
}

/** Issues worth telling the user about when a project is opened (errors only). */
export function validateProjectReferences(project: ProjectDoc): string[] {
  return projectDiagnostics(project)
    .filter((d) => d.severity === 'error')
    .map((d) => (d.file ? `${d.file}: ${d.message}` : d.message));
}
