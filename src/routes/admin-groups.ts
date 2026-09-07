import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticateSession, withAdminTransaction } from '../auth/session.js';
import { queryOne, queryRows } from '../db/transaction.js';
import { appError, isForeignKeyViolation, isUniqueViolation } from '../errors.js';
import { contextOf, parseBody, requireExactOrigin, requireJson, requestId, safeJsonInteger, sendData, sendRequestError, type GroupRow, type Principal } from '../request-context.js';

const uuid = z.string().uuid();
const createSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(1000).optional(),
  is_exclusive: z.boolean().optional(),
  daily_units_per_user: z.number().int().min(0).max(1_000_000_000).optional(),
}).strict();
const patchSchema = z.object({
  expected_revision: z.number().int().positive(),
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(1000).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  is_exclusive: z.boolean().optional(),
  daily_units_per_user: z.number().int().min(0).max(1_000_000_000).optional(),
}).strict().refine((value) => Object.keys(value).length > 1, { message: 'empty patch' });
const idSchema = z.object({ id: uuid });

function groupDto(row: GroupRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    is_exclusive: row.is_exclusive,
    daily_units_per_user: safeJsonInteger(row.daily_units_per_user),
    revision: safeJsonInteger(row.revision),
    deleted_at: row.deleted_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

async function adminRead(request: FastifyRequest): Promise<Principal> {
  const context = contextOf(request);
  requireExactOrigin(request, context.env, false);
  const principal = await authenticateSession(request, context.db, context.env);
  if (principal.role !== 'admin') throw appError('ADMIN_REQUIRED');
  return principal;
}

async function listGroups(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const context = contextOf(request);
  try {
    const principal = await adminRead(request);
    const query = request.query as Record<string, unknown>;
    assertQueryKeys(query, ['limit', 'cursor']);
    const limit = typeof query['limit'] === 'string' ? Number(query['limit']) : 25;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw appError('VALIDATION_FAILED', { fields: [{ path: 'limit', code: 'RANGE' }] });
    const cursor = typeof query['cursor'] === 'string' ? decodeGroupCursor(query['cursor']) : undefined;
    const params: unknown[] = [principal.tenantId];
    let where = 'tenant_id=$1';
    if (cursor !== undefined) {
      params.push(cursor.createdAt, cursor.id);
      where += ` AND (created_at,id) < ($${params.length - 1},$${params.length})`;
    }
    params.push(limit + 1);
    const rows = await queryRows<GroupRow>(context.db.pool, `SELECT id,tenant_id,name,description,status,is_exclusive,daily_units_per_user,revision,deleted_at,created_at,updated_at FROM groups WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT $${params.length}`, params);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return sendData(reply, { items: page.map(groupDto), next_cursor: hasMore && page.at(-1) !== undefined ? encodeGroupCursor(page.at(-1)!) : null });
  } catch (error) {
    return sendRequestError(reply, error);
  }
}

function decodeGroupCursor(value: string): { createdAt: Date; id: string } {
  if (value.length > 2048) throw appError('VALIDATION_FAILED');
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { v?: number; created_at?: string; id?: string };
    if (decoded.v !== 1 || typeof decoded.created_at !== 'string' || typeof decoded.id !== 'string' || !uuid.safeParse(decoded.id).success) throw new Error('invalid');
    const createdAt = new Date(decoded.created_at);
    if (Number.isNaN(createdAt.getTime())) throw new Error('invalid');
    return { createdAt, id: decoded.id };
  } catch {
    throw appError('VALIDATION_FAILED');
  }
}

function encodeGroupCursor(row: GroupRow): string {
  return Buffer.from(JSON.stringify({ v: 1, created_at: row.created_at.toISOString(), id: row.id }), 'utf8').toString('base64url');
}

function assertQueryKeys(query: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(query).some((key) => !allowed.includes(key))) throw appError('VALIDATION_FAILED');
}

async function availableGroups(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const context = contextOf(request);
  try {
    requireExactOrigin(request, context.env, false);
    const principal = await authenticateSession(request, context.db, context.env);
    const rows = await queryRows<GroupRow>(context.db.pool, `
      SELECT g.id,g.tenant_id,g.name,g.description,g.status,g.is_exclusive,g.daily_units_per_user,g.revision,g.deleted_at,g.created_at,g.updated_at
        FROM groups g JOIN users u ON u.tenant_id=g.tenant_id AND u.id=$2
       WHERE g.tenant_id=$1 AND g.status='active' AND g.deleted_at IS NULL
         AND ((g.is_exclusive=true OR u.restrict_public_groups=true) AND EXISTS (SELECT 1 FROM user_allowed_groups m WHERE m.tenant_id=$1 AND m.user_id=$2 AND m.group_id=g.id)
              OR (g.is_exclusive=false AND u.restrict_public_groups=false))
       ORDER BY g.created_at DESC,g.id DESC`, [principal.tenantId, principal.userId]);
    return sendData(reply, rows.map(groupDto));
  } catch (error) {
    return sendRequestError(reply, error);
  }
}

