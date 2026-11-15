/** Link keys: the secret that ties an AI app to an editor tab. */
import { LINK_KEY_RE } from './protocol';

/** Durable Object / relay room name for a key: its SHA-256, so the key itself is never stored. */
export async function roomName(key: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The key of an MCP request: from the path (/mcp/<key>, for apps that only take a URL) or from
 * "Authorization: Bearer <key>" (for apps that can send headers, so the key stays out of URLs/logs).
 */
export function keyFromRequest(pathKey: string | undefined, authorization: string | null): string | null {
  const bearer = authorization && /^Bearer\s+(\S+)$/i.exec(authorization)?.[1];
  const key = pathKey || bearer || null;
  return key && LINK_KEY_RE.test(key) ? key : null;
}
