/** Editor UI preferences (persisted per browser): panel sizes, tools, which sheet/drawer is open. */
import { create } from 'zustand';

export type Tool = 'select' | 'move' | 'rotate' | 'scale';
export type BottomTab = 'console' | 'problems' | 'mcp';
/** Compact layout: which bottom sheet is open. */
export type Sheet = 'scene' | 'inspector' | 'files' | 'console' | null;
export type Dialog = 'new-scene' | 'add-node' | 'settings' | 'export' | 'mcp' | 'backups' | 'shortcuts' | 'git' | 'github' | null;

interface UiState {
  leftWidth: number;
  rightWidth: number;
  bottomHeight: number;
  treeRatio: number;
  bottomOpen: boolean;
  bottomTab: BottomTab;
  /** Medium layout: tab shown in the side dock. */
  dockTab: 'scene' | 'inspector' | 'files';
  sheet: Sheet;
  sheetSize: 'peek' | 'half' | 'full';
  dialog: Dialog;
  tool: Tool;
  snap: boolean;
  gridSize: number;
  showShapes: boolean;
  set(patch: Partial<Omit<UiState, 'set'>>): void;
}

const KEY = 'game-studio:ui';
const PERSISTED = ['leftWidth', 'rightWidth', 'bottomHeight', 'treeRatio', 'bottomOpen', 'bottomTab', 'dockTab', 'tool', 'snap', 'gridSize', 'showShapes'] as const;

function load(): Partial<UiState> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}');
  } catch {
    return {};
  }
}

export const useUi = create<UiState>()((set, get) => ({
  leftWidth: 270,
  rightWidth: 310,
  bottomHeight: 190,
  treeRatio: 0.55,
  bottomOpen: true,
  bottomTab: 'console',
  dockTab: 'scene',
  sheet: null,
  sheetSize: 'half',
  dialog: null,
  tool: 'select',
  snap: false,
  gridSize: 16,
  showShapes: true,
  ...load(),
  set(patch) {
    set(patch);
    try {
      const s = get();
      localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(PERSISTED.map((k) => [k, s[k]]))));
    } catch {
      /* storage unavailable */
    }
  },
}));
