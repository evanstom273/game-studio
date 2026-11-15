/** The scene viewport: 2D or 3D (chosen from the scene, switchable for mixed scenes) plus its toolbar. */
import { lazy, Suspense, useState } from 'react';
import { Copy, Crosshair, Magnet, Plus, Shapes, Trash2, Video } from 'lucide-react';
import { nodeTypes, walkDoc } from '@gs/core';
import { useEditor } from '@editor/store/editor';
import { useUi } from '@editor/store/ui';
import { useLayout } from '@editor/lib/layout';
import { deleteSelection, duplicateSelection } from '@editor/lib/actions';
import { IconButton, cx } from '../ui/primitives';
import { ToolButtons } from '../shell/Toolbar';

const Viewport2D = lazy(() => import('./Viewport2D'));
const Viewport3D = lazy(() => import('./Viewport3D'));

export const viewportEvents = new EventTarget();

function sceneDimensions(scenePath: string) {
  const scene = useEditor.getState().project?.scenes[scenePath];
  let has2 = false;
  let has3 = false;
  if (scene)
    walkDoc(scene.root, (n) => {
      const d = nodeTypes.dimension(n.type);
      if (d === '2d') has2 = true;
      if (d === '3d') has3 = true;
    });
  const root = scene ? nodeTypes.dimension(scene.root.type) : null;
  return { default: root ?? (has3 && !has2 ? '3d' : '2d'), mixed: has2 && has3 } as const;
}

export default function Viewport({ scenePath }: { scenePath: string }) {
  const [mode, setMode] = useState<'2d' | '3d'>(() => sceneDimensions(scenePath).default);
  const ui = useUi();
  const layout = useLayout();
  const hasSelection = useEditor((s) => s.selection.length > 0);
  const [cameraPreview, setCameraPreview] = useState(false);
  const compact = layout.mode === 'compact';
  return (
    <div className="flex h-full flex-col" data-testid="viewport" data-mode={mode}>
      <div className="flex min-h-9 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border bg-panel px-1">
        <div className="flex rounded border border-border p-0.5" role="radiogroup" aria-label="Viewport">
          {(['2d', '3d'] as const).map((m) => (
            <button key={m} role="radio" aria-checked={mode === m} onClick={() => setMode(m)} className={cx('touch-target rounded px-2 text-[11px] font-semibold', mode === m ? 'bg-accent text-white' : 'text-muted hover:text-text')} data-testid={`mode-${m}`}>
              {m.toUpperCase()}
            </button>
          ))}
        </div>
        <div className="mx-1 h-5 w-px bg-border" />
        <IconButton label="Snap to grid" active={ui.snap} onClick={() => ui.set({ snap: !ui.snap })} data-testid="snap">
          <Magnet size={14} />
        </IconButton>
        <IconButton label="Show collision shapes" active={ui.showShapes} onClick={() => ui.set({ showShapes: !ui.showShapes })}>
          <Shapes size={14} />
        </IconButton>
        <IconButton label="Frame selection (F)" onClick={() => viewportEvents.dispatchEvent(new Event('frame'))}>
          <Crosshair size={14} />
        </IconButton>
        {mode === '3d' && (
          <IconButton label="Look through the scene camera" active={cameraPreview} onClick={() => setCameraPreview(!cameraPreview)} data-testid="camera-preview">
            <Video size={14} />
          </IconButton>
        )}
        {mode === '2d' && (
          <select className="h-7 rounded border border-border bg-bg px-1 text-[11px] text-muted" value={ui.gridSize} onChange={(e) => ui.set({ gridSize: Number(e.target.value) })} aria-label="Grid size" title="Grid size">
            {[8, 16, 32, 64].map((g) => (
              <option key={g} value={g}>
                {g}px
              </option>
            ))}
          </select>
        )}
        <div className="flex-1" />
        {!compact && (
          <IconButton label="Add node (Ctrl+A)" onClick={() => ui.set({ dialog: 'add-node' })} data-testid="viewport-add-node">
            <Plus size={15} />
          </IconButton>
        )}
      </div>
      <div className="relative min-h-0 flex-1">
        <Suspense fallback={<div className="flex h-full items-center justify-center text-muted">Starting renderer…</div>}>{mode === '2d' ? <Viewport2D scenePath={scenePath} /> : <Viewport3D scenePath={scenePath} cameraPreview={cameraPreview} />}</Suspense>
        {compact && (
          // Contextual toolbar for touch: transform tools and actions for the selection.
          <div className="pointer-events-auto absolute inset-x-2 top-2 z-10 flex justify-center">
            <div className="flex items-center gap-0.5 rounded-lg border border-border bg-panel/95 p-1 shadow-xl backdrop-blur" data-testid="context-toolbar">
              <ToolButtons />
              {hasSelection && (
                <>
                  <div className="mx-0.5 h-5 w-px bg-border" />
                  <IconButton label="Duplicate" onClick={duplicateSelection}>
                    <Copy size={15} />
                  </IconButton>
                  <IconButton label="Delete" onClick={deleteSelection}>
                    <Trash2 size={15} className="text-err" />
                  </IconButton>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
