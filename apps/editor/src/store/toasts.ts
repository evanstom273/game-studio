import { create } from 'zustand';

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'warning' | 'error';
  text: string;
  action?: { label: string; run: () => void };
}

let seq = 0;
export const useToasts = create<{ toasts: Toast[] }>()(() => ({ toasts: [] }));

export function toast(kind: Toast['kind'], text: string, action?: Toast['action']) {
  const id = ++seq;
  useToasts.setState((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, text, action }] }));
  setTimeout(() => dismissToast(id), kind === 'error' ? 8000 : 4000);
}

export function dismissToast(id: number) {
  useToasts.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}
