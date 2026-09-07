import { createHash } from 'node:crypto';
import type { QueryExecutor } from '../db/transaction.js';
import { appError } from '../errors.js';

export type RateScope = 'login_ip' | 'login_account' | 'service';

export interface RateLimitOptions {
  scope: RateScope;
  subject: string;
  limit: number;
  now?: Date;
  windowMs?: number;
}

export function subjectHash(scope: RateScope, subject: string): Buffer {
  return createHash('sha256').update(`${scope}\0${subject}`, 'utf8').digest();
}

export async function consumeRateLimit(executor: QueryExecutor, options: RateLimitOptions): Promise<{ count: number; retryAfterMs: number }> {
  const now = options.now ?? new Date();
  const windowMs = options.windowMs ?? 15 * 60 * 1000;
  const windowStartMs = Math.floor(now.getTime() / windowMs) * windowMs;
  const windowStart = new Date(windowStartMs);
  const expiresAt = new Date(windowStartMs + windowMs);
  let result;
  try {
    result = await executor.query<{ count: number; expires_at: Date }>(
      `INSERT INTO auth_rate_buckets(scope, subject_hash, window_start, count, expires_at)
       VALUES ($1, $2, $3, 1, $4)
       ON CONFLICT (scope, subject_hash, window_start)
       DO UPDATE SET count = auth_rate_buckets.count + 1
       RETURNING count, expires_at`,
      [options.scope, subjectHash(options.scope, options.subject), windowStart, expiresAt],
    );
  } catch {
    throw appError('UNAVAILABLE');
  }
  const row = result.rows[0];
  if (row === undefined) throw appError('UNAVAILABLE');
  const retryAfterMs = Math.max(0, new Date(row.expires_at).getTime() - now.getTime());
  if (row.count > options.limit) throw appError('RATE_LIMITED', { retryAfterMs });
  return { count: row.count, retryAfterMs };
}
