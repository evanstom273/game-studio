/**
 * The editor's side of the AI connection (MCP).
 *
 * Off by default. When on, the tab opens wss://<this site>/bridge/<key> and answers tool calls
 * relayed from /mcp/<key> (Cloudflare Durable Object in production, the dev server locally).
 * The key is a random secret kept in this browser; the MCP link contains it, so whoever has the
 * link can use the connection while it is on — "New link" revokes the old one.
 *
 * The user also decides what a connection may do (permissions below); handlers check them.
 */
import { create } from 'zustand';
import { newSecret, toErrorPayload } from '@gs/shared';
import { BRIDGE_MAX_PAYLOAD, BRIDGE_PROTOCOL_VERSION, type BridgeMessage, type BridgeMethod } from '@gs/mcp';
import { handleBridgeRequest } from './handlers';

export type BridgeStatus = 'off' | 'connecting' | 'connected' | 'busy' | 'revoked' | 'offline';

export interface BridgePermissions {
  /** Which projects the AI may see and change. */
  scope: 'open-project' | 'all-projects';
  /** read: inspect only · edit: change projects · full: also run games and export */
  level: 'read' | 'edit' | 'full';
  /** Ask in the editor before deleting projects or scenes. */
  confirmDestructive: boolean;
}

export interface BridgeLogEntry {
  at: number;
  method: string;
  ok: boolean;
  ms: number;
  summary: string;
}

interface BridgeState {
  enabled: boolean;
  key: string;
  status: BridgeStatus;
  statusText: string;
  permissions: BridgePermissions;
  log: BridgeLogEntry[];
  setEnabled(on: boolean): void;
  newKey(): void;
  setPermissions(p: Partial<BridgePermissions>): void;
  takeOver(): void;
  clearLog(): void;
}

const STORE_KEY = 'game-studio:ai-connection';
const sessionId = newSecret(12);

function load(): Partial<Pick<BridgeState, 'enabled' | 'key' | 'permissions'>> {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}');
  } catch {
    return {};
  }
}
const saved = load();

function persist() {
  const s = useBridge.getState();
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ enabled: s.enabled, key: s.key, permissions: s.permissions }));
  } catch {
    /* storage unavailable */
  }
}

export const useBridge = create<BridgeState>()((set, get) => ({
  enabled: saved.enabled ?? false,
  key: saved.key && saved.key.length >= 32 ? saved.key : newSecret(32),
  status: 'off',
  statusText: 'Off',
  permissions: { scope: 'all-projects', level: 'full', confirmDestructive: true, ...saved.permissions },
  log: [],
  setEnabled(on) {
    set({ enabled: on });
    persist();
    if (on) connect();
    else disconnect('off', 'Off');
  },
  newKey() {
    set({ key: newSecret(32) });
    persist();
    if (get().enabled) {
      disconnect('connecting', 'Reconnecting with the new link…');
      connect();
    }
  },
  setPermissions(p) {
    set({ permissions: { ...get().permissions, ...p } });
    persist();
  },
  takeOver() {
    connect(true);
  },
  clearLog() {
    set({ log: [] });
  },
}));

/** The MCP endpoint for this site and key. */
export function mcpUrl(key = useBridge.getState().key) {
  return `${location.origin}/mcp/${key}`;
}

let ws: WebSocket | null = null;
let retry = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let ping: ReturnType<typeof setInterval> | null = null;
let queue: Promise<void> = Promise.resolve();

function disconnect(status: BridgeStatus, text: string) {
  if (retryTimer) clearTimeout(retryTimer);
  if (ping) clearInterval(ping);
  retryTimer = null;
  ping = null;
  const old = ws;
  ws = null;
  old?.close(1000, 'off');
  useBridge.setState({ status, statusText: text });
}

function connect(takeover = false) {
  disconnect('connecting', 'Connecting…');
  const { key } = useBridge.getState();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const sock = new WebSocket(`${proto}://${location.host}/bridge/${key}`);
  ws = sock;
  sock.onopen = () => {
    sock.send(JSON.stringify({ type: 'hello', protocol: BRIDGE_PROTOCOL_VERSION, session: sessionId, takeover, app: 'game-studio' } satisfies BridgeMessage));
    ping = setInterval(() => sock.readyState === WebSocket.OPEN && sock.send('ping'), 25_000);
  };
  sock.onmessage = (e) => {
    if (typeof e.data !== 'string' || e.data === 'pong') return;
    let msg: BridgeMessage;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg.type === 'welcome') {
      retry = 0;
      useBridge.setState({ status: 'connected', statusText: 'Connected — waiting for an AI app' });
    } else if (msg.type === 'busy') useBridge.setState({ status: 'busy', statusText: msg.message });
    else if (msg.type === 'revoked') {
      useBridge.setState({ status: 'revoked', statusText: msg.message });
      ws = null;
    } else if (msg.type === 'request') {
      // One request at a time, in order, like edits from the UI.
      queue = queue.then(() => answer(sock, msg.id, msg.method, msg.params));
    }
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    if (ping) clearInterval(ping);
    if (!useBridge.getState().enabled) return;
    const delay = Math.min(30_000, 1000 * 2 ** retry++);
    useBridge.setState({ status: 'offline', statusText: `Can't reach the relay — retrying in ${Math.round(delay / 1000)} s` });
    retryTimer = setTimeout(() => connect(), delay);
  };
}

async function answer(sock: WebSocket, id: string, method: BridgeMethod, params: Record<string, unknown>) {
  const t0 = performance.now();
  let reply: BridgeMessage;
  try {
    const result = await handleBridgeRequest(method, params ?? {});
    reply = { type: 'response', id, ok: true, result };
  } catch (e) {
    reply = { type: 'response', id, ok: false, error: toErrorPayload(e) };
  }
  let text = JSON.stringify(reply);
  if (text.length > BRIDGE_MAX_PAYLOAD) text = JSON.stringify({ type: 'response', id, ok: false, error: { code: 'E_TOO_LARGE', message: 'The answer is too large; ask for less (e.g. one scene at a time).' } } satisfies BridgeMessage);
  if (sock.readyState === WebSocket.OPEN) sock.send(text);
  const entry: BridgeLogEntry = { at: Date.now(), method, ok: reply.ok, ms: Math.round(performance.now() - t0), summary: reply.ok ? '' : (reply as { error: { message: string } }).error.message };
  useBridge.setState((s) => ({ log: [...s.log.slice(-199), entry], status: 'connected', statusText: 'Connected' }));
}

/** Starts the connection if it was left on (call once at startup). */
export function initBridge() {
  if (useBridge.getState().enabled) connect();
}
