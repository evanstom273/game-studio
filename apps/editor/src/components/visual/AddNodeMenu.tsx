/**
 * The add-node menu (ported from Coding Studio's AddNodeMenu). Search ranks every node and preset;
 * without a search it browses by category, starting with the common nodes, the script's own
 * variables/functions/signals and the nodes of the class the script extends. Dragging a wire onto
 * empty canvas opens it filtered to nodes that can connect to that pin. On phones it is a bottom
 * sheet and a tap adds the node.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, ClipboardPaste, Search, X } from 'lucide-react';
import type { FunctionDecl, JsonValue, ScriptDoc } from '@cs/graph-core';
import { checkConnection, makeNodeContext, nodeInfo, scopeChain, type Toolchain } from '@cs/compiler-core';
import { defaultProps, matchesQuery, type NodeDefinition, type PortSpec } from '@cs/node-registry';
import type { ParamInput } from '@cs/project-format';
import { EVENTS, engineApi, gameStudioToolchain, type EditOp } from '@gs/visual';
import { nodeTypes } from '@gs/core';
import { toast } from '@editor/store/toasts';
import { cx } from '../ui/primitives';
import { categoryColor } from './model';
import { editVisualScript, openFunction, revealNode, selectInGraph, uniqueMemberName } from './store';
import { clipboardSize, paste } from './commands';

export interface PendingConnection {
  nodeId: string;
  portId: string;
  /** 'source' = dragged from an output, 'target' = dragged from an input */
  handleType: 'source' | 'target';
}

/** Where a node added with nothing dragged goes next: after the selected node's free exec pin. */
export interface ChainTarget {
  nodeId: string;
  portId: string;
  title: string;
  at: { x: number; y: number };
}

export interface MenuEntry {
  key: string;
  title: string;
  category: string;
  description: string;
  type: string;
  props?: Record<string, JsonValue>;
  def?: NodeDefinition;
  keywords?: string[];
  /** Creating the node also creates a new inline function owned by the current one. */
  newClosure?: boolean;
  /** Adds this event to the script (and opens its graph) instead of adding a node. */
  event?: string;
  /** Connect Signal presets: also create the function that handles the signal. */
  handler?: { signal: string; params: ParamInput[] };
}

/** Edit operations that add a palette entry's node (with `ref: 'n'`) at a position. */
export function opsForEntry(e: MenuEntry, fn: FunctionDecl, script: ScriptDoc, position: { x: number; y: number }): EditOp[] {
  const at = { x: Math.round(position.x), y: Math.round(position.y) };
  if (e.newClosure) {
    const name = uniqueMemberName(script, 'callback');
    return [
      { op: 'add_function', ref: 'lam', kind: 'lambda', owner: fn.id, name },
      { op: 'add_node', ref: 'n', graph: fn.id, type: e.type, position: at, props: { function: '$lam' } },
    ];
  }
  if (e.handler) {
    const name = uniqueMemberName(script, `on${e.handler.signal.charAt(0).toUpperCase()}${e.handler.signal.slice(1)}`);
    return [
      { op: 'add_function', ref: 'h', name, params: e.handler.params, description: `Runs when ${e.handler.signal} fires.` },
      { op: 'add_node', ref: 'n', graph: fn.id, type: e.type, position: at, props: { ...e.props, method: '$h' } },
    ];
  }
  return [{ op: 'add_node', ref: 'n', graph: fn.id, type: e.type, position: at, ...(e.props ? { props: e.props } : {}) }];
}

/** Parameters of an engine signal's handler (body: Node…). */
function signalParams(signal: string, cls: string | undefined): ParamInput[] {
  const sigs = engineApi().filter((a) => a.kind === 'signal' && a.name === signal);
  const m = sigs.find((a) => a.cls === cls) ?? sigs[0];
  return (m?.params ?? []).map(([name, type]) => ({ name, type: type || 'any' }));
}

