import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticateSession } from '../auth/session.js';
import { queryRows } from '../db/transaction.js';
import { appError } from '../errors.js';
import { contextOf, parseBody, requireExactOrigin, sendData, sendRequestError, type Principal } from '../request-context.js';

const cursorSchema = z.string().max(2048);

interface AuditRow {
  id: string;
  tenant_id: string;
  actor_user_id: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  request_id: string;
  created_at: Date;
  metadata: Record<string, unknown>;
}

function assertQueryKeys(query: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(query).some((key) => !allowed.includes(key))) throw appError('VALIDATION_FAILED');
}

async function requireAdmin(request: FastifyRequest): Promise<Principal> {
  const context = contextOf(request);
  requireExactOrigin(request, context.env, false);
  const principal = await authenticateSession(request, context.db, context.env);
  if (principal.role !== 'admin') throw appError('ADMIN_REQUIRED');
  return principal;
}

export async function listAudit(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const context = contextOf(request);
  try {
    const principal = await requireAdmin(request);
    const query = request.query as Record<string, unknown>;
    assertQueryKeys(query, ['limit', 'cursor']);
    const limit = typeof query['limit'] === 'string' ? Number(query['limit']) : 25;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw appError('VALIDATION_FAILED');
    const params: unknown[] = [principal.tenantId];
    let where = 'tenant_id=$1';
    if (typeof query['cursor'] === 'string') {
      const cursor = decodeCursor(parseBody(cursorSchema, { body: query['cursor'] } as FastifyRequest));
      params.push(cursor.createdAt, cursor.id);
      where += ` AND (created_at,id) < ($${params.length - 1},$${params.length})`;
    }
    params.push(limit + 1);
    const rows = await queryRows<AuditRow>(context.db.pool, `SELECT id,tenant_id,actor_user_id,action,target_type,target_id,request_id,created_at,metadata FROM audit_events WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT $${params.length}`, params);
    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map((row) => ({
      id: row.id,
      actor_user_id: row.actor_user_id,
      action: row.action,
      target_type: row.target_type,
      target_id: row.target_id,
      request_id: row.request_id,
      created_at: row.created_at.toISOString(),
      metadata: row.metadata,
    }));
    const last = rows[limit - 1];
    return sendData(reply, { items, next_cursor: hasMore && last !== undefined ? encodeCursor(last) : null });
  } catch (error) {
    return sendRequestError(reply, error);
  }
}

function decodeCursor(value: string): { createdAt: Date; id: string } {
  try {
    const raw = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { v?: number; created_at?: string; id?: string };
    if (raw.v !== 1 || typeof raw.created_at !== 'string' || typeof raw.id !== 'string' || !z.string().uuid().safeParse(raw.id).success) throw new Error('invalid');
    const createdAt = new Date(raw.created_at);
    if (Number.isNaN(createdAt.getTime())) throw new Error('invalid');
    return { createdAt, id: raw.id };
  } catch {
    throw appError('VALIDATION_FAILED');
  }
}

function encodeCursor(row: AuditRow): string {
  return Buffer.from(JSON.stringify({ v: 1, created_at: row.created_at.toISOString(), id: row.id }), 'utf8').toString('base64url');
}

export function registerAdminAuditRoutes(app: FastifyInstance): void {
  app.get('/api/admin/audit', listAudit);
}
