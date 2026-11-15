/**
 * MCP tools for visual scripts (.vgraph): read a graph, discover node types, and edit graphs with
 * Coding Studio's atomic edit operations. Edits are saved with the ordinary write_script command,
 * so they are one undo step and appear live in open editors like any other change.
 */
import { GameStudioError } from '@gs/shared';
import { nodeTypes } from '@gs/core';
import type { Command, ProjectDoc } from '@gs/project';
import { makeNodeContext, nodeInfo } from '@cs/compiler-core';
import type { FunctionDecl, GraphNode, JsonValue, ScriptDoc } from '@cs/graph-core';
import { applyVisualOps, classNameFor, compileVisualScript, gameStudioToolchain, isVisualScriptPath, newVisualScript, OpError, parseVisualScript, serializeVisualScript, EVENTS, type EditOp } from '@gs/visual';

export const VISUAL_METHODS = ['list_visual_nodes', 'get_visual_node', 'get_visual_script', 'create_visual_script', 'edit_visual_script'] as const;
export type VisualMethod = (typeof VISUAL_METHODS)[number];
export const VISUAL_READ: readonly string[] = ['list_visual_nodes', 'get_visual_node', 'get_visual_script'];

export interface VisualHost {
  project(ref?: string): Promise<ProjectDoc>;
  edit(doc: ProjectDoc, commands: Command[], label: string): Promise<{ revision: string; project: ProjectDoc }>;
  scenePath(doc: ProjectDoc, scene?: string): string;
  checkRevision(doc: ProjectDoc, expected: unknown): void;
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

function readScript(doc: ProjectDoc, path: string): ScriptDoc {
  if (!isVisualScriptPath(path)) throw new GameStudioError('E_BAD_PATH', `"${path}" isn't a visual script (they end in .vgraph). Use read_script for code.`);
  const source = doc.scripts[path];
  if (source === undefined) throw new GameStudioError('E_NOT_FOUND', `No visual script "${path}". Visual scripts: ${Object.keys(doc.scripts).filter(isVisualScriptPath).join(', ') || '(none)'}`);
  try {
    return parseVisualScript(source);
  } catch (e) {
    throw new GameStudioError('E_INVALID', e instanceof Error ? e.message : String(e));
  }
}

function describeNode(script: ScriptDoc, fn: FunctionDecl, n: GraphNode) {
  const tc = gameStudioToolchain();
  const info = nodeInfo(tc, makeNodeContext(tc, script, fn), n);
  return {
    id: n.id,
    type: n.type,
    title: info.title,
    ...(Object.keys(n.props).length ? { props: n.props } : {}),
    ...(Object.keys(n.inputs).length ? { inputs: n.inputs } : {}),
    pins: info.ports.map((p) => `${p.direction === 'in' ? '→' : '←'}${p.id}${p.kind === 'exec' ? ' (exec)' : p.type ? `: ${tc.adapter.types.format(p.type)}` : ''}`).join(', '),
    position: n.position,
  };
}

/** The script in a compact form an AI can reason about. */
export function summarizeVisualScript(path: string, script: ScriptDoc, withCode: boolean) {
  const compiled = compileVisualScript(path, serializeVisualScript(script));
  return {
    path,
    className: script.name,
    extends: script.settings.extends,
    variables: script.variables.map((v) => ({ id: v.id, name: v.name, type: v.type, ...(v.default !== undefined ? { default: v.default } : {}), ...(v.exported ? { exported: true } : {}), ...(v.constant ? { constant: true } : {}) })),
    signals: script.signals.map((s) => ({ id: s.id, name: s.name, params: s.params.map((p) => `${p.name}: ${p.type}`) })),
    functions: script.functions.map((f) => ({
      id: f.id,
      name: f.name,
      kind: f.kind,
      ...(f.event ? { event: f.event } : {}),
      params: f.params.map((p) => `${p.name}: ${p.type}`),
      returnType: f.returnType,
      ...(f.locals.length ? { locals: f.locals.map((l) => ({ id: l.id, name: l.name, type: l.type })) } : {}),
      nodes: f.graph.nodes.map((n) => describeNode(script, f, n)),
      edges: f.graph.edges.map((e) => ({ id: e.id, from: `${e.from.node}.${e.from.port}`, to: `${e.to.node}.${e.to.port}` })),
    })),
    compiled: compiled.ok,
    diagnostics: compiled.diagnostics.map((d) => ({ severity: d.severity, message: d.message })),
    ...(withCode && compiled.ok ? { code: compiled.code } : {}),
  };
}

function nodeSummary(type: string) {
  const def = gameStudioToolchain().registry.get(type);
  if (!def) return null;
  return { type: def.type, title: def.title, category: def.category, flavor: def.flavor, description: def.description };
}

/** Functions may be named by name in ops ("graph": "_ready"); the edit layer wants ids. */
function resolveFunctionRefs(script: ScriptDoc, ops: EditOp[]): EditOp[] {
  const byName = new Map(script.functions.map((f) => [f.name, f.id]));
  const fix = (v: unknown) => (typeof v === 'string' && !v.startsWith('$') && byName.has(v) ? byName.get(v)! : v);
  return ops.map((o) => {
    const x = { ...o } as Record<string, unknown>;
    for (const k of ['graph', 'function', 'owner']) if (k in x) x[k] = fix(x[k]);
    if (o.op === 'add_node' || o.op === 'update_node') {
      const props = { ...((x.props as Record<string, JsonValue>) ?? {}) };
      if (typeof props.method === 'string') props.method = fix(props.method) as string;
      if (x.props) x.props = props;
    }
    return x as unknown as EditOp;
  });
}

export async function handleVisual(host: VisualHost, method: VisualMethod, params: Record<string, unknown>): Promise<unknown> {
  const tc = gameStudioToolchain();
  switch (method) {
    case 'list_visual_nodes': {
      const query = str(params.query)?.toLowerCase();
      const category = str(params.category)?.toLowerCase();
      const limit = typeof params.limit === 'number' ? Math.min(Math.max(1, params.limit), 200) : 60;
      const all = tc.registry.available(tc.adapter.id, tc.adapter.capabilities);
      if (!query && !category) {
        const counts = new Map<string, number>();
        for (const d of all) counts.set(d.category, (counts.get(d.category) ?? 0) + 1);
        return { total: all.length, categories: [...counts].sort((a, b) => a[0].localeCompare(b[0])).map(([name, count]) => ({ name, count })), note: 'Pass query (e.g. "move and slide", "velocity", "is action pressed") or category to list nodes. Engine nodes are generated for every node type: Nodes/<Type> has Get/Set for each property and each method.' };
      }
      let list = query ? tc.registry.search(query, tc.adapter.id, tc.adapter.capabilities) : all;
      if (category) list = list.filter((d) => d.category.toLowerCase() === category || d.category.toLowerCase().startsWith(`${category}/`));
      return {
        total: list.length,
        nodes: list.slice(0, limit).map((d) => ({ type: d.type, title: d.title, category: d.category, flavor: d.flavor, description: d.description, ...(d.props.length ? { props: d.props.map((p) => p.key) } : {}), ...(d.presets?.length ? { presets: d.presets.slice(0, 12).map((p) => ({ title: p.title, props: p.props })) } : {}) })),
      };
    }
    case 'get_visual_node': {
      const type = str(params.type) ?? '';
      const def = tc.registry.get(type);
      if (!def) throw new GameStudioError('E_UNKNOWN_TYPE', `No visual-script node "${type}". Use list_visual_nodes.`);
      const probe = newVisualScript('Probe', str(params.extends) && nodeTypes.has(str(params.extends)!) ? str(params.extends)! : 'Node2D', ['_process']);
      const fn = probe.functions[0];
      const node: GraphNode = { id: 'probe', type, position: { x: 0, y: 0 }, props: { ...Object.fromEntries(def.props.map((p) => [p.key, p.default])), ...((params.props as Record<string, JsonValue>) ?? {}) }, inputs: {} };
      const info = nodeInfo(tc, makeNodeContext(tc, probe, fn), node);
      return {
        ...nodeSummary(type),
        props: def.props.map((p) => ({ key: p.key, label: p.label, kind: p.kind, default: p.default, ...(p.description ? { description: p.description } : {}), ...(p.options ? { options: p.options.map((o) => o.value) } : {}) })),
        ports: info.ports.map((p) => ({ id: p.id, name: p.name, direction: p.direction, kind: p.kind, ...(p.type ? { type: tc.adapter.types.format(p.type) } : {}), ...(p.default !== undefined ? { default: p.default } : {}), ...(p.required ? { required: true } : {}), ...(p.connectionOnly ? { connectionOnly: true } : {}), ...(p.description ? { description: p.description } : {}) })),
        ...(def.presets?.length ? { presets: def.presets.map((p) => ({ title: p.title, props: p.props })) } : {}),
        note: 'Exec pins: "exec" in, "then" out. Set inline values for unconnected data inputs with add_node/update_node "inputs": {portId: value}. Vectors as {"x":0,"y":0}.',
      };
    }
    case 'get_visual_script': {
      const doc = await host.project(str(params.project));
      const path = str(params.path) ?? '';
      return summarizeVisualScript(path, readScript(doc, path), params.code !== false);
    }
    case 'create_visual_script': {
      const doc = await host.project();
      host.checkRevision(doc, params.expected_revision);
      const path = str(params.path) ?? '';
      if (!isVisualScriptPath(path)) throw new GameStudioError('E_BAD_PATH', 'Visual script paths end in .vgraph, e.g. "scripts/player.vgraph".');
      if (doc.scripts[path] !== undefined) throw new GameStudioError('E_EXISTS', `"${path}" already exists. Use edit_visual_script to change it.`);
      const nodeType = str(params.nodeType) ?? 'Node2D';
      if (!nodeTypes.has(nodeType)) throw new GameStudioError('E_UNKNOWN_TYPE', `Unknown node type "${nodeType}". Use list_node_types.`);
      const events = Array.isArray(params.events) ? params.events.map(String) : undefined;
      for (const e of events ?? []) if (!EVENTS.some((x) => x.id === e)) throw new GameStudioError('E_INVALID', `Unknown event "${e}". Events: ${EVENTS.map((x) => x.id).join(', ')}`);
      const script = newVisualScript(str(params.className) ?? classNameFor(path), nodeType, events);
      const commands: Command[] = [{ op: 'write_script', path, source: serializeVisualScript(script) }];
      const attach = params.attach as { scene?: string; node: string } | undefined;
      if (attach) commands.push({ op: 'attach_script', scene: host.scenePath(doc, attach.scene), node: attach.node, script: path });
      const r = await host.edit(doc, commands, `Create ${path}`);
      return { ...summarizeVisualScript(path, script, false), revision: r.revision };
    }
    case 'edit_visual_script': {
      const doc = await host.project();
      host.checkRevision(doc, params.expected_revision);
      const path = str(params.path) ?? '';
      const script = readScript(doc, path);
      const ops = resolveFunctionRefs(script, (Array.isArray(params.ops) ? params.ops : []) as EditOp[]);
      if (!ops.length) throw new GameStudioError('E_INVALID', 'ops is empty');
      const fnRef = str(params.function);
      const fn = fnRef ? script.functions.find((f) => f.id === fnRef || f.name === fnRef) : undefined;
      if (fnRef && !fn) throw new GameStudioError('E_NOT_FOUND', `No function "${fnRef}" in ${path}. Functions: ${script.functions.map((f) => f.name).join(', ')}`);
      let applied: ReturnType<typeof applyVisualOps>;
      try {
        applied = applyVisualOps(script, ops, fn ? { functionId: fn.id } : {});
      } catch (e) {
        if (e instanceof OpError) throw new GameStudioError(e.code, `${e.opIndex !== undefined ? `Operation ${e.opIndex} (${ops[e.opIndex]?.op}): ` : ''}${e.message}`, { opIndex: e.opIndex });
        throw e;
      }
      const r = await host.edit(doc, [{ op: 'write_script', path, source: serializeVisualScript(applied.doc) }], `Edit ${path}`);
      const summary = summarizeVisualScript(path, applied.doc, params.code !== false);
      return { created: applied.created, ...(applied.warnings.length ? { warnings: applied.warnings } : {}), revision: r.revision, compiled: summary.compiled, diagnostics: summary.diagnostics, ...('code' in summary ? { code: summary.code } : {}), functions: summary.functions.map((f) => ({ id: f.id, name: f.name, nodes: f.nodes.length, edges: f.edges.length })) };
    }
  }
}
