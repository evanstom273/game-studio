import { GameStudioError } from './errors';

/**
 * Project paths: forward slashes, relative, no '..', no leading '/', no empty segments.
 * Every path coming from users, archives or MCP goes through `normalizePath`.
 */
export function normalizePath(input: string): string {
  const raw = input.trim().replace(/\\/g, '/').replace(/^res:\/\//, '').replace(/^\/+/, '');
  const parts: string[] = [];
  for (const seg of raw.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') throw new GameStudioError('E_BAD_PATH', `Path "${input}" may not contain ".."`);
    if (/[\u0000-\u001f<>:"|?*]/.test(seg)) throw new GameStudioError('E_BAD_PATH', `Path "${input}" contains characters that are not allowed`);
    parts.push(seg);
  }
  if (!parts.length) throw new GameStudioError('E_BAD_PATH', 'Path is empty');
  const p = parts.join('/');
  if (p.length > 240) throw new GameStudioError('E_BAD_PATH', 'Path is too long (max 240 characters)');
  return p;
}

export function extname(path: string) {
  const base = basename(path);
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i).toLowerCase() : '';
}

export function basename(path: string) {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function dirname(path: string) {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export function stem(path: string) {
  const base = basename(path);
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(0, i) : base;
}

export function joinPath(...parts: string[]) {
  return parts.filter(Boolean).join('/').replace(/\/+/g, '/');
}

/** Resolves a relative import ('./x', '../y/z') against the directory of `from`. Returns null when it leaves the project. */
export function resolveRelative(from: string, spec: string): string | null {
  const parts = dirname(from).split('/').filter(Boolean);
  for (const seg of spec.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}
