export type ErrorCode =
  | 'AUTH_REQUIRED'
  | 'ADMIN_REQUIRED'
  | 'GROUP_NOT_ALLOWED'
  | 'CSRF_REJECTED'
  | 'ORIGIN_REJECTED'
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'STALE_VERSION'
  | 'LAST_ADMIN'
  | 'VALIDATION_FAILED'
  | 'RATE_LIMITED'
  | 'ACTIVE_RESERVATIONS'
  | 'UNAVAILABLE'
  | 'INTERNAL';

const DEFAULT_STATUS: Record<ErrorCode, number> = {
  AUTH_REQUIRED: 401,
  ADMIN_REQUIRED: 403,
  GROUP_NOT_ALLOWED: 403,
  CSRF_REJECTED: 403,
  ORIGIN_REJECTED: 403,
  NOT_FOUND: 404,
  ALREADY_EXISTS: 409,
  STALE_VERSION: 409,
  LAST_ADMIN: 409,
  VALIDATION_FAILED: 422,
  RATE_LIMITED: 429,
  ACTIVE_RESERVATIONS: 409,
  UNAVAILABLE: 503,
  INTERNAL: 500,
};

const SAFE_MESSAGES: Record<ErrorCode, string> = {
  AUTH_REQUIRED: 'Authentication required.',
  ADMIN_REQUIRED: 'Administrator access required.',
  GROUP_NOT_ALLOWED: 'Group access is not allowed.',
  CSRF_REJECTED: 'CSRF validation failed.',
  ORIGIN_REJECTED: 'Origin validation failed.',
  NOT_FOUND: 'Not found.',
  ALREADY_EXISTS: 'Resource already exists.',
  STALE_VERSION: 'Resource was modified; reload and retry.',
  LAST_ADMIN: 'The tenant must retain an active administrator.',
  VALIDATION_FAILED: 'Request validation failed.',
  RATE_LIMITED: 'Too many requests.',
  ACTIVE_RESERVATIONS: 'The resource has active reservations.',
  UNAVAILABLE: 'Service unavailable.',
  INTERNAL: 'Internal server error.',
};

export interface ErrorField {
  path: string;
  code: string;
}

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly fields?: readonly ErrorField[];
  readonly retryAfterMs?: number;

  constructor(code: ErrorCode, options: { fields?: readonly ErrorField[]; retryAfterMs?: number; message?: string } = {}) {
    super(options.message ?? SAFE_MESSAGES[code]);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = DEFAULT_STATUS[code];
    this.fields = options.fields;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export function appError(code: ErrorCode, options: { fields?: readonly ErrorField[]; retryAfterMs?: number; message?: string } = {}): AppError {
  return new AppError(code, options);
}

export function safeError(error: unknown): AppError {
  return error instanceof AppError ? error : new AppError('INTERNAL');
}

export function errorBody(error: AppError, requestId: string): { error: { code: ErrorCode; message: string; fields?: readonly ErrorField[]; retry_after_ms?: number }; request_id: string } {
  const body: { error: { code: ErrorCode; message: string; fields?: readonly ErrorField[]; retry_after_ms?: number }; request_id: string } = {
    error: { code: error.code, message: SAFE_MESSAGES[error.code] },
    request_id: requestId,
  };
  if (error.fields !== undefined) body.error.fields = error.fields;
  if (error.retryAfterMs !== undefined) body.error.retry_after_ms = Math.max(0, Math.ceil(error.retryAfterMs));
  return body;
}

export function sendError(reply: { code(statusCode: number): { send(body: unknown): unknown }; header?: (name: string, value: string) => unknown }, error: unknown, requestId: string): unknown {
  const normalized = safeError(error);
  if (normalized.retryAfterMs !== undefined) reply.header?.('Retry-After', String(Math.ceil(normalized.retryAfterMs / 1000)));
  return reply.code(normalized.statusCode).send(errorBody(normalized, requestId));
}

export function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === '23505';
}

export function isForeignKeyViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === '23503';
}