async function createGroup(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const context = contextOf(request);
  try {
    requireJson(request);
    requireExactOrigin(request, context.env);
    const input = parseBody(createSchema, request);
    const id = randomUUID();
    const row = await withAdminTransaction(request, context, async (client, principal) => {
      const inserted = await queryOne<GroupRow>(client, `INSERT INTO groups(id,tenant_id,name,description,status,is_exclusive,daily_units_per_user) VALUES($1,$2,$3,$4,'active',$5,$6) RETURNING id,tenant_id,name,description,status,is_exclusive,daily_units_per_user,revision,deleted_at,created_at,updated_at`, [id, principal.tenantId, input.name, input.description ?? '', input.is_exclusive ?? false, input.daily_units_per_user ?? 0]);
      if (inserted === undefined) throw appError('INTERNAL');
      await audit(client, principal, 'group.create', 'group', id, requestId(request), { is_exclusive: input.is_exclusive ?? false });
      return inserted;
    });
    return sendData(reply, groupDto(row), 201);
  } catch (error) {
    return sendRequestError(reply, mapDbError(error));
  }
}

async function getGroup(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const context = contextOf(request);
  try {
    const principal = await adminRead(request);
    const { id } = parseBody(idSchema, { body: request.params } as FastifyRequest);
    const row = await queryOne<GroupRow>(context.db.pool, 'SELECT id,tenant_id,name,description,status,is_exclusive,daily_units_per_user,revision,deleted_at,created_at,updated_at FROM groups WHERE tenant_id=$1 AND id=$2', [principal.tenantId, id]);
    if (row === undefined) throw appError('NOT_FOUND');
    return sendData(reply, groupDto(row));
  } catch (error) {
    return sendRequestError(reply, error);
  }
}

async function patchGroup(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const context = contextOf(request);
  try {
    requireJson(request);
    requireExactOrigin(request, context.env);
    const { id } = parseBody(idSchema, { body: request.params } as FastifyRequest);
    const input = parseBody(patchSchema, request);
    const row = await withAdminTransaction(request, context, async (client, principal) => {
      const current = await queryOne<GroupRow>(client, 'SELECT id,tenant_id,name,description,status,is_exclusive,daily_units_per_user,revision,deleted_at,created_at,updated_at FROM groups WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [principal.tenantId, id]);
      if (current === undefined || current.deleted_at !== null) throw appError('NOT_FOUND');
      if (Number(current.revision) !== input.expected_revision) throw appError('STALE_VERSION');
      const updated = await queryOne<GroupRow>(client, `UPDATE groups SET name=COALESCE($3,name),description=COALESCE($4,description),status=COALESCE($5,status),is_exclusive=COALESCE($6,is_exclusive),daily_units_per_user=COALESCE($7,daily_units_per_user),revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND revision=$8 RETURNING id,tenant_id,name,description,status,is_exclusive,daily_units_per_user,revision,deleted_at,created_at,updated_at`, [principal.tenantId, id, input.name ?? null, input.description ?? null, input.status ?? null, input.is_exclusive ?? null, input.daily_units_per_user ?? null, input.expected_revision]);
      if (updated === undefined) throw appError('STALE_VERSION');
      await audit(client, principal, 'group.update', 'group', id, requestId(request), { fields: Object.keys(input).filter((key) => key !== 'expected_revision') });
      return updated;
    });
    return sendData(reply, groupDto(row));
  } catch (error) {
    return sendRequestError(reply, mapDbError(error));
  }
}

async function deleteGroup(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const context = contextOf(request);
  try {
    requireExactOrigin(request, context.env);
    const { id } = parseBody(idSchema, { body: request.params } as FastifyRequest);
    const row = await withAdminTransaction(request, context, async (client, principal) => {
      const current = await queryOne<GroupRow>(client, 'SELECT id,tenant_id,name,description,status,is_exclusive,daily_units_per_user,revision,deleted_at,created_at,updated_at FROM groups WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [principal.tenantId, id]);
      if (current === undefined || current.deleted_at !== null) throw appError('NOT_FOUND');
      const deleted = await queryOne<GroupRow>(client, `UPDATE groups SET status='disabled',deleted_at=now(),revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND deleted_at IS NULL RETURNING id,tenant_id,name,description,status,is_exclusive,daily_units_per_user,revision,deleted_at,created_at,updated_at`, [principal.tenantId, id]);
      if (deleted === undefined) throw appError('NOT_FOUND');
      await audit(client, principal, 'group.delete', 'group', id, requestId(request), {});
      return deleted;
    });
    return sendData(reply, groupDto(row));
  } catch (error) {
    return sendRequestError(reply, mapDbError(error));
  }
}

async function audit(client: Parameters<typeof queryOne>[0], principal: Principal, action: string, targetType: string, targetId: string, requestIdValue: string, metadata: Record<string, unknown>): Promise<void> {
  await client.query('INSERT INTO audit_events(id,tenant_id,actor_user_id,action,target_type,target_id,request_id,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [randomUUID(), principal.tenantId, principal.userId, action, targetType, targetId, requestIdValue, JSON.stringify(metadata)]);
}

function mapDbError(error: unknown): unknown {
  if (isUniqueViolation(error)) return appError('ALREADY_EXISTS');
  if (isForeignKeyViolation(error)) return appError('NOT_FOUND');
  return error;
}

export function registerAdminGroupRoutes(app: FastifyInstance): void {
  app.get('/api/admin/groups', listGroups);
  app.post('/api/admin/groups', createGroup);
  app.get('/api/admin/groups/:id', getGroup);
  app.patch('/api/admin/groups/:id', patchGroup);
  app.delete('/api/admin/groups/:id', deleteGroup);
  app.get('/api/admin/me/available-groups', availableGroups);
}