/** Palette entries for a graph: every node type and preset, plus the script's own members and missing events. */
export function paletteEntries(tc: Toolchain, script: ScriptDoc, fn: FunctionDecl): MenuEntry[] {
  const out: MenuEntry[] = [];
  const reg = tc.registry;
  const def = (t: string) => reg.get(t);
  const [own, ...outer] = scopeChain(script, fn);
  const vars = [
    ...own.params.map((p) => ({ ...p, scope: 'parameter', constant: false })),
    ...own.locals.map((v) => ({ ...v, scope: v.constant ? 'constant' : 'local' })),
    // Inline functions see the parameters and locals of the functions around them.
    ...outer.flatMap((o) => [...o.params.map((p) => ({ ...p, scope: `${o.name} parameter`, constant: false })), ...o.locals.map((v) => ({ ...v, scope: v.constant ? 'constant' : `${o.name} local` }))]),
    ...script.variables.map((v) => ({ ...v, scope: v.constant ? 'constant' : 'variable' })),
  ];
  for (const v of vars) {
    out.push({ key: `get:${v.id}`, title: `Get ${v.name}`, category: 'Variables', description: `Read the ${v.scope} ${v.name} (${v.type}).`, type: 'core.get_var', props: { variable: v.id }, def: def('core.get_var') });
    if (v.scope !== 'constant') out.push({ key: `set:${v.id}`, title: `Set ${v.name}`, category: 'Variables', description: `Change the ${v.scope} ${v.name} (${v.type}).`, type: 'core.set_var', props: { variable: v.id }, def: def('core.set_var') });
  }
  for (const f of script.functions) {
    if (f.kind === 'event' || f.kind === 'lambda') continue;
    out.push({ key: `call:${f.id}`, title: `Call ${f.name}`, category: 'Functions', description: f.description || `Run this script's function ${f.name}(${f.params.map((p) => p.name).join(', ')}).`, type: 'core.call_function', props: { function: f.id }, def: def('core.call_function') });
  }
  if (def('gs.emit_signal')) for (const s of script.signals) out.push({ key: `emit:${s.id}`, title: `Emit ${s.name}`, category: 'Signals', description: `Emit this script's signal ${s.name}: everything connected to it runs.`, type: 'gs.emit_signal', props: { signal: s.id }, def: def('gs.emit_signal') });
  for (const e of script.enums) for (const m of e.members) out.push({ key: `enum:${e.id}:${m.name}`, title: `${e.name}.${m.name}`, category: 'Variables', description: 'Enum value', type: 'core.enum_value', props: { enum: e.id, member: m.name }, def: def('core.enum_value') });
  for (const ev of EVENTS) {
    if (script.functions.some((f) => f.kind === 'event' && f.event === ev.id)) continue;
    out.push({ key: `event:${ev.id}`, title: `${ev.title} event`, category: 'Events', description: ev.description, type: '', event: ev.id, keywords: [ev.name, 'event', 'on', 'when'] });
  }
  for (const d of reg.available(tc.adapter.id, tc.adapter.capabilities)) {
    out.push({ key: d.type, title: d.title, category: d.category, description: d.description, type: d.type, def: d, keywords: d.keywords });
    d.presets?.forEach((p, i) => {
      const entry: MenuEntry = { key: `${d.type}#${i}`, title: p.title, category: p.category ?? d.category, description: p.description ?? d.description, type: d.type, props: p.props, def: d, keywords: [...(p.keywords ?? []), ...(d.keywords ?? [])] };
      if (d.type === 'gs.connect_signal' && typeof p.props.signal === 'string') entry.handler = { signal: p.props.signal, params: signalParams(p.props.signal, p.keywords?.[0]) };
      out.push(entry);
    });
  }
  const closure = reg.get('ts.closure');
  if (closure && tc.adapter.capabilities.closures) {
    out.push({ key: 'closure#new', title: 'New Inline Function', category: 'Functions', description: closure.description, type: 'ts.closure', newClosure: true, def: closure });
    for (const l of script.functions) if (l.kind === 'lambda' && l.owner === fn.id) out.push({ key: `closure#${l.id}`, title: `${l.name} (inline function)`, category: 'Functions', description: l.description ?? closure.description, type: 'ts.closure', props: { function: l.id }, def: closure });
  }
  return out;
}

