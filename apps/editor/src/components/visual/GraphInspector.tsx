/**
 * The inspector while a visual script is open (ported from Coding Studio's Inspector): the
 * selected node's settings and input values, or the variable / signal / function / script picked
 * in the script panel. Shown in the editor's Inspector panel (and its sheet on phones).
 */
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CopyPlus, ExternalLink, FoldVertical, Plus, SquareDashed, Trash2, XCircle } from 'lucide-react';
import type { FunctionDecl, JsonValue, ParamDecl, ScriptDoc, VariableDecl } from '@cs/graph-core';
import { makeNodeContext, nodeInfo, resolveType, scopeChain } from '@cs/compiler-core';
import type { PropSchema } from '@cs/node-registry';
import type { ParamInput } from '@cs/project-format';
import { EVENTS, gameStudioToolchain, type EditOp } from '@gs/visual';
import { Button, EmptyState, IconButton, cx, inputCls } from '../ui/primitives';
import { ExtendsPicker } from './MembersPanel';
import { InlineInput, hasInlineEditor } from './InlineInput';
import { deleteSelection, duplicateSelection, frameSelection, toggleCollapse } from './commands';
import { linkedFunctionOf } from './links';
import { editVisualScript, functionTitle, inspect, openFunction, pickFunction, useGraphSelection, useGraphUi, useVisualBuild, useVisualDoc } from './store';

type Dispatch = (ops: EditOp[], label: string, mergeKey?: string) => void;

/** Text input that commits on blur / Enter (for renames and types, which must be valid as a whole). */
function CommitInput({ value, onCommit, placeholder, testId, list, mono, label }: { value: string; onCommit: (v: string) => void; placeholder?: string; testId?: string; list?: string; mono?: boolean; label?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input
      className={cx(inputCls, mono && 'font-mono')}
      value={v}
      list={list}
      placeholder={placeholder}
      aria-label={label}
      data-testid={testId}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== value && onCommit(v)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setV(value);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

/** Text that writes as you type (the edits merge into one undo step). */
function LiveText({ value, onChange, multiline, testId, label }: { value: string; onChange: (v: string) => void; multiline?: boolean; testId?: string; label?: string }) {
  const [v, setV] = useState(value);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setV(value);
  }, [value, focused]);
  const props = {
    value: v,
    'aria-label': label,
    'data-testid': testId,
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
    onChange: (e: { target: { value: string } }) => {
      setV(e.target.value);
      onChange(e.target.value);
    },
  };
  return multiline ? <textarea {...props} className={cx(inputCls, 'h-16 py-1')} /> : <input {...props} className={inputCls} />;
}

function Row({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="mb-2.5">
      <div className="mb-1 text-[11px] font-medium text-muted" title={hint}>
        {label}
      </div>
      {children}
      {hint && <div className="mt-0.5 text-[10.5px] leading-snug text-faint">{hint}</div>}
    </div>
  );
}

function TypeDatalist({ doc }: { doc: ScriptDoc }) {
  const types = gameStudioToolchain().adapter.types.pickerTypes();
  return (
    <datalist id="gs-visual-types">
      {[...types, ...doc.enums.map((e) => e.name)].map((t) => (
        <option key={t} value={t} />
      ))}
    </datalist>
  );
}

function TypeInput({ value, onCommit, testId, label }: { value: string; onCommit: (v: string) => void; testId?: string; label?: string }) {
  return <CommitInput value={value} onCommit={onCommit} list="gs-visual-types" mono testId={testId} label={label} />;
}

