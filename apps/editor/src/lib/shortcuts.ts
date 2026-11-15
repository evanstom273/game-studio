/** Keyboard shortcuts (Godot-flavoured where it makes sense). */
import { useEffect } from 'react';
import { useUi } from '@editor/store/ui';
import { deleteSelection, duplicateSelection, play, redo, save, setTool, stop, undo } from './actions';

export const SHORTCUTS: [string, string][] = [
  ['Ctrl/⌘ S', 'Save'],
  ['Ctrl/⌘ Z', 'Undo'],
  ['Ctrl/⌘ Shift Z, Ctrl Y', 'Redo'],
  ['F5', 'Play the main scene'],
  ['F6', 'Play the current scene'],
  ['F8 / Esc while playing', 'Stop'],
  ['Q W E R', 'Select / move / rotate / scale tool'],
  ['Delete', 'Delete selected nodes'],
  ['Ctrl/⌘ D', 'Duplicate selected nodes'],
  ['Ctrl/⌘ A', 'Add a node'],
  ['F', 'Frame the selection in the viewport'],
];

function typing(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable || !!t.closest('.cm-editor'));
}

export function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && k === 's') {
        e.preventDefault();
        void save();
        return;
      }
      if (e.key === 'F5' || e.key === 'F6') {
        e.preventDefault();
        void play(e.key === 'F5' ? 'main' : 'current');
        return;
      }
      if (e.key === 'F8') {
        e.preventDefault();
        stop();
        return;
      }
      if (typing(e) || useUi.getState().dialog) return;
      if (mod && k === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && k === 'y') {
        e.preventDefault();
        redo();
      } else if (mod && k === 'd') {
        e.preventDefault();
        duplicateSelection();
      } else if (mod && k === 'a') {
        e.preventDefault();
        useUi.getState().set({ dialog: 'add-node' });
      } else if (!mod && !e.altKey) {
        if (e.key === 'Delete' || e.key === 'Backspace') deleteSelection();
        else if (k === 'q') setTool('select');
        else if (k === 'w') setTool('move');
        else if (k === 'e') setTool('rotate');
        else if (k === 'r') setTool('scale');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
