/** A graph node, Unreal Blueprint style (ported from Coding Studio): coloured header, pins, inline values. */
import { memo } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import { AlertTriangle, ChevronDown, ChevronRight, XCircle } from 'lucide-react';
import type { PortSpec } from '@cs/node-registry';
import { formatType } from '@cs/type-system';
import { cx } from '../ui/primitives';
import { headerColor, portColor, type BPNodeData } from './model';
import { InlineInput } from './InlineInput';
import { editVisualScript } from './store';

function Pin({ port, connected, side }: { port: PortSpec; connected: boolean; side: 'in' | 'out' }) {
  const color = portColor(port.kind, port.type);
  const style =
    port.kind === 'exec'
      ? { width: 'var(--pin-exec-w, 11px)', height: 'var(--pin-exec-h, 13px)', borderRadius: 0, background: connected ? color : '#1a1e26', border: 'none', clipPath: 'polygon(0 0, 55% 0, 100% 50%, 55% 100%, 0 100%)', boxShadow: connected ? undefined : `inset 0 0 0 2px ${color}` }
      : { width: 'var(--pin-size, 11px)', height: 'var(--pin-size, 11px)', borderRadius: 999, background: connected ? color : '#1a1e26', border: `2px solid ${color}` };
  const title = port.kind === 'exec' ? port.name || (side === 'in' ? 'Run' : 'Then') : `${port.name || port.id}: ${port.type ? formatType(port.type) : 'any'}${port.description ? ` — ${port.description}` : ''}`;
  return <Handle type={side === 'in' ? 'target' : 'source'} position={side === 'in' ? Position.Left : Position.Right} id={port.id} className={cx('bp-pin', port.kind === 'exec' && 'bp-pin-exec')} style={{ ...style, [side === 'in' ? 'left' : 'right']: -6 }} title={title} data-testid={`pin-${side}-${port.id}`} />;
}

function BlueprintNodeImpl({ id, data }: NodeProps<Node<BPNodeData>>) {
  const { info, connected, diag, path, fnId } = data;
  const node = info.node;
  const collapsed = !!node.collapsed;
  const inputs = info.ports.filter((p) => p.direction === 'in');
  const outputs = info.ports.filter((p) => p.direction === 'out');
  const rows = Math.max(inputs.length, outputs.length);
  const isConn = (p: PortSpec) => connected.includes(`${p.direction}:${p.id}`);
  const pure = info.def?.flavor === 'pure';
  const color = headerColor(info);
  const portDiag = (p: PortSpec) => (diag && diag.port === p.id ? diag.severity : undefined);
  return (
    <div
      className={cx('bp-node rounded-md border bg-[#1c212b]/95 shadow-lg', diag?.severity === 'error' ? 'border-err' : diag?.severity === 'warning' ? 'border-warn/80' : 'border-[#0b0d11]')}
      style={{ minWidth: pure ? 120 : 170 }}
      data-testid="graph-node"
      data-node-type={node.type}
      data-node-id={id}
      data-diag={diag?.severity}
    >
      <div className={cx('bp-header flex items-center gap-1.5 rounded-t-[5px] px-2 py-1 text-[12px] font-semibold text-white', collapsed && 'rounded-b-[5px]')} style={{ background: `linear-gradient(90deg, ${color}, ${color}aa)` }}>
        <button
          className="bp-collapse nodrag -ml-1 flex items-center justify-center text-white/60 hover:text-white"
          aria-label={collapsed ? 'Expand node' : 'Collapse node'}
          onClick={() => editVisualScript(path, [{ op: 'update_node', node: id, collapsed: !collapsed }], collapsed ? 'Expand node' : 'Collapse node', { functionId: fnId })}
        >
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        </button>
        <span className="truncate" data-testid="node-title">
          {info.title}
        </span>
        {diag && (diag.severity === 'error' ? <XCircle size={13} className="ml-auto shrink-0 text-red-300" aria-label={diag.message} /> : diag.severity === 'warning' ? <AlertTriangle size={13} className="ml-auto shrink-0 text-amber-300" aria-label={diag.message} /> : null)}
      </div>
      {collapsed ? (
        // Keep every handle mounted (edges need them) but stacked invisibly on the header.
        <div className="relative h-0">
          {inputs.map((p) => (
            <div key={p.id} className="absolute left-0 top-[-12px] h-0 w-0 opacity-60">
              <Pin port={p} connected={isConn(p)} side="in" />
            </div>
          ))}
          {outputs.map((p) => (
            <div key={p.id} className="absolute right-0 top-[-12px] h-0 w-0 opacity-60">
              <Pin port={p} connected={isConn(p)} side="out" />
            </div>
          ))}
        </div>
      ) : (
        <div className="py-1">
          {Array.from({ length: rows }, (_, i) => {
            const a = inputs[i];
            const b = outputs[i];
            return (
              <div key={i} className="bp-row relative flex min-h-[22px] items-center justify-between gap-3">
                <div className="bp-row relative flex min-h-[22px] items-center gap-1.5 pl-3">
                  {a && (
                    <>
                      <Pin port={a} connected={isConn(a)} side="in" />
                      {(a.name || a.kind === 'data') && <span className={cx('whitespace-nowrap text-[11px]', portDiag(a) === 'error' ? 'text-red-300' : portDiag(a) === 'warning' ? 'text-amber-200' : 'text-[#c3c9d4]')}>{a.name}</span>}
                      {a.kind === 'data' && !isConn(a) && <InlineInput path={path} fnId={fnId} nodeId={id} port={a} value={node.inputs[a.id]} />}
                    </>
                  )}
                </div>
                <div className="bp-row relative flex min-h-[22px] items-center gap-1.5 pr-3">
                  {b && (
                    <>
                      {b.name && <span className={cx('whitespace-nowrap text-[11px]', portDiag(b) === 'error' ? 'text-red-300' : 'text-[#c3c9d4]')}>{b.name}</span>}
                      <Pin port={b} connected={isConn(b)} side="out" />
                    </>
                  )}
                </div>
              </div>
            );
          })}
          {diag && diag.severity !== 'info' && (
            <div className={cx('mx-2 mb-1 mt-0.5 max-w-[260px] rounded px-1.5 py-0.5 text-[10.5px] leading-snug', diag.severity === 'error' ? 'bg-red-500/15 text-red-200' : 'bg-amber-400/10 text-amber-200')} data-testid="node-diagnostic">
              {diag.message}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export const BlueprintNode = memo(BlueprintNodeImpl);
