export type WireCode = 'INVALID_REQUEST' | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'REQUEST_TOO_LARGE' | 'UNSUPPORTED_MEDIA_TYPE' | 'PROTOCOL_UNSUPPORTED' | 'RATE_LIMITED' | 'INTERNAL' | 'UNAVAILABLE';
const statuses: Record<WireCode, number> = { INVALID_REQUEST: 400, UNAUTHENTICATED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, REQUEST_TOO_LARGE: 413, UNSUPPORTED_MEDIA_TYPE: 415, PROTOCOL_UNSUPPORTED: 426, RATE_LIMITED: 429, INTERNAL: 500, UNAVAILABLE: 503 };
export class ExecutionError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(readonly code: WireCode, readonly retryAfterMs?: number) {
    super(({ INVALID_REQUEST: 'Invalid request.', UNAUTHENTICATED: 'Authentication required.', FORBIDDEN: 'Access forbidden.', NOT_FOUND: 'Not found.', CONFLICT: 'Idempotency content conflicts.', REQUEST_TOO_LARGE: 'Request too large.', UNSUPPORTED_MEDIA_TYPE: 'JSON is required.', PROTOCOL_UNSUPPORTED: 'Protocol is unsupported.', RATE_LIMITED: 'Execution admission limit exceeded.', INTERNAL: 'Internal service error.', UNAVAILABLE: 'Service unavailable.' })[code]);
    this.status = statuses[code];
    this.retryable = this.status >= 429 && this.status !== 426;
  }
}
export class BusinessRejection extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
