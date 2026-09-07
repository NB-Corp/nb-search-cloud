import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticateSession, withSessionTransaction } from '../auth/session.js';
import { canUserBindGroupById } from '../auth/policy.js';
import { queryOne } from '../db/transaction.js';
import { appError } from '../errors.js';
import { contextOf, parseBody, safeJsonInteger, sendData, sendRequestError, type Principal } from '../request-context.js';
import type { ExecutionStore } from '../execution/store.js';
import { ExecutionError } from '../execution/errors.js';
import { cancelView, jobView } from '../execution/projections.js';
import type { Kind } from '../execution/types.js';
import { readSession } from './admin-execution.js';

const uuid = z.string().uuid();
const usageQuery = z.object({ user_id: uuid.optional(), group_id: uuid.optional(), key_id: uuid.optional(), job_id: uuid.optional(), from: z.string().datetime().optional(), to: z.string().datetime().optional(), limit: z.coerce.number().int().min(1).max(100).default(25), cursor: z.string().max(2048).optional() }).strict();
function parsed<T>(schema: z.ZodType<T>, input: unknown): T { const result = schema.safeParse(input); if (!result.success) throw appError('VALIDATION_FAILED'); return result.data; }
function normalized(error: unknown): unknown { return error instanceof ExecutionError ? appError(error.code === 'UNAUTHENTICATED' ? 'AUTH_REQUIRED' : error.code === 'NOT_FOUND' || error.code === 'FORBIDDEN' ? 'NOT_FOUND' : error.code === 'INVALID_REQUEST' ? 'VALIDATION_FAILED' : 'INTERNAL') : error; }
function sessionPrincipal(p: Principal) { if (!p.sessionId) throw appError('AUTH_REQUIRED'); return { tenantId: p.tenantId, userId: p.userId, sessionId: p.sessionId, sessionAuthenticated: true as const }; }

