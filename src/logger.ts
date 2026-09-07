import type { FastifyRequest } from 'fastify';

export interface SafeRequestLog {
  request_id: string;
  route: string;
  status: number;
  duration_ms: number;
  tenant_id?: string;
  user_id?: string;
  job_id?: string;
}

export interface SafeLogger {
  info(event: SafeRequestLog): void;
  warn(event: SafeRequestLog): void;
  error(event: SafeRequestLog): void;
}

function write(level: string, event: SafeRequestLog): void {
  const safe: Record<string, unknown> = {
    level,
    request_id: event.request_id,
    route: event.route,
    status: event.status,
    duration_ms: Math.max(0, Math.round(event.duration_ms)),
  };
  for (const key of ['tenant_id', 'user_id', 'job_id'] as const) {
    const value = event[key];
    if (value !== undefined && /^[0-9a-f-]{36}$/.test(value)) safe[key] = value;
  }
  process.stdout.write(`${JSON.stringify(safe)}\n`);
}

export function createSafeLogger(): SafeLogger {
  return {
    info: (event) => write('info', event),
    warn: (event) => write('warn', event),
    error: (event) => write('error', event),
  };
}

export function safeRequestEvent(request: FastifyRequest, status: number, startedAt: number): SafeRequestLog {
  return {
    request_id: request.requestId,
    route: request.routeOptions.url ?? '<unknown>',
    status,
    duration_ms: performance.now() - startedAt,
  };
}
