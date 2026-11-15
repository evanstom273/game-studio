/**
 * The scene tree: select, add, rename (double-click / F2), delete, duplicate, reorder and
 * reparent (drag and drop on desktop; "Move to…" on touch screens).
 */
import { useMemo, useState, type DragEvent } from 'react';
import { ChevronDown, ChevronRight, Copy, FileCode2, Link2, Pencil, Plus, Trash2, CornerDownRight, ArrowUp, ArrowDown, Star } from 'lucide-react';
import { errorMessage } from '@gs/shared';
import { findDocNode, nodeTypes, type NodeDoc, type SceneDoc } from '@gs/core';
import { projectDiagnostics } from '@gs/project';
import { useEditor, activeScenePath } from '@editor/store/editor';
import { useUi } from '@editor/store/ui';
import { toast } from '@editor/store/toasts';
import { deleteSelection, duplicateSelection } from '@editor/lib/actions';
import { EmptyState, IconButton, SectionHeader, TextInput, cx } from '../ui/primitives';
import { NodeIcon } from '../ui/NodeIcon';
import { useLayout } from '@editor/lib/layout';

export function SceneTreePanel() {
  const scenePath = useEditor(activeScenePath);
  const scene = useEditor((s) => (scenePath ? s.project?.scenes[scenePath] : undefined));
  const isMain = useEditor((s) => !!scenePath && s.project?.settings.mainScene === scenePath);
  const set = useUi((s) => s.set);
  if (!scenePath || !scene)
    return (
      <div className="flex h-full flex-col">
        <SectionHeader>Scene</SectionHeader>
        <EmptyState title="No scene open">Open a scene from Files to see its nodes.</EmptyState>
      </div>
    );
  return (
    <div className="flex h-full flex-col" data-testid="scene-tree">
      <SectionHeader
        right={
          <>
            {!isMain && (
              <IconButton
                label="Make this the main scene"
                className="h-6 min-w-6"
                onClick={() => {
                  useEditor.getState().dispatch([{ op: 'set_main_scene', path: scenePath }], { label: 'Set main scene' });
                  toast('success', `${scenePath} is now the main scene`);
                }}
              >
                <Star size={13} />
              </IconButton>
            )}
            <IconButton label="Add node (Ctrl+A)" className="h-6 min-w-6" onClick={() => set({ dialog: 'add-node' })} data-testid="add-node">
              <Plus size={14} />
            </IconButton>
          </>
        }
      >
        Scene {isMain && <span className="ml-1 normal-case text-faint">· main</span>}
      </SectionHeader>
      <Tree scenePath={scenePath} scene={scene} />
      <SelectionActions scenePath={scenePath} scene={scene} />
    </div>
  );
}

