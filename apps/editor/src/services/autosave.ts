/**
 * Autosave: 800 ms after the last change, when the page is hidden or closed, and on Ctrl/⌘+S.
 * Saves are single IndexedDB transactions (see db.ts), so an interrupted save never corrupts the
 * stored project.
 */
import { create } from 'zustand';
import { saveProject } from '@editor/db/projects';
import { storageErrorMessage } from '@editor/db/db';
import { useEditor } from '@editor/store/editor';
import { toast } from '@editor/store/toasts';

export const useSaveStatus = create<{ state: 'saved' | 'pending' | 'saving' | 'error'; error: string | null; at: number }>()(() => ({ state: 'saved', error: null, at: 0 }));

let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<void> | null = null;

export async function saveNow(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  if (inFlight) await inFlight;
  const { project, saved } = useEditor.getState();
  if (!project || project === saved) return;
  useSaveStatus.setState({ state: 'saving' });
  inFlight = (async () => {
    try {
      await saveProject(project);
      useEditor.getState().markSaved(project);
      useSaveStatus.setState({ state: useEditor.getState().project === project ? 'saved' : 'pending', error: null, at: Date.now() });
    } catch (e) {
      const message = storageErrorMessage(e);
      if (useSaveStatus.getState().error !== message) toast('error', message);
      useSaveStatus.setState({ state: 'error', error: message });
      throw e;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export function startAutosave() {
  const unsub = useEditor.subscribe((s, prev) => {
    if (!s.project || s.project === prev.project || s.project === s.saved) return;
    useSaveStatus.setState({ state: 'pending' });
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void saveNow().catch(() => {}), 800);
  });
  const flush = () => void saveNow().catch(() => {});
  const onVisibility = () => document.visibilityState === 'hidden' && flush();
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', flush);
  return () => {
    unsub();
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', flush);
  };
}
