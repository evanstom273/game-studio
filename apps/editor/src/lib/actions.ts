/** Editor actions used by toolbars, menus, keyboard shortcuts and the compact layout. */
import { useEditor } from '@editor/store/editor';
import { useUi } from '@editor/store/ui';
import { toast } from '@editor/store/toasts';
import { saveNow } from '@editor/services/autosave';
import { requireProject, runScene } from '@editor/services/editor-service';
import { stopGame, togglePause, usePlay } from '@editor/play/player-host';
import { errorMessage } from '@gs/shared';

export function undo() {
  const label = useEditor.getState().undo();
  if (label) toast('info', `Undid: ${label}`);
}
export function redo() {
  const label = useEditor.getState().redo();
  if (label) toast('info', `Redid: ${label}`);
}
export async function save() {
  try {
    await saveNow();
    toast('success', 'Saved');
  } catch {
    /* toast shown by autosave */
  }
}

export async function play(which: 'main' | 'current') {
  try {
    const s = useEditor.getState();
    const scene = which === 'current' && s.active?.kind === 'scene' ? s.active.path : null;
    if (which === 'main' && !requireProject().settings.mainScene) {
      toast('warning', 'No main scene is set — playing the current scene. Set one in Project settings.');
    }
    await runScene(scene);
  } catch (e) {
    if (usePlay.getState().status !== 'stopped') toast('error', errorMessage(e));
  }
}
export const stop = () => stopGame();
export const pause = () => togglePause();

/** Delete the selected nodes of the active scene (not the root). */
export function deleteSelection() {
  const s = useEditor.getState();
  if (s.active?.kind !== 'scene' || !s.selection.length) return;
  const scene = s.project!.scenes[s.active.path];
  const ids = s.selection.filter((id) => id !== scene.root.id);
  if (!ids.length) return;
  try {
    s.dispatch(ids.map((id) => ({ op: 'remove_node' as const, scene: s.active!.path, node: id })), { label: ids.length > 1 ? `Delete ${ids.length} nodes` : 'Delete node' });
    s.select([]);
  } catch (e) {
    toast('error', errorMessage(e));
  }
}

export function duplicateSelection() {
  const s = useEditor.getState();
  if (s.active?.kind !== 'scene' || !s.selection.length) return;
  const scene = s.project!.scenes[s.active.path];
  const ids = s.selection.filter((id) => id !== scene.root.id);
  if (!ids.length) return;
  try {
    const r = s.dispatch(ids.map((id) => ({ op: 'duplicate_node' as const, scene: s.active!.path, node: id })), { label: 'Duplicate' });
    s.select(r.results.map((x) => x.id!).filter(Boolean));
  } catch (e) {
    toast('error', errorMessage(e));
  }
}

export function setTool(tool: 'select' | 'move' | 'rotate' | 'scale') {
  useUi.getState().set({ tool });
}