function PropEditor({ prop, value, onChange, doc, fn }: { prop: PropSchema; value: JsonValue | undefined; onChange: (v: JsonValue, merge?: boolean) => void; doc: ScriptDoc; fn: FunctionDecl }) {
  const tid = `node-prop-${prop.key}`;
  switch (prop.kind) {
    case 'string':
      return <LiveText value={typeof value === 'string' ? value : ''} onChange={(v) => onChange(v, true)} testId={tid} label={prop.label} />;
    case 'text':
      return <LiveText multiline value={typeof value === 'string' ? value : ''} onChange={(v) => onChange(v, true)} testId={tid} label={prop.label} />;
    case 'int':
    case 'number':
      return <input className={inputCls} type="number" step={prop.kind === 'int' ? 1 : 'any'} min={prop.min} max={prop.max} value={typeof value === 'number' ? value : 0} onChange={(e) => e.target.value !== '' && Number.isFinite(+e.target.value) && onChange(prop.kind === 'int' ? Math.trunc(+e.target.value) : +e.target.value, true)} data-testid={tid} aria-label={prop.label} />;
    case 'boolean':
      return <input type="checkbox" className="h-4 w-4 accent-[var(--color-accent)]" checked={value === true} onChange={(e) => onChange(e.target.checked)} data-testid={tid} aria-label={prop.label} />;
    case 'select':
      return (
        <select className={inputCls} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} data-testid={tid} aria-label={prop.label}>
          {prop.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    case 'type':
      if (prop.typeOptions)
        return (
          <select className={inputCls} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} data-testid={tid} aria-label={prop.label}>
            {prop.default === '' && <option value="">(same as left)</option>}
            {!prop.typeOptions.includes(String(value ?? '')) && value !== '' && <option value={String(value ?? '')}>{String(value ?? '')}</option>}
            {prop.typeOptions.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        );
      return <TypeInput value={String(value ?? '')} onCommit={(v) => onChange(v)} testId={tid} label={prop.label} />;
    case 'variable': {
      const scopes = prop.variableScopes ?? ['member', 'local', 'param'];
      const [own, ...outer] = scopeChain(doc, fn);
      const groups: [string, (VariableDecl | ParamDecl)[]][] = [
        ['Parameters', scopes.includes('param') ? own.params : []],
        ['Local variables', scopes.includes('local') ? own.locals : []],
        // An inline function can use the variables of the functions around it.
        ...outer.map((o): [string, (VariableDecl | ParamDecl)[]] => [`From ${o.name}`, [...(scopes.includes('param') ? o.params : []), ...(scopes.includes('local') ? o.locals : [])]]),
        ['Script variables', scopes.includes('member') ? doc.variables : []],
      ];
      return (
        <select className={inputCls} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} data-testid={tid} aria-label={prop.label}>
          <option value="">— choose —</option>
          {groups.map(([g, list]) =>
            list.length ? (
              <optgroup key={g} label={g}>
                {list.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}: {v.type}
                  </option>
                ))}
              </optgroup>
            ) : null,
          )}
        </select>
      );
    }
    case 'function':
    case 'signal':
    case 'enum': {
      const list = prop.kind === 'function' ? doc.functions.filter((f) => f.kind !== 'event') : prop.kind === 'signal' ? doc.signals : doc.enums;
      return (
        <select className={inputCls} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} data-testid={tid} aria-label={prop.label}>
          <option value="">— choose —</option>
          {list.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
      );
    }
    case 'string_list':
      return <StringList value={Array.isArray(value) ? value.map(String) : []} onCommit={(v) => onChange(v)} />;
    default:
      return null;
  }
}

function StringList({ value, onCommit }: { value: string[]; onCommit: (v: string[]) => void }) {
  const [text, setText] = useState(value.join('\n'));
  useEffect(() => setText(value.join('\n')), [value]);
  return <textarea className={cx(inputCls, 'h-20 py-1 font-mono')} value={text} onChange={(e) => setText(e.target.value)} onBlur={() => onCommit(text.split('\n').map((s) => s.trim()).filter(Boolean))} placeholder="one per line" />;
}

function DiagList({ items }: { items: { severity: string; message: string; suggestion?: string }[] }) {
  return (
    <>
      {items.map((x, i) => (
        <div key={i} className={cx('mb-2 flex gap-1.5 rounded px-2 py-1 text-[11.5px] leading-snug', x.severity === 'error' ? 'bg-red-500/15 text-red-200' : 'bg-amber-400/10 text-amber-200')} data-testid="inspector-diagnostic">
          {x.severity === 'error' ? <XCircle size={13} className="mt-px shrink-0" /> : <AlertTriangle size={13} className="mt-px shrink-0" />}
          <div>
            {x.message}
            {x.suggestion && <div className="mt-0.5 opacity-80">→ {x.suggestion}</div>}
          </div>
        </div>
      ))}
    </>
  );
}

