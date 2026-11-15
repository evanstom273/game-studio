/**
 * Relay logic shared by the Cloudflare Durable Object and the Vite dev server: tracks the editor
 * socket that owns the link, forwards requests, matches responses, enforces timeouts and payload
 * limits. Transport-agnostic: give it a way to send to and close sockets.
 */
import { GameStudioError } from '../../shared/src/errors.ts';
import { BRIDGE_MAX_PAYLOAD, BRIDGE_PROTOCOL_VERSION, BRIDGE_TIMEOUT_MS, type BridgeMessage, type EditorRequest, type McpMethod } from './protocol.ts';

export interface RelaySocket {
  send(text: string): void;
  close(code: number, reason: string): void;
}

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export const NOT_CONNECTED = 'No Game Studio editor is open on this link right now.';

export class RelayCore {
  private owner: { socket: RelaySocket; session: string } | null = null;
  private pending = new Map<string, Pending>();
  private seq = 0;

  get connected() {
    return this.owner !== null;
  }

  /** After a hibernating relay wakes up: re-adopt the socket that owned the link. */
  restoreOwner(socket: RelaySocket, session: string) {
    this.owner = { socket, session };
  }

  /** The session id of the owning editor, if any (persisted by hibernating relays). */
  get ownerSession() {
    return this.owner?.session ?? null;
  }

  isOwner(socket: RelaySocket) {
    return this.owner?.socket === socket;
  }

  /** Handles a text frame from an editor socket. */
  onMessage(socket: RelaySocket, text: string) {
    if (text.length > BRIDGE_MAX_PAYLOAD) return;
    let msg: BridgeMessage;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.type === 'hello') {
      if (msg.protocol !== BRIDGE_PROTOCOL_VERSION) {
        socket.send(JSON.stringify({ type: 'revoked', message: `Protocol mismatch (editor ${msg.protocol}, relay ${BRIDGE_PROTOCOL_VERSION}). Reload Game Studio.` } satisfies BridgeMessage));
        socket.close(4002, 'protocol mismatch');
        return;
      }
      if (this.owner && this.owner.socket !== socket && this.owner.session !== msg.session && !msg.takeover) {
        socket.send(JSON.stringify({ type: 'busy', message: 'Another Game Studio tab is connected to this link.' } satisfies BridgeMessage));
        return;
      }
      if (this.owner && this.owner.socket !== socket) {
        try {
          this.owner.socket.send(JSON.stringify({ type: 'revoked', message: 'Another Game Studio tab took over the AI connection.' } satisfies BridgeMessage));
          this.owner.socket.close(4001, 'taken over');
        } catch {
          /* already gone */
        }
      }
      this.owner = { socket, session: msg.session };
      socket.send(JSON.stringify({ type: 'welcome', protocol: BRIDGE_PROTOCOL_VERSION } satisfies BridgeMessage));
      return;
    }
    if (msg.type === 'response' && this.owner?.socket === socket) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new GameStudioError(msg.error.code, msg.error.message, msg.error.details));
    }
  }

  onClose(socket: RelaySocket) {
    if (this.owner?.socket !== socket) return;
    this.owner = null;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new GameStudioError('E_NOT_CONNECTED', 'Game Studio disconnected before answering.'));
      this.pending.delete(id);
    }
  }

  /** Sends a tool call to the editor and waits for its answer. */
  request(method: McpMethod | EditorRequest, params: Record<string, unknown> = {}, timeoutMs = BRIDGE_TIMEOUT_MS): Promise<unknown> {
    const owner = this.owner;
    if (!owner) return Promise.reject(new GameStudioError('E_NOT_CONNECTED', NOT_CONNECTED));
    const id = `r${++this.seq}`;
    const text = JSON.stringify({ type: 'request', id, method, params } satisfies BridgeMessage);
    if (text.length > BRIDGE_MAX_PAYLOAD) return Promise.reject(new GameStudioError('E_TOO_LARGE', 'The request is too large (8 MB max).'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new GameStudioError('E_TIMEOUT', `Game Studio didn't answer "${method}" within ${Math.round(timeoutMs / 1000)} s. It may be waiting for the user to confirm something, or the tab is in the background.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        owner.socket.send(text);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new GameStudioError('E_NOT_CONNECTED', `Could not reach Game Studio: ${e instanceof Error ? e.message : String(e)}`));
      }
    });
  }
}
