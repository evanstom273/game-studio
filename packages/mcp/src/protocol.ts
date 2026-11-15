/**
 * Wire protocol between the MCP relay (Cloudflare Durable Object in production, the Vite dev
 * server locally) and the editor tab, over a WebSocket at /bridge/<link key>.
 *
 *   AI app ──HTTPS /mcp/<key>──► relay ──WebSocket /bridge/<key>──► Game Studio tab
 *
 * The relay holds no project data: every tool call becomes a `request` the editor executes with
 * the same command layer as its UI, then answers with a `response`.
 *
 * Session ownership: the first tab that says hello owns the link. Another tab must explicitly
 * take over (`hello.takeover`), and the previous one is told it lost control. Nothing is replaced
 * silently.
 */
export const BRIDGE_PROTOCOL_VERSION = 1;
/** Largest single message either way. */
export const BRIDGE_MAX_PAYLOAD = 8 * 1024 * 1024;
/** Default time an editor gets to answer. */
export const BRIDGE_TIMEOUT_MS = 60_000;
/** Link keys: 32+ random characters, base64url. */
export const LINK_KEY_RE = /^[A-Za-z0-9_-]{32,128}$/;

export const BRIDGE_METHODS = [
  'status',
  'list_projects',
  'create_project',
  'open_project',
  'get_project',
  'save_project',
  'list_node_types',
  'get_node_type',
  'get_scene',
  'create_scene',
  'delete_scene',
  'add_node',
  'update_node',
  'remove_node',
  'reparent_node',
  'duplicate_node',
  'edit_project',
  'read_script',
  'write_script',
  'list_assets',
  'import_asset',
  'create_texture',
  'run_scene',
  'stop_game',
  'get_console',
  'get_diagnostics',
  'export_project',
  'undo',
  'redo',
  // visual scripts (packages/mcp/src/cloud/visual.ts)
  'list_visual_nodes',
  'get_visual_node',
  'get_visual_script',
  'create_visual_script',
  'edit_visual_script',
] as const;

export type BridgeMethod = (typeof BRIDGE_METHODS)[number];

/** What the cloud asks an open editor to do (things only a browser can). */
export type EditorRequest = 'run_scene' | 'stop_game' | 'get_console' | 'export_project' | 'confirm';

/** Notices the cloud sends to open editors. */
export type CloudNoticeMessage = { type: 'project-updated'; id: string; revision: string; label: string; by?: 'editor' } | { type: 'project-deleted'; id: string };

export interface BridgeError {
  code: string;
  message: string;
  details?: unknown;
}

export type BridgeMessage =
  | { type: 'hello'; protocol: number; session: string; takeover?: boolean; app: string }
  | { type: 'welcome'; protocol: number }
  | { type: 'busy'; message: string }
  | { type: 'revoked'; message: string }
  | { type: 'request'; id: string; method: BridgeMethod | EditorRequest; params: Record<string, unknown> }
  | { type: 'response'; id: string; ok: true; result: unknown }
  | { type: 'response'; id: string; ok: false; error: BridgeError };