function Tree({ scenePath, scene }: { scenePath: string; scene: SceneDoc }) {
  const selection = useEditor((s) => s.selection);
  const project = useEditor((s) => s.project!);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; where: 'inside' | 'before' | 'after' } | null>(null);
  const warnings = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const d of projectDiagnostics(project)) if (d.file === scenePath && d.nodeId) m.set(d.nodeId, [...(m.get(d.nodeId) ?? []), d.message]);
    return m;
  }, [project, scenePath]);
  const { select, dispatch } = useEditor.getState();

  const onDrop = (e: DragEvent, target: NodeDoc, where: 'inside' | 'before' | 'after') => {
    e.preventDefault();
    setDropTarget(null);
    const id = e.dataTransfer.getData('text/gs-node');
    if (!id || id === target.id) return;
    try {
      if (where === 'inside') dispatch([{ op: 'reparent_node', scene: scenePath, node: id, parent: target.id, keepGlobalTransform: true }], { label: 'Move node' });
      else {
        const parent = findDocNode(scene, target.id)?.parent;
        if (!parent) return;
        const siblings = (parent.children ?? []).filter((c) => c.id !== id);
        const index = siblings.findIndex((c) => c.id === target.id) + (where === 'after' ? 1 : 0);
        dispatch([{ op: 'reparent_node', scene: scenePath, node: id, parent: parent.id, index, keepGlobalTransform: true }], { label: 'Move node' });
      }
    } catch (err) {
      toast('error', errorMessage(err));
    }
  };

  const rows: { node: NodeDoc; depth: number }[] = [];
  const walk = (n: NodeDoc, depth: number) => {
    rows.push({ node: n, depth });
    if (!collapsed.has(n.id)) for (const c of n.children ?? []) walk(c, depth + 1);
  };
  walk(scene.root, 0);

  return (
    <div className="min-h-0 flex-1 overflow-auto py-1" role="tree" aria-label="Scene tree" onClick={(e) => e.target === e.currentTarget && select([])}>
      {rows.map(({ node, depth }) => {
        const selected = selection.includes(node.id);
        const hasKids = !!node.children?.length;
        const warn = warnings.get(node.id);
        const isRoot = node.id === scene.root.id;
        return (
          <div
            key={node.id}
            role="treeitem"
            aria-selected={selected}
            aria-expanded={hasKids ? !collapsed.has(node.id) : undefined}
            draggable={!isRoot && renaming !== node.id}
            onDragStart={(e) => e.dataTransfer.setData('text/gs-node', node.id)}
            onDragOver={(e) => {
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              const y = (e.clientY - r.top) / r.height;
              setDropTarget({ id: node.id, where: isRoot ? 'inside' : y < 0.25 ? 'before' : y > 0.75 ? 'after' : 'inside' });
            }}
            onDragLeave={() => setDropTarget(null)}
            onDrop={(e) => onDrop(e, node, dropTarget?.id === node.id ? dropTarget.where : 'inside')}
            onClick={(e) => select(e.shiftKey || e.ctrlKey || e.metaKey ? (selected ? selection.filter((x) => x !== node.id) : [...selection, node.id]) : [node.id])}
            onDoubleClick={() => setRenaming(node.id)}
            onKeyDown={(e) => e.key === 'F2' && setRenaming(node.id)}
            tabIndex={0}
            className={cx(
              'gs-row group relative flex h-7 cursor-default select-none items-center gap-1 pr-2 text-[12px]',
              selected ? 'bg-accent/20 text-text' : 'text-text hover:bg-panel-2',
              dropTarget?.id === node.id && dropTarget.where === 'inside' && 'outline outline-1 -outline-offset-1 outline-accent',
            )}
            style={{ paddingLeft: 6 + depth * 14 }}
            data-testid="tree-row"
            data-node-id={node.id}
            data-node-name={node.name}
          >
            {dropTarget?.id === node.id && dropTarget.where !== 'inside' && <div className={cx('absolute inset-x-2 h-0.5 bg-accent', dropTarget.where === 'before' ? 'top-0' : 'bottom-0')} />}
            <button
              className={cx('flex h-5 w-4 shrink-0 items-center justify-center text-faint', !hasKids && 'invisible')}
              onClick={(e) => {
                e.stopPropagation();
                const next = new Set(collapsed);
                if (next.has(node.id)) next.delete(node.id);
                else next.add(node.id);
                setCollapsed(next);
              }}
              aria-label={collapsed.has(node.id) ? 'Expand' : 'Collapse'}
            >
              {collapsed.has(node.id) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
            </button>
            <NodeIcon type={node.type} size={14} />
            {renaming === node.id ? (
              <RenameInput
                value={node.name}
                onDone={(name) => {
                  setRenaming(null);
                  if (name && name !== node.name) {
                    try {
                      dispatch([{ op: 'rename_node', scene: scenePath, node: node.id, name }], { label: `Rename to ${name}` });
                    } catch (err) {
                      toast('error', errorMessage(err));
                    }
                  }
                }}
              />
            ) : (
              <span className="min-w-0 flex-1 truncate">{node.name}</span>
            )}
            {node.instance && <Link2 size={12} className="shrink-0 text-accent" aria-label={`Instance of ${node.instance}`} />}
            {node.script && <FileCode2 size={12} className="shrink-0 text-node-audio" aria-label={`Script ${node.script}`} />}
            {warn && (
              <span className="shrink-0 text-warn" title={warn.join('\n')} aria-label="Warning">
                ⚠
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function RenameInput({ value, onDone }: { value: string; onDone: (v: string) => void }) {
  const [v, setV] = useState(value);
  return (
    <TextInput
      autoFocus
      value={v}
      className="h-6 flex-1"
      onChange={(e) => setV(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => onDone(v.trim())}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') onDone(v.trim());
        if (e.key === 'Escape') onDone(value);
      }}
    />
  );
}

/** Buttons for the selection — the touch-friendly route to rename/reorder/reparent/delete. */
function SelectionActions({ scenePath, scene }: { scenePath: string; scene: SceneDoc }) {
  const selection = useEditor((s) => s.selection);
  const layout = useLayout();
  const [moving, setMoving] = useState(false);
  const one = selection.length === 1 ? findDocNode(scene, selection[0]) : null;
  if (!selection.length) return null;
  const isRoot = selection.includes(scene.root.id);
  const { dispatch } = useEditor.getState();
  const move = (delta: number) => {
    if (!one?.parent) return;
    const i = one.parent.children!.indexOf(one.node);
    try {
      dispatch([{ op: 'move_node', scene: scenePath, node: one.node.id, index: Math.max(0, i + delta) }], { label: 'Reorder' });
    } catch (e) {
      toast('error', errorMessage(e));
    }
  };
  const targets: NodeDoc[] = [];
  if (moving && one) {
    const walk = (n: NodeDoc) => {
      if (n.id === one.node.id) return;
      targets.push(n);
      for (const c of n.children ?? []) walk(c);
    };
    walk(scene.root);
  }
  return (
    <div className="shrink-0 border-t border-border bg-panel-2/60">
      <div className="flex flex-wrap items-center gap-0.5 px-1 py-1">
        {one && !isRoot && (
          <>
            <IconButton label="Move up" onClick={() => move(-1)}>
              <ArrowUp size={14} />
            </IconButton>
            <IconButton label="Move down" onClick={() => move(1)}>
              <ArrowDown size={14} />
            </IconButton>
            <IconButton label="Move to another parent" active={moving} onClick={() => setMoving(!moving)} data-testid="move-to">
              <CornerDownRight size={14} />
            </IconButton>
          </>
        )}
        {one && (
          <IconButton
            label="Rename"
            onClick={() => {
              const name = prompt('Rename node', one.node.name);
              if (name?.trim()) {
                try {
                  dispatch([{ op: 'rename_node', scene: scenePath, node: one.node.id, name: name.trim() }]);
                } catch (e) {
                  toast('error', errorMessage(e));
                }
              }
            }}
          >
            <Pencil size={14} />
          </IconButton>
        )}
        {!isRoot && (
          <>
            <IconButton label="Duplicate (Ctrl+D)" onClick={duplicateSelection} data-testid="duplicate-node">
              <Copy size={14} />
            </IconButton>
            <IconButton label="Delete (Del)" onClick={deleteSelection} data-testid="delete-node">
              <Trash2 size={14} className="text-err" />
            </IconButton>
          </>
        )}
        <span className="ml-auto truncate px-1 text-[11px] text-muted">{layout.touch ? '' : selection.length > 1 ? `${selection.length} nodes` : (one?.node.type ?? '')}</span>
      </div>
      {moving && one && (
        <div className="max-h-40 overflow-auto border-t border-border">
          <div className="px-2 pt-1 text-[11px] text-muted">Move “{one.node.name}” into:</div>
          {targets.map((t) => (
            <button
              key={t.id}
              className="gs-row flex w-full items-center gap-1.5 px-3 py-1 text-left text-[12px] hover:bg-panel-3"
              onClick={() => {
                try {
                  dispatch([{ op: 'reparent_node', scene: scenePath, node: one.node.id, parent: t.id, keepGlobalTransform: true }], { label: 'Move node' });
                  setMoving(false);
                } catch (e) {
                  toast('error', errorMessage(e));
                }
              }}
            >
              <NodeIcon type={t.type} size={13} /> {t.name} <span className="text-faint">{nodeTypes.get(t.type)?.name !== t.name ? t.type : ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
