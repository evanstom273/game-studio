/**
 * The inspector: the selected node's properties (generated from the registry's metadata), its
 * script and the script's exported properties, groups and signal connections.
 */
import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, ExternalLink, FileCode2, Link2, Plus, RotateCcw, Unlink, X } from 'lucide-react';
import { errorMessage, jsonEqual, type Json } from '@gs/shared';
import { findDocNode, nodeTypes, type NodeDoc, type PropDef, type ScriptInfo, type SceneDoc } from '@gs/core';
import { scriptTemplate } from '@gs/scripting';
import { useEditor, activeScenePath } from '@editor/store/editor';
import { toast } from '@editor/store/toasts';
import { describeScripts } from '@editor/play/player-host';
import { Button, EmptyState, IconButton, SectionHeader, Select, TextInput, cx, inputCls } from '../ui/primitives';
import { NodeIcon } from '../ui/NodeIcon';
import { PropField, Row, prettyName } from './fields';

export function Inspector() {
  const scenePath = useEditor(activeScenePath);
  const scene = useEditor((s) => (scenePath ? s.project?.scenes[scenePath] : undefined));
  const selection = useEditor((s) => s.selection);
  const hit = scene && selection.length ? findDocNode(scene, selection[selection.length - 1]) : null;
  if (!scenePath || !scene) return <Shell>{<EmptyState title="Nothing to inspect">Open a scene and select a node.</EmptyState>}</Shell>;
  if (!hit) return <Shell>{<EmptyState title="No node selected">Select a node in the scene tree or the viewport to edit it.</EmptyState>}</Shell>;
  return (
    <Shell>
      <NodeInspector key={hit.node.id} scenePath={scenePath} scene={scene} node={hit.node} parentType={hit.parent?.type ?? null} count={selection.length} />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col" data-testid="inspector">
      <SectionHeader>Inspector</SectionHeader>
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </div>
  );
}

function useDispatch(scenePath: string, nodeId: string) {
  return (commands: Parameters<ReturnType<typeof useEditor.getState>['dispatch']>[0], label: string, mergeKey?: string) => {
    try {
      useEditor.getState().dispatch(commands, { label, mergeKey });
    } catch (e) {
      toast('error', errorMessage(e));
    }
    void scenePath;
    void nodeId;
  };
}

function NodeInspector({ scenePath, scene, node, parentType, count }: { scenePath: string; scene: SceneDoc; node: NodeDoc; parentType: string | null; count: number }) {
  const dispatch = useDispatch(scenePath, node.id);
  const project = useEditor((s) => s.project!);
  const info = nodeTypes.get(node.type);
  const defs = nodeTypes.properties(node.type);
  const instanceRoot = node.instance ? project.scenes[node.instance]?.root : undefined;
  const effective: Record<string, Json> = { ...(instanceRoot?.props ?? {}), ...(node.props ?? {}) };
  const warnings = useMemo(() => nodeTypes.warnings({ node, parentType, childTypes: (node.children ?? []).map((c) => c.type) }), [node, parentType]);
  const groups = useMemo(() => {
    const out: { name: string; defs: PropDef[] }[] = [];
    for (const typeName of nodeTypes.chain(node.type).reverse()) {
      for (const d of nodeTypes.get(typeName)!.properties) {
        const g = d.group ?? typeName;
        let entry = out.find((x) => x.name === g);
        if (!entry) out.push((entry = { name: g, defs: [] }));
        entry.defs.push(d);
      }
    }
    return out;
  }, [node.type]);
  void defs;
  const setProp = (name: string, value: Json, final?: boolean) => dispatch([{ op: 'set_props', scene: scenePath, node: node.id, props: { [name]: value } }], `Change ${name}`, final ? undefined : `prop:${node.id}:${name}`);

  return (
    <div className="pb-6">
      <div className="flex items-center gap-2 border-b border-border px-2.5 py-2">
        <NodeIcon type={node.type} size={18} />
        <div className="min-w-0 flex-1">
          <NameInput value={node.name} onCommit={(name) => dispatch([{ op: 'rename_node', scene: scenePath, node: node.id, name }], `Rename to ${name}`)} />
          <div className="truncate text-[11px] text-muted" title={info?.description}>
            {node.type}
            {count > 1 && ` · ${count} selected (editing the last one)`}
          </div>
        </div>
      </div>
      {node.instance && (
        <div className="flex items-center gap-2 border-b border-border px-2.5 py-1.5 text-[12px]">
          <Link2 size={13} className="text-accent" />
          <span className="min-w-0 flex-1 truncate">Instance of {node.instance}</span>
          <Button variant="ghost" onClick={() => useEditor.getState().openDoc({ kind: 'scene', path: node.instance! })}>
            <ExternalLink size={12} /> Open
          </Button>
        </div>
      )}
      {warnings.length > 0 && (
        <div className="space-y-1 border-b border-border bg-warn/5 px-2.5 py-1.5 text-[11px] text-warn" data-testid="node-warnings">
          {warnings.map((w) => (
            <div key={w}>⚠ {w}</div>
          ))}
        </div>
      )}
      <ScriptSection scenePath={scenePath} node={node} />
      {groups.map((g) => (
        <Section key={g.name} title={g.name}>
          {g.defs.map((d) => {
            const value = d.name in effective ? effective[d.name] : d.default;
            const changed = node.props && d.name in node.props && !jsonEqual(node.props[d.name], d.default);
            return (
              <Row key={d.name} label={prettyName(d.name)} hint={d.hint}>
                <div className="flex items-center gap-1">
                  <div className="min-w-0 flex-1">
                    <PropField def={d} value={value} onChange={(v, final) => setProp(d.name, v, final)} />
                  </div>
                  {changed && (
                    <IconButton label={`Reset ${d.name}`} className="h-6 min-w-6" onClick={() => dispatch([{ op: 'reset_props', scene: scenePath, node: node.id, props: [d.name] }], `Reset ${d.name}`)}>
                      <RotateCcw size={11} />
                    </IconButton>
                  )}
                </div>
              </Row>
            );
          })}
        </Section>
      ))}
      <GroupsSection scenePath={scenePath} node={node} />
      <SignalsSection scenePath={scenePath} scene={scene} node={node} />
    </div>
  );
}

function NameInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return <input className={cx(inputCls, 'h-7 border-transparent bg-transparent px-1 text-[13px] font-semibold hover:border-border')} value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v.trim() && v !== value && onCommit(v.trim())} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} aria-label="Node name" data-testid="inspector-name" />;
}

function Section({ title, children, defaultOpen = true }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-b border-border">
      <button className="flex w-full items-center gap-1 px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted hover:text-text" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} {title}
      </button>
      {open && <div className="px-2.5 pb-2">{children}</div>}
    </section>
  );
}

function ScriptSection({ scenePath, node }: { scenePath: string; node: NodeDoc }) {
  const scripts = useEditor((s) => s.project!.scripts);
  const dispatch = useDispatch(scenePath, node.id);
  const [info, setInfo] = useState<Record<string, ScriptInfo> | null>(null);
  const path = node.script ?? null;
  useEffect(() => {
    if (!path) return;
    let live = true;
    void describeScripts(scripts).then((r) => live && setInfo(r));
    return () => {
      live = false;
    };
  }, [scripts, path]);
  const attachNew = () => {
    const base = node.name.replace(/[^A-Za-z0-9]/g, '') || 'Script';
    const className = /^[A-Za-z]/.test(base) ? base : `S${base}`;
    let p = `scripts/${className.charAt(0).toLowerCase()}${className.slice(1)}.ts`;
    for (let i = 2; scripts[p] !== undefined; i++) p = `scripts/${className.charAt(0).toLowerCase()}${className.slice(1)}${i}.ts`;
    dispatch(
      [
        { op: 'write_script', path: p, source: scriptTemplate(node.type, className) },
        { op: 'attach_script', scene: scenePath, node: node.id, script: p },
      ],
      'New script',
    );
    useEditor.getState().openDoc({ kind: 'script', path: p });
  };
  const described = path ? info?.[path] : undefined;
  return (
    <Section title="Script">
      {path ? (
        <>
          <div className="flex items-center gap-1.5 py-1">
            <FileCode2 size={14} className="shrink-0 text-node-audio" />
            <button className="min-w-0 flex-1 truncate text-left text-[12px] text-accent hover:underline" onClick={() => useEditor.getState().openDoc({ kind: 'script', path })} data-testid="open-script">
              {path}
            </button>
            <IconButton label="Detach script" className="h-6 min-w-6" onClick={() => dispatch([{ op: 'attach_script', scene: scenePath, node: node.id, script: null }], 'Detach script')}>
              <Unlink size={12} />
            </IconButton>
          </div>
          {scripts[path] === undefined && <div className="text-[11px] text-err">This script no longer exists.</div>}
          {described?.error && <div className="text-[11px] text-warn">{described.error}</div>}
          {described?.exports.map((d) => {
            const value = node.scriptProps?.[d.name] ?? d.default;
            return (
              <Row key={d.name} label={prettyName(d.name)} hint={d.hint}>
                <PropField def={d} value={value} onChange={(v, final) => dispatch([{ op: 'set_script_props', scene: scenePath, node: node.id, values: { [d.name]: v } }], `Change ${d.name}`, final ? undefined : `sprop:${node.id}:${d.name}`)} />
              </Row>
            );
          })}
          {path && !described && info === null && <div className="text-[11px] text-faint">Reading exported properties…</div>}
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5 py-1">
          <Button onClick={attachNew} data-testid="new-script">
            <Plus size={13} /> New script
          </Button>
          {Object.keys(scripts).length > 0 && (
            <Select value="" onChange={(e) => e.target.value && dispatch([{ op: 'attach_script', scene: scenePath, node: node.id, script: e.target.value }], 'Attach script')} className="w-auto flex-1" aria-label="Attach existing script">
              <option value="">Attach existing…</option>
              {Object.keys(scripts).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          )}
        </div>
      )}
    </Section>
  );
}

function GroupsSection({ scenePath, node }: { scenePath: string; node: NodeDoc }) {
  const dispatch = useDispatch(scenePath, node.id);
  const [text, setText] = useState('');
  const groups = node.groups ?? [];
  return (
    <Section title="Groups" defaultOpen={groups.length > 0}>
      <div className="flex flex-wrap gap-1 pb-1">
        {groups.map((g) => (
          <span key={g} className="flex items-center gap-1 rounded bg-panel-3 px-1.5 py-0.5 text-[11px]">
            {g}
            <button aria-label={`Remove ${g}`} onClick={() => dispatch([{ op: 'set_groups', scene: scenePath, node: node.id, groups: groups.filter((x) => x !== g) }], 'Change groups')}>
              <X size={10} />
            </button>
          </span>
        ))}
      </div>
      <form
        className="flex gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim()) return;
          dispatch([{ op: 'set_groups', scene: scenePath, node: node.id, groups: [...groups, text.trim()] }], 'Change groups');
          setText('');
        }}
      >
        <TextInput placeholder="Add to group…" value={text} onChange={(e) => setText(e.target.value)} />
      </form>
    </Section>
  );
}

