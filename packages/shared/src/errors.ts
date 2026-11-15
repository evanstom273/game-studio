/**
 * Errors with a stable machine-readable code. Every layer (commands, storage, MCP) reports
 * these as `{ code, message, details }` so callers (including AI assistants) can react to them.
 */
export class GameStudioError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'GameStudioError';
  }
}

export interface ErrorPayload {
  code: string;
  message: string;
  details?: unknown;
}

export function toErrorPayload(e: unknown): ErrorPayload {
  if (e instanceof Error && typeof (e as { code?: unknown }).code === 'string') {
    const details = (e as { details?: unknown }).details;
    return { code: (e as unknown as { code: string }).code, message: e.message, ...(details !== undefined ? { details } : {}) };
  }
  return { code: 'E_INTERNAL', message: e instanceof Error ? e.message : String(e) };
}

export function errorMessage(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}
