export type ErrorCode = 'CLOSED' | 'INVALID_ARGUMENT' | 'STORAGE_ERROR' | 'CONFLICT' | 'TYPE_MISMATCH' | 'NOT_FOUND' | 'SCHEMA_CONFLICT' | 'BUSY' | 'QUERY_ERROR' | 'TIMEOUT' | 'QUEUE_FULL' | 'WORKER_ERROR';
export class FacetError extends Error {
  constructor(readonly code: ErrorCode, message: string, cause?: unknown) {
    super(message, { cause }); this.name = 'FacetError';
  }
}
export function asFacetError(error: unknown, fallback: ErrorCode = 'STORAGE_ERROR'): FacetError {
  if (error instanceof FacetError) return error;
  const e = error as { message?: string; errcode?: number };
  const primary = e?.errcode === undefined ? undefined : e.errcode & 255;
  const code = primary === 19 ? 'CONFLICT' : primary === 5 || primary === 6 ? 'BUSY' : primary !== undefined && fallback === 'INVALID_ARGUMENT' ? 'STORAGE_ERROR' : fallback;
  return new FacetError(code, e?.message ?? String(error), error);
}
