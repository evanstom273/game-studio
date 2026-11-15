/** Inline literal editor for an unconnected data input (ported from Coding Studio). */
import { memo, useEffect, useRef, useState } from 'react';
import type { JsonValue } from '@cs/graph-core';
import type { PortSpec } from '@cs/node-registry';
import { gameStudioToolchain } from '@gs/visual';
import { cx, inputCls, isTouch } from '../ui/primitives';
import { editVisualScript } from './store';

export function commitInput(path: string, fnId: string, nodeId: string, port: string, value: JsonValue | null) {
  editVisualScript(path, [{ op: 'update_node', node: nodeId, inputs: { [port]: value } }], 'Edit value', { mergeKey: `inline:${nodeId}:${port}`, functionId: fnId });
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 10000) / 10000));

function NumberBox({ value, int, onCommit, label, className }: { value: number; int: boolean; onCommit: (v: number) => void; label: string; className?: string }) {
  const [text, setText] = useState(fmt(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(fmt(value));
  }, [value]);
  return (
    <input
      aria-label={label}
      className={className ?? 'bp-input nodrag nopan w-[52px]'}
      value={text}
      inputMode="decimal"
      onFocus={(e) => {
        focused.current = true;
        if (!isTouch()) e.target.select();
      }}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value.trim() !== '' && Number.isFinite(n) && (!int || Number.isInteger(n))) onCommit(n);
      }}
      onBlur={() => {
        focused.current = false;
        setText(fmt(value));
      }}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

function TextBox({ value, onCommit, label, placeholder, className, grow }: { value: string; onCommit: (v: string) => void; label: string; placeholder?: string; className: string; grow?: boolean }) {
  const [text, setText] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(value);
  }, [value]);
  return (
    <input
      aria-label={label}
      className={className}
      // On the node: as wide as the text (within limits), so values stay readable.
      style={grow ? { width: `${Math.min(26, Math.max(9, text.length + 2))}ch` } : undefined}
      value={text}
      placeholder={placeholder}
      onFocus={() => (focused.current = true)}
      onBlur={() => {
        focused.current = false;
        setText(value);
      }}
      onChange={(e) => {
        setText(e.target.value);
        onCommit(e.target.value);
      }}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

/** Whether a port gets an inline editor at all. */
export function hasInlineEditor(port: PortSpec): boolean {
  const t = port.type;
  if (!t || port.connectionOnly || port.kind !== 'data') return false;
  if (t.kind === 'named') return !!gameStudioToolchain().adapter.types.structFields(t.name);
  return t.kind === 'bool' || t.kind === 'int' || t.kind === 'float' || t.kind === 'string' || t.kind === 'any';
}

/** The value editor for one input. `wide`: the inspector's roomier version. */
export const InlineInput = memo(function InlineInput({ path, fnId, nodeId, port, value, wide }: { path: string; fnId: string; nodeId: string; port: PortSpec; value: JsonValue | undefined; wide?: boolean }) {
  const t = port.type;
  if (!t || !hasInlineEditor(port)) return null;
  const v = value !== undefined ? value : port.default;
  const label = `${port.name || port.id} value`;
  const commit = (x: JsonValue | null) => commitInput(path, fnId, nodeId, port.id, x);
  switch (t.kind) {
    case 'bool':
      return <input aria-label={label} type="checkbox" className={wide ? 'h-4 w-4 accent-[#e05a5a]' : 'bp-check nodrag nopan accent-[#e05a5a]'} checked={v === true} onChange={(e) => commit(e.target.checked)} />;
    case 'int':
    case 'float':
      return <NumberBox label={label} value={typeof v === 'number' ? v : 0} int={t.kind === 'int'} onCommit={commit} className={wide ? inputCls : undefined} />;
    case 'string':
      return <TextBox label={label} value={typeof v === 'string' ? v : ''} onCommit={commit} grow={!wide} className={wide ? inputCls : 'bp-input nodrag nopan'} />;
    case 'any':
      return <TextBox label={label} placeholder="value" value={v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v)} onCommit={commit} grow={!wide} className={wide ? inputCls : 'bp-input nodrag nopan'} />;
    case 'named': {
      const fields = gameStudioToolchain().adapter.types.structFields(t.name)!;
      const obj = (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as Record<string, JsonValue>;
      const num = (k: string) => (typeof obj[k] === 'number' ? (obj[k] as number) : 0);
      return (
        <span className={cx('flex gap-0.5', wide && 'w-full')}>
          {fields.map((f) => (
            <NumberBox key={f.name} label={`${label} ${f.name}`} value={num(f.name)} int={f.type.kind === 'int'} className={wide ? cx(inputCls, 'flex-1 px-1 text-center') : 'bp-input nodrag nopan w-[44px]'} onCommit={(n) => commit({ ...Object.fromEntries(fields.map((x) => [x.name, num(x.name)])), [f.name]: n })} />
          ))}
        </span>
      );
    }
    default:
      return null;
  }
});