function SignalsSection({ scenePath, scene, node }: { scenePath: string; scene: SceneDoc; node: NodeDoc }) {
  const dispatch = useDispatch(scenePath, node.id);
  const conns = (scene.connections ?? []).filter((c) => c.from === node.id);
  const signals = useMemo(() => {
    const info = nodeTypes.get(node.type);
    if (!info || info.abstract) return [];
    const probe = new info.ctor() as unknown as Record<string, { connect?: unknown }>;
    return Object.keys(probe).filter((k) => typeof probe[k]?.connect === 'function' && k !== 'ready' && !k.startsWith('tree') && !k.startsWith('child') && k !== 'renamed');
  }, [node.type]);
  const [form, setForm] = useState<{ signal: string; to: string; method: string } | null>(null);
  const all: NodeDoc[] = [];
  const walk = (n: NodeDoc) => {
    all.push(n);
    for (const c of n.children ?? []) walk(c);
  };
  walk(scene.root);
  const nameOf = (id: string) => all.find((n) => n.id === id)?.name ?? '?';
  if (!signals.length && !conns.length) return null;
  return (
    <Section title="Signals" defaultOpen={conns.length > 0}>
      {conns.map((c, i) => (
        <div key={i} className="flex items-center gap-1 py-0.5 text-[12px]">
          <span className="min-w-0 flex-1 truncate">
            <b>{c.signal}</b> → {nameOf(c.to)}.<span className="font-mono">{c.method}()</span>
          </span>
          <IconButton label="Disconnect" className="h-6 min-w-6" onClick={() => dispatch([{ op: 'disconnect_signal', scene: scenePath, ...c }], 'Disconnect signal')}>
            <X size={11} />
          </IconButton>
        </div>
      ))}
      {form ? (
        <div className="mt-1 space-y-1">
          <Select value={form.signal} onChange={(e) => setForm({ ...form, signal: e.target.value })} aria-label="Signal">
            {signals.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </Select>
          <Select value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} aria-label="Target node">
            {all.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name} ({n.type})
              </option>
            ))}
          </Select>
          <TextInput placeholder="Method name, e.g. onTimeout" value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })} />
          <div className="flex gap-1">
            <Button
              variant="primary"
              disabled={!form.method.trim()}
              onClick={() => {
                dispatch([{ op: 'connect_signal', scene: scenePath, from: node.id, signal: form.signal, to: form.to, method: form.method.trim() }], 'Connect signal');
                setForm(null);
              }}
            >
              Connect
            </Button>
            <Button onClick={() => setForm(null)}>Cancel</Button>
          </div>
          <div className="text-[11px] text-faint">The target needs a script with that method.</div>
        </div>
      ) : (
        signals.length > 0 && (
          <button className="mt-1 flex items-center gap-1 text-[12px] text-accent hover:underline" onClick={() => setForm({ signal: signals[0], to: scene.root.id, method: '' })}>
            <Plus size={12} /> Connect a signal
          </button>
        )
      )}
    </Section>
  );
}
