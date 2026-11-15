/**
 * The script panel of a visual script (ported from Coding Studio's LeftSidebar): the node type it
 * extends, and its events, functions, variables and signals. Click an event or function to open
 * its graph; click a variable or signal to edit it in the inspector.
 */
import { useState } from 'react';
import { ChevronDown, ChevronRight, Plus, Radio, SquareFunction, Trash2, Variable, Zap } from 'lucide-react';
import type { ScriptDoc } from '@cs/graph-core';
import type { EditOp } from '@cs/project-format';
import { EVENTS } from '@gs/visual';
import { nodeTypes } from '@gs/core';
import { useLayout } from '@editor/lib/layout';
import { useUi } from '@editor/store/ui';
import { IconButton, cx, inputCls } from '../ui/primitives';
import { confirmDialog } from '../ui/feedback';
import { NodeIcon } from '../ui/NodeIcon';
import { editVisualScript, functionTitle, inspect, openFunction, uniqueMemberName, useGraphUi, useVisualBuild } from './store';

function Section({ title, icon, onAdd, addLabel, children, count, testId }: { title: string; icon: React.ReactNode; onAdd?: () => void; addLabel?: string; children: React.ReactNode; count: number; testId: string }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="mb-1">
      <div className="flex items-center gap-1 px-2 py-1">
        <button className="touch-target flex flex-1 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted hover:text-text" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} {icon} {title} <span className="font-normal">({count})</span>
        </button>
        {onAdd && (
          <IconButton label={addLabel ?? `Add ${title}`} onClick={onAdd} className="h-6 min-w-6" data-testid={`add-${testId}`}>
            <Plus size={14} />
          </IconButton>
        )}
      </div>
      {open && <div>{children}</div>}
    </div>
  );
}

function Row({ active, onClick, icon, label, sub, onDelete, testId, errors }: { active?: boolean; onClick: () => void; icon: React.ReactNode; label: string; sub?: string; onDelete?: () => void; testId?: string; errors?: number }) {
  return (
    <div className={cx('gs-row group mx-1 flex cursor-pointer items-center gap-1.5 rounded px-2 py-[3px] text-[12px]', active ? 'bg-accent/20 text-text' : 'hover:bg-panel-2')} onClick={onClick} data-testid={testId} data-label={label}>
      {icon}
      <span className="truncate">{label}</span>
      {sub && <span className="truncate text-[10.5px] text-muted">{sub}</span>}
      {!!errors && <span className="ml-auto shrink-0 rounded bg-red-500/20 px-1 text-[10px] text-red-300">{errors}</span>}
      {onDelete && (
        <button
          className={cx('touch-target flex shrink-0 items-center justify-center rounded p-0.5 text-muted opacity-60 hover:text-err group-hover:opacity-100 [@media(pointer:fine)]:opacity-0', !errors && 'ml-auto')}
          aria-label={`Delete ${label}`}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          <Trash2 size={12} />
        </button>
      )}
    </div>
  );
}