function NodeInspector({ path, nodeId, doc, fn, d }: { path: string; nodeId: string; doc: ScriptDoc; fn: FunctionDecl; d: Dispatch }) {
  const node = fn.graph.nodes.find((n) => n.id === nodeId);
  const build = useVisualBuild(path);
  const tc = gameStudioToolchain();
  const info = useMemo(() => (node ? nodeInfo(tc, makeNodeContext(tc, doc, fn), node) : undefined), [tc, doc, fn, node]);
  if (!node || !info) return null;
  const nodeDiags = build.diagnostics.filter((x) => x.nodeId === nodeId);
  const connected = new Set(fn.graph.edges.filter((e) => e.to.node === nodeId).map((e) => e.to.port));
  const values = info.ports.filter((p) => p.direction === 'in' && hasInlineEditor(p) && !connected.has(p.id));
  const linked = linkedFunctionOf(doc, node);
  return (
    <div data-testid="node-inspector">
      <div className="mb-0.5 text-[14px] font-semibold">{info.title}</div>
      <div className="mb-2 font-mono text-[10.5px] text-faint">{node.type}</div>
      {info.def && <p className="mb-3 text-[12px] leading-snug text-[#c3c9d4]">{info.def.description}</p>}
      <DiagList items={nodeDiags} />
      {linked && (
        <Button className="mb-3" onClick={() => openFunction(path, linked.id)} data-testid="open-linked-function">
          <ExternalLink size={12} /> Open {functionTitle(linked)}
        </Button>
      )}
      {info.def?.props
        .filter((p) => p.kind !== 'json')
        .map((p) => (
          <Row key={p.key} label={p.label} hint={p.description}>
            <PropEditor prop={p} value={node.props[p.key]} doc={doc} fn={fn} onChange={(v, merge) => d([{ op: 'update_node', node: node.id, props: { [p.key]: v } }], `Set ${p.label}`, merge ? `prop:${node.id}:${p.key}` : undefined)} />
          </Row>
        ))}
      {values.length > 0 && (
        <div className="mt-1">
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">Values</div>
          {values.map((p) => (
            <Row key={p.id} label={p.name || p.id} hint={p.description}>
              <InlineInput path={path} fnId={fn.id} nodeId={node.id} port={p} value={node.inputs[p.id]} wide />
            </Row>
          ))}
        </div>
      )}
      {info.ports.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wide text-muted">Pins ({info.ports.length})</summary>
          <table className="mt-1 w-full text-[11.5px]">
            <tbody>
              {info.ports.map((p) => (
                <tr key={`${p.direction}${p.id}`} className="border-t border-border/50">
                  <td className="py-0.5 pr-2 text-muted">{p.direction === 'in' ? '→' : '←'}</td>
                  <td className="py-0.5 pr-2">{p.name || p.id}</td>
                  <td className="py-0.5 font-mono text-[10.5px] text-muted">{p.kind === 'exec' ? 'exec' : p.type ? tc.adapter.types.format(p.type) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}

function ParamsEditor({ params, onCommit, label }: { params: ParamDecl[]; onCommit: (p: ParamInput[]) => void; label: string }) {
  const list: ParamInput[] = params.map((p) => ({ id: p.id, name: p.name, type: p.type, ...(p.default !== undefined ? { default: p.default } : {}) }));
  return (
    <Row label={label}>
      {params.map((p, i) => (
        <div key={p.id} className="mb-1 flex gap-1">
          <CommitInput value={p.name} label="Parameter name" onCommit={(v) => onCommit(list.map((x, j) => (j === i ? { ...x, name: v } : x)))} />
          <TypeInput value={p.type} label="Parameter type" onCommit={(v) => onCommit(list.map((x, j) => (j === i ? { ...x, type: v } : x)))} />
          <IconButton label={`Remove ${p.name}`} onClick={() => onCommit(list.filter((_, j) => j !== i))}>
            <Trash2 size={12} />
          </IconButton>
        </div>
      ))}
      <button
        className="touch-target flex items-center gap-1 text-[11.5px] text-accent hover:underline"
        onClick={() => {
          let n = 'value';
          for (let i = 2; params.some((p) => p.name === n); i++) n = `value${i}`;
          onCommit([...list, { name: n, type: 'float' }]);
        }}
      >
        <Plus size={12} /> Add parameter
      </button>
    </Row>
  );
}

function VariableEditor({ v, fn, d }: { v: VariableDecl; fn?: FunctionDecl; d: Dispatch }) {
  const tc = gameStudioToolchain();
  const t = resolveType(tc.adapter, v.type).type;
  const base = { variable: v.id, ...(fn ? { function: fn.id } : {}) };
  const upd = (patch: Record<string, unknown>, label: string, merge?: string) => d([{ op: 'update_variable', ...base, ...patch } as EditOp], label, merge);
  const fields = t?.kind === 'named' ? tc.adapter.types.structFields(t.name) : undefined;
  const o = (v.default && typeof v.default === 'object' && !Array.isArray(v.default) ? v.default : {}) as Record<string, JsonValue>;
  return (
    <div data-testid="variable-inspector">
      {!fn && <div className="mb-3 text-[14px] font-semibold">Variable {v.name}</div>}
      <Row label="Name">
        <CommitInput value={v.name} onCommit={(name) => upd({ name }, 'Rename variable')} testId="var-name" label="Variable name" />
      </Row>
      <Row label="Type" hint="float = a number, int = a whole number, bool = yes/no, string = text; or a node type like Sprite2D.">
        <TypeInput value={v.type} onCommit={(type) => upd({ type, default: null }, 'Change type')} testId="var-type" label="Variable type" />
      </Row>
      <Row label="Starting value">
        {t?.kind === 'bool' ? (
          <input type="checkbox" className="h-4 w-4 accent-[var(--color-accent)]" checked={v.default === true} onChange={(e) => upd({ default: e.target.checked }, 'Set default')} aria-label="Starting value" />
        ) : t?.kind === 'int' || t?.kind === 'float' ? (
          <input className={inputCls} type="number" step={t.kind === 'int' ? 1 : 'any'} value={typeof v.default === 'number' ? v.default : ''} placeholder="(none)" onChange={(e) => upd({ default: e.target.value === '' ? null : t.kind === 'int' ? Math.trunc(+e.target.value) : +e.target.value }, 'Set default', `vdef:${v.id}`)} data-testid="var-default" aria-label="Starting value" />
        ) : t?.kind === 'string' ? (
          <LiveText value={typeof v.default === 'string' ? v.default : ''} onChange={(x) => upd({ default: x }, 'Set default', `vdef:${v.id}`)} testId="var-default" label="Starting value" />
        ) : fields ? (
          <div className="flex gap-1">
            {fields.map((f) => (
              <input key={f.name} aria-label={f.name} title={f.name} className={inputCls} type="number" step="any" value={typeof o[f.name] === 'number' ? (o[f.name] as number) : 0} onChange={(e) => upd({ default: { ...Object.fromEntries(fields.map((x) => [x.name, typeof o[x.name] === 'number' ? o[x.name] : 0])), [f.name]: +e.target.value } }, 'Set default', `vdef:${v.id}`)} />
            ))}
          </div>
        ) : (
          <div className="text-[11px] text-muted">{t?.kind === 'named' ? 'Starts empty (null): set it in a graph, e.g. from Get Node in Ready.' : 'Set it in a graph.'}</div>
        )}
      </Row>
      {!fn && (
        <>
          <label className="gs-row mb-1.5 flex items-center gap-2 text-[12px]">
            <input type="checkbox" className="h-4 w-4 accent-[var(--color-accent)]" checked={!!v.exported} onChange={(e) => upd({ exported: e.target.checked }, 'Toggle export')} data-testid="var-exported" /> Editable in the Inspector (per node)
          </label>
          <label className="gs-row mb-2.5 flex items-center gap-2 text-[12px]">
            <input type="checkbox" className="h-4 w-4 accent-[var(--color-accent)]" checked={!!v.constant} onChange={(e) => upd({ constant: e.target.checked }, 'Toggle constant')} /> Constant (never changes)
          </label>
        </>
      )}
      <Row label="Description">
        <LiveText multiline value={v.description ?? ''} onChange={(x) => upd({ description: x }, 'Edit description', `vdesc:${v.id}`)} label="Description" />
      </Row>
    </div>
  );
}

function FunctionEditor({ path, fn, doc, d }: { path: string; fn: FunctionDecl; doc: ScriptDoc; d: Dispatch }) {
  const isEvent = fn.kind === 'event';
  const ev = isEvent ? EVENTS.find((e) => e.id === fn.event) : undefined;
  const build = useVisualBuild(path);
  const upd = (patch: Record<string, unknown>, label: string, merge?: string) => d([{ op: 'update_function', function: fn.id, ...patch } as EditOp], label, merge);
  const diags = build.diagnostics.filter((x) => x.functionId === fn.id && !x.nodeId);
  return (
    <div data-testid="function-inspector">
      <div className="mb-1 text-[14px] font-semibold">{isEvent ? `${functionTitle(fn)} event` : `Function ${fn.name}`}</div>
      {isEvent ? (
        <p className="mb-3 text-[12px] leading-snug text-[#c3c9d4]">
          {ev?.description} <span className="font-mono text-[11px] text-faint">{fn.name}</span>
        </p>
      ) : (
        <>
          <p className="mb-3 text-[12px] leading-snug text-muted">Run it with a “Call {fn.name}” node, or from Connect Signal.</p>
          <Row label="Name">
            <CommitInput value={fn.name} onCommit={(name) => upd({ name }, 'Rename function')} testId="fn-name" label="Function name" />
          </Row>
          <ParamsEditor label="Parameters" params={fn.params} onCommit={(params) => upd({ params }, 'Edit parameters')} />
          <Row label="Returns" hint="void = nothing.">
            <TypeInput value={fn.returnType} onCommit={(returnType) => upd({ returnType }, 'Change return type')} testId="fn-return" label="Return type" />
          </Row>
          <Row label="Description">
            <LiveText multiline value={fn.description ?? ''} onChange={(x) => upd({ description: x }, 'Edit description', `fdesc:${fn.id}`)} label="Description" />
          </Row>
        </>
      )}
      <DiagList items={diags} />
      <Row label="Local variables" hint="Only exist while this runs.">
        {fn.locals.map((l) => (
          <details key={l.id} className="mb-1 rounded border border-border px-2 py-1">
            <summary className="cursor-pointer text-[12px]">
              {l.name}: <span className="font-mono text-muted">{l.type}</span>
            </summary>
            <div className="mt-2">
              <VariableEditor v={l} fn={fn} d={d} />
              <button className="mb-1 text-[11.5px] text-err hover:underline" onClick={() => d([{ op: 'delete_variable', variable: l.id, function: fn.id }], 'Delete local')}>
                Delete local variable
              </button>
            </div>
          </details>
        ))}
        <button
          className="touch-target flex items-center gap-1 text-[11.5px] text-accent hover:underline"
          onClick={() => {
            const taken = new Set([...fn.params, ...fn.locals, ...doc.variables, ...doc.functions, ...doc.signals].map((x) => x.name));
            let n = 'temp';
            for (let i = 2; taken.has(n); i++) n = `temp${i}`;
            d([{ op: 'add_variable', function: fn.id, name: n, type: 'float', default: 0 }], 'Add local variable');
          }}
        >
          <Plus size={12} /> Add local variable
        </button>
      </Row>
    </div>
  );
}

function ScriptSettings({ path, doc, d }: { path: string; doc: ScriptDoc; d: Dispatch }) {
  const build = useVisualBuild(path);
  const diags = build.diagnostics.filter((x) => !x.functionId && !x.nodeId);
  return (
    <div data-testid="script-inspector">
      <div className="mb-1 text-[14px] font-semibold">Script {doc.name}</div>
      <div className="mb-3 font-mono text-[10.5px] text-faint">{path}</div>
      <DiagList items={diags} />
      <Row label="Runs on a node of type" hint="The kind of node this script goes on (CharacterBody2D for a player, Area2D for a pickup…). Its properties and functions are available as nodes.">
        <ExtendsPicker path={path} doc={doc} testId="setting-extends" />
      </Row>
      <Row label="Class name" hint="The name of the generated class: starts with a capital letter, e.g. Player.">
        <CommitInput value={doc.name} onCommit={(name) => d([{ op: 'update_script', name }], 'Rename class')} mono testId="script-class-name" label="Class name" />
      </Row>
      <Row label="Description">
        <LiveText multiline value={doc.description ?? ''} onChange={(x) => d([{ op: 'update_script', description: x }], 'Edit description', `sdesc:${doc.id}`)} label="Description" />
      </Row>
    </div>
  );
}

function SignalEditor({ id, doc, d }: { id: string; doc: ScriptDoc; d: Dispatch }) {
  const s = doc.signals.find((x) => x.id === id);
  if (!s) return null;
  return (
    <div data-testid="signal-inspector">
      <div className="mb-1 text-[14px] font-semibold">Signal {s.name}</div>
      <p className="mb-3 text-[12px] leading-snug text-muted">Send it with an “Emit {s.name}” node; other scripts can connect to it.</p>
      <Row label="Name">
        <CommitInput value={s.name} onCommit={(name) => d([{ op: 'update_signal', signal: s.id, name }], 'Rename signal')} label="Signal name" />
      </Row>
      <ParamsEditor label="Values it passes" params={s.params} onCommit={(params) => d([{ op: 'update_signal', signal: s.id, params }], 'Edit signal parameters')} />
    </div>
  );
}

function MultiSelection({ nodes, edges }: { nodes: number; edges: number }) {
  return (
    <div className="space-y-3" data-testid="multi-inspector">
      <div className="text-[13px]">{nodes ? `${nodes} node${nodes === 1 ? '' : 's'} selected` : `${edges} connection${edges === 1 ? '' : 's'} selected`}</div>
      <div className="flex flex-wrap gap-1.5">
        {nodes > 0 && (
          <>
            <Button onClick={duplicateSelection}>
              <CopyPlus size={12} /> Duplicate
            </Button>
            <Button onClick={toggleCollapse}>
              <FoldVertical size={12} /> Collapse
            </Button>
            <Button onClick={frameSelection}>
              <SquareDashed size={12} /> Frame
            </Button>
          </>
        )}
        <Button variant="danger" onClick={deleteSelection} data-testid="inspector-delete-selection">
          <Trash2 size={12} /> Delete
        </Button>
      </div>
      <div className="text-[11px] text-faint">Ctrl+D duplicates, Del deletes. Shift-click or drag a box to select several.</div>
    </div>
  );
}

export default function GraphInspector({ path }: { path: string }) {
  const parsed = useVisualDoc(path);
  const activeFn = useGraphUi((s) => s.activeFn[path]);
  const doc = parsed.doc;
  const fn = doc ? pickFunction(doc, activeFn) : undefined;
  const selection = useGraphSelection(path, fn?.id);
  const insp = useGraphUi((s) => (s.inspect?.path === path ? s.inspect : null));
  if (!doc) return <EmptyState title="Can't read this visual script">{parsed.error}</EmptyState>;
  const d: Dispatch = (ops, label, mergeKey) => void editVisualScript(path, ops, label, { mergeKey, functionId: fn?.id });
  let body: React.ReactNode;
  if (fn && selection.nodes.length === 1 && fn.graph.nodes.some((n) => n.id === selection.nodes[0])) body = <NodeInspector key={selection.nodes[0]} path={path} nodeId={selection.nodes[0]} doc={doc} fn={fn} d={d} />;
  else if (selection.nodes.length > 1 || selection.edges.length) body = <MultiSelection nodes={selection.nodes.length} edges={selection.edges.length} />;
  else if (insp?.kind === 'variable' && doc.variables.some((v) => v.id === insp.id)) body = <VariableEditor key={insp.id} v={doc.variables.find((v) => v.id === insp.id)!} d={d} />;
  else if (insp?.kind === 'signal' && doc.signals.some((s) => s.id === insp.id)) body = <SignalEditor id={insp.id} doc={doc} d={d} />;
  else if (insp?.kind === 'script') body = <ScriptSettings path={path} doc={doc} d={d} />;
  else if (fn) body = <FunctionEditor key={fn.id} path={path} fn={fn} doc={doc} d={d} />;
  else body = <ScriptSettings path={path} doc={doc} d={d} />;
  return (
    <div className="p-3" data-testid="graph-inspector">
      <TypeDatalist doc={doc} />
      <div className="mb-3 flex items-center gap-2 text-[11px]">
        <span className="min-w-0 flex-1 truncate text-faint">
          {doc.name} · {typeof doc.settings.extends === 'string' ? doc.settings.extends : '?'}
        </span>
        <button className="shrink-0 text-accent hover:underline" onClick={() => inspect({ path, kind: 'script', id: doc.id })} data-testid="open-script-settings">
          Script settings
        </button>
      </div>
      {body}
    </div>
  );
}