function score(e: MenuEntry, q: string): number {
  if (!q) return 1;
  const hay = `${e.title} ${e.category} ${e.type} ${(e.keywords ?? []).join(' ')}`.toLowerCase();
  const ql = q.toLowerCase().trim();
  if (!matchesQuery(hay, ql)) {
    // Fall back to the description, ranked below every title/keyword match.
    return matchesQuery(e.description.toLowerCase(), ql) ? 0.5 : 0;
  }
  const t = e.title.toLowerCase();
  return 1 + (t === ql ? 100 : 0) + (t.startsWith(ql) ? 40 : 0) + (t.includes(ql) ? 15 : 0) + (e.key.includes(':') ? 5 : 0) + (e.def && !e.props ? 2 : 0);
}

/** Which port of a would-be node accepts the pending connection, if any. */
export function compatiblePort(tc: Toolchain, script: ScriptDoc, fn: FunctionDecl, e: MenuEntry, pending: PendingConnection): PortSpec | undefined {
  if (!e.def || e.event) return undefined;
  const ctx = makeNodeContext(tc, script, fn);
  const src = fn.graph.nodes.find((n) => n.id === pending.nodeId);
  if (!src) return undefined;
  const srcPort = nodeInfo(tc, ctx, src).ports.find((p) => p.id === pending.portId && p.direction === (pending.handleType === 'source' ? 'out' : 'in'));
  if (!srcPort) return undefined;
  const fake = { id: '__new', type: e.type, position: { x: 0, y: 0 }, props: { ...defaultProps(e.def), ...e.props }, inputs: {} };
  const ports = nodeInfo(tc, ctx, fake).ports;
  return ports.find((p) => {
    if (pending.handleType === 'source') return p.direction === 'in' && checkConnection(tc, srcPort, p).severity !== 'error';
    return p.direction === 'out' && checkConnection(tc, p, srcPort).severity !== 'error';
  });
}

// ---------------------------------------------------------------------------
// Category browser
// ---------------------------------------------------------------------------

interface Group {
  id: string;
  title: string;
  color?: string;
  entries: MenuEntry[];
  subs: Group[];
}

/** Hand-picked nodes people reach for first. */
const COMMON = ['core.print', 'core.branch', 'core.sequence', 'gs.wait', 'gs.get_node', 'gs.input.is_action_pressed', 'gs.input.is_action_just_pressed', 'gs.input.get_vector', 'gs.input.get_axis', 'core.for_range', 'gs.spawn', 'gs.make_vector2', 'core.random_float', 'core.add', 'core.multiply', 'core.greater'];

const TOP_ORDER = ['Flow', 'Input', 'Signals', 'Scene', 'Time', 'Math', 'Comparison', 'Logic', 'Variables', 'Literals', 'Strings', 'Conversions', 'Arrays', 'Dictionaries', 'Functions', 'Objects', 'Tween', 'Resources', 'Async', 'Errors', 'Classes', 'Debug', 'Utility'];