/** The node type a script extends: grouped by family, with each type's icon shown alongside. */
export function ExtendsPicker({ path, doc, testId }: { path: string; doc: ScriptDoc; testId?: string }) {
  const ext = typeof doc.settings.extends === 'string' ? doc.settings.extends : '';
  const groups = new Map<string, string[]>();
  for (const t of nodeTypes.all()) {
    const list = groups.get(t.category) ?? [];
    list.push(t.name);
    groups.set(t.category, list);
  }
  return (
    <div className="flex items-center gap-1.5">
      {ext && nodeTypes.has(ext) && <NodeIcon type={ext} size={15} />}
      <select
        className={cx(inputCls, 'px-1')}
        value={ext}
        onChange={(e) => editVisualScript(path, [{ op: 'update_script', settings: { extends: e.target.value } }], `Extend ${e.target.value}`)}
        aria-label="Node type"
        data-testid={testId ?? 'script-extends'}
      >
        {!nodeTypes.has(ext) && <option value={ext}>{ext || '(choose a node type)'}</option>}
        {[...groups].map(([cat, names]) => (
          <optgroup key={cat} label={cat}>
            {names.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}

export function MembersPanel({ path, doc, fnId, onOpened }: { path: string; doc: ScriptDoc; fnId?: string; onOpened?: () => void }) {
  const build = useVisualBuild(path);
  const insp = useGraphUi((s) => (s.inspect?.path === path ? s.inspect : null));
  const compact = useLayout().mode === 'compact';
  const [eventMenu, setEventMenu] = useState(false);
  const d = (ops: EditOp[], label: string) => editVisualScript(path, ops, label);
  const errorsIn = (id: string) => build.diagnostics.filter((x) => x.functionId === id && x.severity === 'error').length;
  const scriptErrors = build.diagnostics.filter((x) => !x.functionId && x.severity === 'error');
  /** Show a member in the inspector (on phones: in the inspector sheet). */
  const show = (kind: 'variable' | 'signal' | 'function' | 'script', id: string) => {
    inspect({ path, kind, id });
    if (compact && kind !== 'function') {
      onOpened?.();
      useUi.getState().set({ sheet: 'inspector', sheetSize: 'half' });
    }
  };
  const open = (id: string) => {
    openFunction(path, id);
    inspect({ path, kind: 'function', id });
    onOpened?.();
  };
  const del = async (what: string, ops: EditOp[]) => {
    if (!(await confirmDialog({ title: `Delete ${what}?`, message: `${what} will be removed. You can undo this.`, confirm: 'Delete', danger: true }))) return;
    d(ops, `Delete ${what}`);
  };
  const missing = EVENTS.filter((ev) => !doc.functions.some((f) => f.kind === 'event' && f.event === ev.id));

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel" data-testid="graph-members">
      <div className="shrink-0 border-b border-border px-2.5 py-2">
        <button className="mb-1 block max-w-full truncate text-left text-[13px] font-semibold hover:text-accent" onClick={() => show('script', doc.id)} title="Script settings" data-testid="script-name">
          {doc.name}
        </button>
        <div className="mb-1 text-[11px] text-muted">Runs on a node of type</div>
        <ExtendsPicker path={path} doc={doc} />
        {scriptErrors.map((x, i) => (
          <div key={i} className="mt-1.5 rounded bg-red-500/15 px-1.5 py-1 text-[11px] leading-snug text-red-200">
            {x.message}
          </div>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1 text-[12px]">
        <Section title="Events" testId="event" icon={<Zap size={12} />} count={doc.functions.filter((f) => f.kind === 'event').length} onAdd={missing.length ? () => setEventMenu(!eventMenu) : undefined} addLabel="Add event">
          {eventMenu && (
            <div className="mx-2 mb-1 rounded border border-border bg-panel-2 py-1" data-testid="event-menu">
              {missing.map((ev) => (
                <button
                  key={ev.id}
                  className="gs-row block w-full px-2 py-1 text-left hover:bg-accent/20"
                  title={ev.description}
                  data-testid={`add-event-${ev.id}`}
                  onClick={() => {
                    setEventMenu(false);
                    const r = d([{ op: 'add_function', ref: 'f', kind: 'event', event: ev.id }], `Add ${ev.title}`);
                    if (r) open(r.created.f);
                  }}
                >
                  <div>{ev.title}</div>
                  <div className="text-[10.5px] leading-snug text-muted">{ev.description}</div>
                </button>
              ))}
            </div>
          )}
          {doc.functions
            .filter((f) => f.kind === 'event')
            .map((f) => (
              <Row key={f.id} testId="function-row" active={f.id === fnId} errors={errorsIn(f.id)} icon={<Zap size={13} className="shrink-0 text-red-300" />} label={functionTitle(f)} sub={f.name} onClick={() => open(f.id)} onDelete={() => void del(`the ${functionTitle(f)} event`, [{ op: 'delete_function', function: f.id }])} />
            ))}
        </Section>
        <Section
          title="Functions"
          testId="function"
          icon={<SquareFunction size={12} />}
          count={doc.functions.filter((f) => f.kind === 'function').length}
          onAdd={() => {
            const r = d([{ op: 'add_function', ref: 'f', name: uniqueMemberName(doc, 'newFunction') }], 'Add function');
            if (r) open(r.created.f);
          }}
        >
          {doc.functions
            .filter((f) => f.kind === 'function')
            .map((f) => (
              <Row key={f.id} testId="function-row" active={f.id === fnId} errors={errorsIn(f.id)} icon={<SquareFunction size={13} className="shrink-0 text-blue-300" />} label={f.name} sub={`(${f.params.map((p) => p.name).join(', ')})`} onClick={() => open(f.id)} onDelete={() => void del(`function ${f.name}`, [{ op: 'delete_function', function: f.id }])} />
            ))}
          {/* Inline functions (closures), listed with the function they belong to. */}
          {doc.functions
            .filter((f) => f.kind === 'lambda')
            .map((f) => (
              <Row key={f.id} testId="function-row" active={f.id === fnId} errors={errorsIn(f.id)} icon={<span className="pl-2 text-[11px] text-muted">↳</span>} label={f.name} sub={`inline in ${doc.functions.find((o) => o.id === f.owner)?.name ?? '?'}`} onClick={() => open(f.id)} onDelete={() => void del(`inline function ${f.name}`, [{ op: 'delete_function', function: f.id }])} />
            ))}
        </Section>
        <Section
          title="Variables"
          testId="variable"
          icon={<Variable size={12} />}
          count={doc.variables.length}
          onAdd={() => {
            const r = d([{ op: 'add_variable', ref: 'v', name: uniqueMemberName(doc, 'newVariable'), type: 'float', default: 0 }], 'Add variable');
            if (r) show('variable', r.created.v);
          }}
        >
          {doc.variables.map((v) => (
            <Row
              key={v.id}
              testId="variable-row"
              active={insp?.kind === 'variable' && insp.id === v.id}
              icon={<span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: v.constant ? '#94a3b8' : '#4ade80' }} />}
              label={v.name}
              sub={`${v.type}${v.exported ? ' · inspector' : ''}${v.constant ? ' · const' : ''}`}
              onClick={() => show('variable', v.id)}
              onDelete={() => void del(`variable ${v.name}`, [{ op: 'delete_variable', variable: v.id }])}
            />
          ))}
        </Section>
        <Section
          title="Signals"
          testId="signal"
          icon={<Radio size={12} />}
          count={doc.signals.length}
          onAdd={() => {
            const r = d([{ op: 'add_signal', ref: 's', name: uniqueMemberName(doc, 'newSignal') }], 'Add signal');
            if (r) show('signal', r.created.s);
          }}
        >
          {doc.signals.map((s) => (
            <Row key={s.id} testId="signal-row" active={insp?.kind === 'signal' && insp.id === s.id} icon={<Radio size={13} className="shrink-0 text-orange-300" />} label={s.name} sub={`(${s.params.map((p) => p.name).join(', ')})`} onClick={() => show('signal', s.id)} onDelete={() => void del(`signal ${s.name}`, [{ op: 'delete_signal', signal: s.id }])} />
          ))}
        </Section>
      </div>
    </div>
  );
}
