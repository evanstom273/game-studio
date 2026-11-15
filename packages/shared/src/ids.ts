/** Random URL-safe ids. Uses crypto.getRandomValues (available in browsers, Workers and Node 19+). */
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function randomString(length: number, alphabet = ALPHABET) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s;
}

/** Ids for nodes, projects and the like: 12 characters (~71 bits). */
export function newId(prefix = '') {
  return prefix + randomString(12);
}

/** Long secrets (MCP connector links): 32 bytes, base64url. */
export function newSecret(bytes = 32) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