function buildGroups(entries: MenuEntry[], extendsCls: string | undefined): Group[] {
  const chain = extendsCls && nodeTypes.has(extendsCls) ? nodeTypes.chain(extendsCls) : [];
  const common: Group = { id: 'common', title: 'Common', entries: [], subs: [] };
  const events: Group = { id: 'events', title: 'Events', entries: [], subs: [] };
  const mine: Group = { id: 'mine', title: 'This script', entries: [], subs: [] };
  const self: Group = { id: 'self', title: extendsCls ? `${extendsCls} (this node)` : 'This node', entries: [], subs: chain.map((c) => ({ id: `self/${c}`, title: c, color: categoryColor(`Nodes/${c}`), entries: [], subs: [] })) };
  const other: Group = { id: 'other', title: 'Other node types', entries: [], subs: [] };
  const tops = new Map<string, Group>();
  const sub = (g: Group, name: string, idPrefix: string) => {
    let s = g.subs.find((x) => x.title === name);
    if (!s) g.subs.push((s = { id: `${idPrefix}/${name}`, title: name, color: categoryColor(idPrefix === 'other' ? `Nodes/${name}` : `${g.title}/${name}`), entries: [], subs: [] }));
    return s;
  };
  for (const e of entries) {
    if (e.event) {
      events.entries.push(e);
      continue;
    }
    if (/^(get|set|call|emit|enum):|^closure#/.test(e.key)) mine.entries.push(e);
    if (!e.props && COMMON.includes(e.type)) common.entries.push(e);
    if (/^(get|set|call|emit|enum):/.test(e.key)) continue;
    const m = /^Nodes\/(\w+)$/.exec(e.category);
    if (m) {
      const inChain = self.subs.find((s) => s.title === m[1]);
      (inChain ?? sub(other, m[1], 'other')).entries.push(e);
      continue;
    }
    const [top, rest] = e.category.split('/', 2);
    let g = tops.get(top);
    if (!g) tops.set(top, (g = { id: `cat/${top}`, title: top, color: categoryColor(top), entries: [], subs: [] }));
    if (rest) sub(g, rest, g.id).entries.push(e);
    else g.entries.push(e);
  }
  common.entries.sort((a, b) => COMMON.indexOf(a.type) - COMMON.indexOf(b.type));
  const byTitle = (a: MenuEntry, b: MenuEntry) => a.title.localeCompare(b.title);
  const sortGroup = (g: Group) => {
    g.entries.sort(byTitle);
    g.subs.forEach(sortGroup);
  };
  const rest = [...tops.values()].sort((a, b) => (TOP_ORDER.indexOf(a.title) + 1 || 99) - (TOP_ORDER.indexOf(b.title) + 1 || 99) || a.title.localeCompare(b.title));
  [events, mine, ...rest].forEach(sortGroup);
  self.subs.forEach(sortGroup);
  other.subs.sort((a, b) => a.title.localeCompare(b.title)).forEach(sortGroup);
  self.subs = self.subs.filter((s) => s.entries.length);
  const count = (g: Group): number => g.entries.length + g.subs.reduce((n, s) => n + count(s), 0);
  return [common, events, mine, self, ...rest, other].filter((g) => count(g) > 0);
}

const groupCount = (g: Group): number => g.entries.length + g.subs.reduce((n, s) => n + groupCount(s), 0);

// ---------------------------------------------------------------------------

export interface AddNodeMenuProps {
  path: string;
  script: ScriptDoc;
  fn: FunctionDecl;
  /** Screen position for the popover (ignored in sheet mode). */
  screen: { x: number; y: number };
  /** Where the node goes (flow coordinates). */
  flow: { x: number; y: number };
  pending?: PendingConnection;
  chain?: ChainTarget;
  sheet?: boolean;
  onClose: () => void;
}

export function AddNodeMenu({ path, script, fn, screen, flow, pending, chain, sheet, onClose }: AddNodeMenuProps) {
  const tc = gameStudioToolchain();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const extendsCls = typeof script.settings.extends === 'string' ? script.settings.extends : undefined;
  const [open, setOpen] = useState<Set<string>>(() => new Set(['common', 'mine', extendsCls ? `self/${extendsCls}` : 'self', 'self']));
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Phones: don't pop the keyboard up over the list; tap the search box to search.
    if (!sheet) inputRef.current?.focus();
  }, [sheet]);

  const all = useMemo(() => paletteEntries(tc, script, fn), [tc, script, fn]);
  const contextual = useMemo(() => (pending ? all.filter((e) => compatiblePort(tc, script, fn, e, pending)) : all), [all, pending, tc, script, fn]);
  const chainOk = useMemo(() => {
    if (!chain || pending) return null;
    return (e: MenuEntry) => !!compatiblePort(tc, script, fn, e, { nodeId: chain.nodeId, portId: chain.portId, handleType: 'source' });
  }, [chain, pending, tc, script, fn]);
  const query = q.trim();
  const results = useMemo(
    () =>
      query
        ? contextual
            .map((e) => ({ e, s: score(e, query) }))
            .filter((x) => x.s > 0)
            .sort((a, b) => b.s - a.s || a.e.category.localeCompare(b.e.category) || a.e.title.localeCompare(b.e.title))
            .slice(0, 120)
            .map((x) => x.e)
        : contextual,
    [contextual, query],
  );
  // Browsing: categories (a short compatible list is shown flat, grouped by category).
  const browse = !query && (!pending || contextual.length > 40);
  const groups = useMemo(() => (browse ? buildGroups(results, extendsCls) : []), [browse, results, extendsCls]);
  const visible = useMemo(() => {
    if (!browse) return [...results].sort((a, b) => (query ? 0 : a.category.localeCompare(b.category) || a.title.localeCompare(b.title)));
    const list: MenuEntry[] = [];
    const walk = (g: Group) => {
      if (!open.has(g.id)) return;
      list.push(...g.entries);
      g.subs.forEach(walk);
    };
    groups.forEach(walk);
    return list;
  }, [browse, results, query, groups, open]);
  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (e: MenuEntry) => {
    onClose();
    if (e.event) {
      const r = editVisualScript(path, [{ op: 'add_function', ref: 'f', kind: 'event', event: e.event }], `Add ${e.title}`, { functionId: fn.id });
      if (r) openFunction(path, r.created.f);
      return;
    }
    let at = flow;
    let link: EditOp | undefined;
    if (pending) {
      const port = compatiblePort(tc, script, fn, e, pending);
      if (port) link = pending.handleType === 'source' ? { op: 'connect', from: { node: pending.nodeId, port: pending.portId }, to: { node: '$n', port: port.id } } : { op: 'connect', from: { node: '$n', port: port.id }, to: { node: pending.nodeId, port: pending.portId } };
    } else if (chain) {
      const port = compatiblePort(tc, script, fn, e, { nodeId: chain.nodeId, portId: chain.portId, handleType: 'source' });
      if (port) {
        at = chain.at;
        link = { op: 'connect', from: { node: chain.nodeId, port: chain.portId }, to: { node: '$n', port: port.id } };
      }
    }
    const ops = opsForEntry(e, fn, script, at);
    if (link) ops.push(link);
    const r = editVisualScript(path, ops, `Add ${e.title}`, { functionId: fn.id });
    if (!r) return;
    selectInGraph(path, fn.id, [r.created.n]);
    revealNode(path, fn.id, r.created.n, link ? (pending?.nodeId ?? chain?.nodeId) : undefined);
    if (e.handler && r.created.h) {
      const hid = r.created.h;
      const name = r.doc.functions.find((f) => f.id === hid)?.name ?? 'the handler';
      toast('success', `Made the function ${name}: it runs every time ${e.handler.signal} fires. Add what should happen there.`, { label: 'Open it', run: () => openFunction(path, hid) });
    }
  };

  const pasteCount = !pending ? clipboardSize() : 0;
  const width = sheet ? undefined : Math.min(340, window.innerWidth - 16);
  const left = sheet ? 0 : Math.max(8, Math.min(screen.x, window.innerWidth - (width ?? 0) - 8));
  const top = sheet ? 0 : Math.max(8, Math.min(screen.y, window.innerHeight - 460));
  const color = (e: MenuEntry) => categoryColor(e.category, e.def?.flavor);
  let idx = -1;
  const item = (e: MenuEntry, showCat: boolean, depth = 0) => {
    idx++;
    const i = idx;
    const joins = chainOk?.(e);
    return (
      <button
        key={e.key}
        data-idx={i}
        role="option"
        aria-selected={i === active}
        data-testid="add-node-item"
        data-entry={e.key}
        onMouseEnter={() => !sheet && setActive(i)}
        onClick={() => choose(e)}
        className={cx('flex w-full items-center gap-2 py-1 pr-3 text-left text-[12px]', sheet && 'min-h-[44px] py-1.5 text-[13px]', i === active && !sheet ? 'bg-accent/20' : 'active:bg-accent/20')}
        style={{ paddingLeft: 12 + depth * 14 }}
        title={e.description}
      >
        <span className={cx('shrink-0 rounded-sm', e.event ? 'h-2.5 w-2.5 rotate-45' : 'h-2.5 w-2.5')} style={{ background: e.event ? '#9b2c2c' : color(e) }} />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{e.title}</span>
          {sheet && <span className="block truncate text-[11px] text-faint">{e.description}</span>}
        </span>
        {joins && <span className="shrink-0 text-[10px] text-ok" title={`Connects after ${chain?.title}`}>↳</span>}
        {showCat && <span className="ml-auto shrink-0 text-[10px] text-muted">{e.category}</span>}
      </button>
    );
  };
  const renderGroup = (g: Group, depth: number): React.ReactNode => {
    const isOpen = open.has(g.id);
    return (
      <div key={g.id}>
        <button
          className={cx('flex w-full items-center gap-1.5 pr-3 text-left', depth === 0 ? 'pt-2 pb-1 text-[10.5px] font-semibold uppercase tracking-wide text-muted' : 'py-1 text-[12px] text-text', sheet && 'min-h-[40px]')}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() =>
            setOpen((s) => {
              const n = new Set(s);
              if (n.has(g.id)) n.delete(g.id);
              else n.add(g.id);
              return n;
            })
          }
          aria-expanded={isOpen}
          data-testid="add-node-group"
          data-group={g.id}
        >
          {isOpen ? <ChevronDown size={12} className="shrink-0" /> : <ChevronRight size={12} className="shrink-0" />}
          {g.color && depth > 0 && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: g.color }} />}
          <span className="truncate">{g.title}</span>
          <span className="ml-auto shrink-0 text-[10px] font-normal text-faint">{groupCount(g)}</span>
        </button>
        {isOpen && (
          <>
            {g.entries.map((e) => item(e, false, depth + 1))}
            {g.subs.map((s) => renderGroup(s, depth + 1))}
          </>
        )}
      </div>
    );
  };
  let lastCat = '';
  const body = (
    <>
      <div className={cx('shrink-0 border-b border-border p-2', sheet && 'px-3')}>
        <div className="relative flex items-center gap-1">
          <Search size={13} className="pointer-events-none absolute left-2 text-faint" />
          <input
            ref={inputRef}
            data-testid="add-node-search"
            className={cx('gs-input w-full rounded border border-border bg-bg py-1.5 pl-7 pr-2 text-[12px] focus:border-accent focus:outline-none', sheet && 'h-10 text-[15px]')}
            placeholder={pending ? 'Search compatible nodes…' : `Search ${all.length} nodes…`}
            value={q}
            enterKeyHint="go"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(visible.length - 1, a + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === 'Enter' && visible[active]) {
                e.preventDefault();
                choose(visible[active]);
              } else if (e.key === 'Escape') onClose();
            }}
          />
          {sheet && (
            <button className="touch-target flex shrink-0 items-center justify-center rounded text-muted" aria-label="Close" onClick={onClose}>
              <X size={18} />
            </button>
          )}
        </div>
        {pending && <div className="mt-1 text-[10.5px] text-muted">Showing nodes that can connect to the dragged pin ({contextual.length})</div>}
        {!pending && chain && <div className="mt-1 text-[10.5px] text-muted">Nodes marked ↳ connect after “{chain.title}”.</div>}
      </div>
      <div ref={listRef} className="min-h-0 flex-1 overflow-auto overscroll-contain py-1" role="listbox" data-testid="add-node-list">
        {pasteCount > 0 && !query && (
          <button
            className={cx('flex w-full items-center gap-2 px-3 py-1 text-left text-[12px] text-accent hover:bg-accent/10', sheet && 'min-h-[44px]')}
            onClick={() => {
              onClose();
              paste(flow);
            }}
          >
            <ClipboardPaste size={13} /> Paste {pasteCount} node{pasteCount === 1 ? '' : 's'}
          </button>
        )}
        {visible.length === 0 && !browse && <div className="px-3 py-2 text-muted">No matching nodes</div>}
        {browse
          ? groups.map((g) => renderGroup(g, 0))
          : visible.map((e) => {
              const showCat = !query && e.category !== lastCat;
              lastCat = e.category;
              return (
                <div key={e.key}>
                  {showCat && <div className="px-3 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted">{e.category}</div>}
                  {item(e, !!query)}
                </div>
              );
            })}
      </div>
      {!sheet && visible[active] && <div className="shrink-0 border-t border-border px-3 py-1.5 text-[11px] leading-snug text-muted">{visible[active].description}</div>}
    </>
  );
  return (
    <div className={cx('fixed inset-0 z-40', sheet && 'bg-black/40')} onPointerDown={onClose} onContextMenu={(e) => e.preventDefault()} data-testid="add-node-menu">
      <div
        className={cx('absolute flex flex-col border border-border bg-panel shadow-2xl', sheet ? 'safe-bottom inset-x-0 bottom-0 h-[78dvh] rounded-t-xl' : 'rounded-md')}
        style={sheet ? undefined : { left, top, width, maxHeight: Math.min(460, window.innerHeight - top - 8) }}
        onPointerDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Add node"
      >
        {sheet && (
          <div className="flex h-5 shrink-0 items-center justify-center">
            <div className="h-1 w-10 rounded-full bg-border-strong" />
          </div>
        )}
        {body}
      </div>
    </div>
  );
}