export function registerAdminUsageRoutes(app: FastifyInstance, store: ExecutionStore): void {
  for (const route of ['/api/admin/me/quotas', '/api/admin/users/:id/quotas']) app.get(route, async (request, reply) => {
    try {
      const forOther = route.includes(':id');
      return sendData(reply, await readSession(request, forOther, async (tx, p) => {
        const userId = forOther ? parsed(z.object({ id: uuid }), request.params).id : p.userId;
        if (!await queryOne(tx, 'SELECT id FROM users WHERE tenant_id=$1 AND id=$2', [p.tenantId, userId])) throw appError('NOT_FOUND');
        const groups = await tx.query<{ id: string; daily_units_per_user: string; used_units: string; reserved_units: string; utc_day: string; reset_at: Date }>(`SELECT g.id,g.daily_units_per_user,coalesce(b.used_units,0)::text AS used_units,coalesce(b.reserved_units,0)::text AS reserved_units,
          to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD') AS utc_day,((date_trunc('day',now() AT TIME ZONE 'UTC')+interval '1 day') AT TIME ZONE 'UTC') AS reset_at
          FROM groups g LEFT JOIN group_usage_buckets b ON b.tenant_id=g.tenant_id AND b.group_id=g.id AND b.user_id=$2 AND b.utc_day=(now() AT TIME ZONE 'UTC')::date WHERE g.tenant_id=$1 AND g.deleted_at IS NULL ORDER BY g.name,g.id`, [p.tenantId, userId]);
        const items = [];
        for (const row of groups.rows) {
          if (!await canUserBindGroupById(tx, p.tenantId, userId, row.id)) continue;
          const limit = safeJsonInteger(row.daily_units_per_user), used = safeJsonInteger(row.used_units), reserved = safeJsonInteger(row.reserved_units);
          items.push({ group_id: row.id, daily_units_per_user: limit, utc_day: row.utc_day, used_units: used, reserved_units: reserved, remaining_units: limit === 0 ? null : Math.max(0, limit - used - reserved), reset_at: row.reset_at.toISOString(), unit: 'execution_unit' });
        }
        return { items };
      }));
    } catch (error) { return sendRequestError(reply, error); }
  });
  app.get('/api/admin/keys/:id/usage', async (request, reply) => {
    try {
      const { id } = parsed(z.object({ id: uuid }), request.params);
      return sendData(reply, await readSession(request, false, async (tx, p) => {
        const row = await queryOne<{ user_id: string; quota_units: string; quota_epoch: number; used_units: string; reserved_units: string }>(tx, 'SELECT k.user_id,k.quota_units,k.quota_epoch,coalesce(b.used_units,0)::text AS used_units,coalesce(b.reserved_units,0)::text AS reserved_units FROM api_keys k LEFT JOIN key_usage_buckets b ON b.tenant_id=k.tenant_id AND b.key_id=k.id AND b.epoch=k.quota_epoch WHERE k.tenant_id=$1 AND k.id=$2', [p.tenantId, id]);
        if (!row || p.role !== 'admin' && row.user_id !== p.userId) throw appError('NOT_FOUND');
        const quota = safeJsonInteger(row.quota_units), used = safeJsonInteger(row.used_units), reserved = safeJsonInteger(row.reserved_units);
        return { id, epoch: row.quota_epoch, quota_units: quota, used_units: used, reserved_units: reserved, remaining_units: quota === 0 ? null : Math.max(0, quota - used - reserved), unit: 'execution_unit' };
      }));
    } catch (error) { return sendRequestError(reply, error); }
  });
  app.get('/api/admin/usage', async (request, reply) => {
    try {
      const input = parsed(usageQuery, request.query);
      const to = input.to ? new Date(input.to) : new Date();
      const from = input.from ? new Date(input.from) : new Date(to.getTime() - 31 * 86_400_000);
      if (to.getTime() < from.getTime() || to.getTime() - from.getTime() > 31 * 86_400_000) throw appError('VALIDATION_FAILED');
      let cursor: [string, string] | undefined;
      if (input.cursor) {
        try { cursor = parsed(z.tuple([z.string().datetime(), uuid]), JSON.parse(Buffer.from(input.cursor, 'base64url').toString())); } catch { throw appError('VALIDATION_FAILED'); }
      }
      return sendData(reply, await readSession(request, false, async (tx, p) => {
        if (p.role !== 'admin' && input.user_id && input.user_id !== p.userId) throw appError('NOT_FOUND');
        const userId = p.role === 'admin' ? input.user_id ?? null : p.userId;
        const values = [p.tenantId, userId, input.group_id ?? null, input.key_id ?? null, input.job_id ?? null, from, to];
        const filter = 'j.tenant_id=$1 AND ($2::uuid IS NULL OR j.user_id=$2) AND ($3::uuid IS NULL OR j.group_id=$3) AND ($4::uuid IS NULL OR j.admitting_key_id=$4) AND ($5::uuid IS NULL OR j.id=$5) AND j.created_at>=$6 AND j.created_at<=$7';
        const totals = await queryOne<{ reserved: string; charged: string; released: string }>(tx, `SELECT coalesce(sum(r.units) FILTER(WHERE r.state='reserved'),0)::text AS reserved,coalesce(sum(r.units) FILTER(WHERE r.state='settled'),0)::text AS charged,coalesce(sum(r.units) FILTER(WHERE r.state='released'),0)::text AS released FROM jobs j JOIN usage_reservations r ON r.job_id=j.id WHERE ${filter}`, values);
        const rows = await tx.query<{ id: string; user_id: string; request_id: string; kind: string; delivery: string; state: string; group_id: string; admitting_key_id: string; selection: Record<string, unknown>; created_at: Date; completed_at: Date | null; reservation_state: string; units: string; reason: string }>(`SELECT j.id,j.user_id,j.request_id,j.kind,j.delivery,j.state,j.group_id,j.admitting_key_id,j.selection,j.created_at,j.completed_at,r.state AS reservation_state,r.units,r.reason FROM jobs j JOIN usage_reservations r ON r.job_id=j.id WHERE ${filter} AND ($8::timestamptz IS NULL OR (j.created_at,j.id)<($8::timestamptz,$9::uuid)) ORDER BY j.created_at DESC,j.id DESC LIMIT $10`, [...values, cursor?.[0] ?? null, cursor?.[1] ?? null, input.limit + 1]);
        const shown = rows.rows.slice(0, input.limit); const last = shown.at(-1);
        return { items: shown.map((row) => ({ job_id: row.id, user_id: row.user_id, request_id: row.request_id, kind: row.kind, delivery: row.delivery, state: row.state, group_id: row.group_id, key_id: row.admitting_key_id,
          selection: row.selection, reserved_units: row.reservation_state === 'reserved' ? safeJsonInteger(row.units) : 0, charged_units: row.reservation_state === 'settled' ? safeJsonInteger(row.units) : 0, released_units: row.reservation_state === 'released' ? safeJsonInteger(row.units) : 0,
          settlement_reason: row.reason, created_at: row.created_at.toISOString(), completed_at: row.completed_at?.toISOString() ?? null })), totals: { reserved: safeJsonInteger(totals!.reserved), charged: safeJsonInteger(totals!.charged), released: safeJsonInteger(totals!.released) },
          ...(rows.rows.length > input.limit && last ? { next_cursor: Buffer.from(JSON.stringify([last.created_at.toISOString(), last.id])).toString('base64url') } : {}) };
      }));
    } catch (error) { return sendRequestError(reply, error); }
  });
  app.get('/api/admin/jobs/:id', async (request, reply) => {
    try {
      const { id } = parsed(z.object({ id: uuid }), request.params); const context = contextOf(request);
      const p = await authenticateSession(request, context.db, context.env);
      const meta = await queryOne<{ user_id: string; kind: Kind; state: string; created_at: Date; completed_at: Date | null }>(context.db.pool, 'SELECT user_id,kind,state,created_at,completed_at FROM jobs WHERE tenant_id=$1 AND id=$2 AND (expires_at IS NULL OR expires_at>now())', [p.tenantId, id]);
      if (!meta || meta.user_id !== p.userId && p.role !== 'admin') throw appError('NOT_FOUND');
      if (meta.user_id !== p.userId) return sendData(reply, { job_id: id, ...meta, content_access: false });
      const job = await store.get(sessionPrincipal(p), meta.kind, id);
      return sendData(reply, { ...await jobView(context.db.pool, job), content_access: true });
    } catch (error) { return sendRequestError(reply, normalized(error)); }
  });
  for (const action of ['read', 'cancel'] as const) app.post(`/api/admin/jobs/:id/${action}`, async (request, reply) => {
    try {
      const { id } = parsed(z.object({ id: uuid }), request.params);
      const input = action === 'read' ? parseBody(z.object({ cursor: z.string().max(2048).optional(), page_size: z.number().int().min(1).max(100).optional() }).strict(), request) : parseBody(z.object({}).strict().optional(), request);
      const context = contextOf(request);
      // Release the authentication transaction before entering the store's tenant transaction.
      const p = await withSessionTransaction(request, context, async (_tx, principal) => principal);
      const row = await queryOne<{ kind: Kind }>(context.db.pool, 'SELECT kind FROM jobs WHERE tenant_id=$1 AND id=$2 AND user_id=$3', [p.tenantId, id, p.userId]);
      if (!row) throw appError('NOT_FOUND');
      if (action === 'cancel') return sendData(reply, cancelView(await store.cancel(sessionPrincipal(p), row.kind, id)));
      const read = input as { cursor?: string; page_size?: number };
      return sendData(reply, await store.read(sessionPrincipal(p), row.kind, id, read.cursor, read.page_size));
    } catch (error) { return sendRequestError(reply, normalized(error)); }
  });
}
