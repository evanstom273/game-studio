/** Right-click / long-press menu for graph nodes (ported from Coding Studio). A bottom sheet on phones. */
import { useEffect } from 'react';
import { Copy, CopyPlus, FoldVertical, FunctionSquare, Scissors, SquareDashed, Trash2, Unlink, type LucideIcon } from 'lucide-react';
import { cx } from '../ui/primitives';
import { copySelection, cutSelection, deleteSelection, disconnectNode, duplicateSelection, frameSelection, toggleCollapse } from './commands';

export interface NodeMenuProps {
  x: number;
  y: number;
  nodeId: string;
  title: string;
  isEntry: boolean;
  /** "Open function" for Call / Connect Signal nodes. */
  open?: { label: string; run: () => void };
  sheet?: boolean;
  onClose: () => void;
}

export function NodeContextMenu({ x, y, nodeId, title, isEntry, open, sheet, onClose }: NodeMenuProps) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  const item = (Icon: LucideIcon, label: string, kbd: string, fn: () => void, disabled = false, danger = false) => (
    <button
      key={label}
      disabled={disabled}
      role="menuitem"
      onClick={() => {
        onClose();
        fn();
      }}
      className={cx('flex w-full items-center gap-2.5 px-3 text-left hover:bg-accent/20 disabled:opacity-40', sheet ? 'min-h-[46px] text-[14px]' : 'py-1 text-[12px]', danger && 'text-err')}
      data-testid={`node-menu-${label.toLowerCase().replace(/[^a-z]+/g, '-')}`}
    >
      <Icon size={sheet ? 17 : 13} className={danger ? undefined : 'text-muted'} />
      <span className="flex-1">{label}</span>
      {!sheet && <span className="text-[10.5px] text-muted">{kbd}</span>}
    </button>
  );
  const left = Math.max(8, Math.min(x, window.innerWidth - 228));
  const top = Math.max(8, Math.min(y, window.innerHeight - 300));
  return (
    <div className={cx('fixed inset-0 z-40', sheet && 'bg-black/40')} onPointerDown={onClose} onContextMenu={(e) => e.preventDefault()}>
      <div
        className={cx('absolute border border-border bg-panel py-1 shadow-2xl', sheet ? 'safe-bottom inset-x-0 bottom-0 rounded-t-xl' : 'min-w-[220px] rounded-md')}
        style={sheet ? undefined : { left, top }}
        onPointerDown={(e) => e.stopPropagation()}
        role="menu"
        aria-label={`${title} actions`}
        data-testid="node-menu"
        data-node-id={nodeId}
      >
        {sheet && <div className="truncate border-b border-border px-3 pb-2 pt-1 text-[12px] font-semibold text-muted">{title}</div>}
        {open && item(FunctionSquare, open.label, 'Double-click', open.run)}
        {item(CopyPlus, 'Duplicate', 'Ctrl+D', duplicateSelection, isEntry)}
        {item(Copy, 'Copy', 'Ctrl+C', () => void copySelection(), isEntry)}
        {item(Scissors, 'Cut', 'Ctrl+X', cutSelection, isEntry)}
        {item(FoldVertical, 'Collapse / expand', '', toggleCollapse)}
        {item(SquareDashed, 'Wrap in comment frame', '', frameSelection)}
        {item(Unlink, 'Disconnect all wires', '', () => disconnectNode(nodeId))}
        <div className="my-1 border-t border-border" />
        {item(Trash2, 'Delete', 'Del', deleteSelection, isEntry, true)}
      </div>
    </div>
  );
}
