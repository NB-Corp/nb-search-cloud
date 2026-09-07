import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { issueAccessKey, keyDto } from '../auth/api-key.js';
import { canUserBindGroup } from '../auth/policy.js';
import { authenticateSession, withSessionTransaction } from '../auth/session.js';
import { queryOne, queryRows } from '../db/transaction.js';
import { appError, isForeignKeyViolation, isUniqueViolation } from '../errors.js';
import { contextOf, parseBody, requireExactOrigin, requireJson, requestId, sendData, sendRequestError, type GroupRow, type KeyRow, type Principal, type UserRow } from '../request-context.js';

const uuid = z.string().uuid();
const expiry = z.union([z.string().datetime({ offset: true }).transform((value) => new Date(value)), z.null()]);
const quota = z.number().int().min(0).max(1_000_000_000);
const createSchema = z.object({
  user_id: uuid.optional(),
  name: z.string().min(1).max(100),
  group_id: uuid,
  quota_units: quota.optional(),
  expires_at: expiry.optional(),
}).strict();
const patchSchema = z.object({
  expected_revision: z.number().int().positive(),
  name: z.string().min(1).max(100).optional(),
  group_id: uuid.optional(),
  status: z.enum(['active', 'disabled']).optional(),
  quota_units: quota.optional(),
  expires_at: expiry.optional(),
}).strict().refine((value) => Object.keys(value).length > 1, { message: 'empty patch' });
const idSchema = z.object({ id: uuid });

async function sessionRead(request: FastifyRequest): Promise<Principal> {
  const context = contextOf(request);
  requireExactOrigin(request, context.env, false);
  return authenticateSession(request, context.db, context.env);
}

async function listKeys(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const context = contextOf(request);
  try {
    const principal = await sessionRead(request);
    const query = request.query as Record<string, unknown>;
    assertQueryKeys(query, ['user_id', 'limit', 'cursor']);
    const requestedUser = typeof query['user_id'] === 'string' ? query['user_id'] : undefined;
    if (requestedUser !== undefined && !uuid.safeParse(requestedUser).success) throw appError('VALIDATION_FAILED', { fields: [{ path: 'user_id', code: 'UUID' }] });
    const userId = principal.role === 'admin' ? (requestedUser ?? undefined) : (requestedUser === undefined || requestedUser === principal.userId ? principal.userId : undefined);
    if (userId === undefined && principal.role !== 'admin') throw appError('ADMIN_REQUIRED');
    if (requestedUser !== undefined && principal.role === 'admin') {
      const owner = await queryOne<{ id: string }>(context.db.pool, 'SELECT id FROM users WHERE tenant_id=$1 AND id=$2', [principal.tenantId, requestedUser]);
      if (owner === undefined) throw appError('NOT_FOUND');
    }
    const limit = typeof query['limit'] === 'string' ? Number(query['limit']) : 25;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw appError('VALIDATION_FAILED', { fields: [{ path: 'limit', code: 'RANGE' }] });
    const cursor = typeof query['cursor'] === 'string' ? decodeKeyCursor(query['cursor']) : undefined;
    const params: unknown[] = [principal.tenantId];
    let where = 'tenant_id=$1';
    if (userId !== undefined) {
      params.push(userId);
      where += ` AND user_id=$${params.length}`;
    }
    if (cursor !== undefined) {
      params.push(cursor.createdAt, cursor.id);
      where += ` AND (created_at,id) < ($${params.length - 1},$${params.length})`;
    }
    params.push(limit + 1);
    const rows = await queryRows<KeyRow>(context.db.pool, `SELECT id,tenant_id,user_id,group_id,name,prefix,status,quota_units,quota_epoch,expires_at,deleted_at,revision,created_at,updated_at,last_used_at FROM api_keys WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT $${params.length}`, params);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return sendData(reply, { items: page.map((row) => keyDto(row)), next_cursor: hasMore && page.at(-1) !== undefined ? encodeKeyCursor(page.at(-1)!) : null });
  } catch (error) {
    return sendRequestError(reply, error);
  }
}

function decodeKeyCursor(value: string): { createdAt: Date; id: string } {
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

function encodeKeyCursor(row: KeyRow): string {
  return Buffer.from(JSON.stringify({ v: 1, created_at: row.created_at.toISOString(), id: row.id }), 'utf8').toString('base64url');
}

function assertQueryKeys(query: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(query).some((key) => !allowed.includes(key))) throw appError('VALIDATION_FAILED');
}

async function createKey(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const context = contextOf(request);
  try {
    requireJson(request);
    requireExactOrigin(request, context.env);
    const input = parseBody(createSchema, request);
    const access = issueAccessKey();
    const id = randomUUID();
    const result = await withSessionTransaction(request, context, async (client, principal) => {
      const ownerId = input.user_id ?? principal.userId;
      if (principal.role !== 'admin' && ownerId !== principal.userId) throw appError('ADMIN_REQUIRED');
      const owner = await queryOne<UserRow>(client, 'SELECT id,tenant_id,username,display_name,role,status,password_hash,password_version,restrict_public_groups,created_at,updated_at FROM users WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [principal.tenantId, ownerId]);
      const group = await queryOne<GroupRow>(client, 'SELECT id,tenant_id,name,description,status,is_exclusive,daily_units_per_user,revision,deleted_at,created_at,updated_at FROM groups WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [principal.tenantId, input.group_id]);
      if (owner === undefined || group === undefined) throw appError('NOT_FOUND');
      if (!(await canUserBindGroup(client, owner, group))) throw appError('GROUP_NOT_ALLOWED');
      const inserted = await queryOne<KeyRow>(client, `INSERT INTO api_keys(id,tenant_id,user_id,group_id,name,token_hash,prefix,status,quota_units,quota_epoch,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,'active',$8,1,$9) RETURNING id,tenant_id,user_id,group_id,name,prefix,status,quota_units,quota_epoch,expires_at,deleted_at,revision,created_at,updated_at,last_used_at`, [id, principal.tenantId, ownerId, input.group_id, input.name, access.hash, access.prefix, input.quota_units ?? 0, input.expires_at === undefined ? null : input.expires_at]);
      if (inserted === undefined) throw appError('INTERNAL');
      await audit(client, principal, 'key.create', 'api_key', id, requestId(request), { owner_user_id: ownerId, group_id: input.group_id });
      return { row: inserted, accessKey: access.accessKey };
    });
    return sendData(reply, { key: keyDto(result.row), access_key: result.accessKey }, 201);
  } catch (error) {
    return sendRequestError(reply, mapDbError(error));
  }
}

async function getKey(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const context = contextOf(request);
  try {
    const principal = await sessionRead(request);
    const { id } = parseBody(idSchema, { body: request.params } as FastifyRequest);
    const row = await queryOne<KeyRow>(context.db.pool, 'SELECT id,tenant_id,user_id,group_id,name,prefix,status,quota_units,quota_epoch,expires_at,deleted_at,revision,created_at,updated_at,last_used_at FROM api_keys WHERE tenant_id=$1 AND id=$2', [principal.tenantId, id]);
    if (row === undefined) throw appError('NOT_FOUND');
    if (principal.role !== 'admin' && row.user_id !== principal.userId) throw appError('ADMIN_REQUIRED');
    return sendData(reply, keyDto(row));
  } catch (error) {
    return sendRequestError(reply, error);
  }
}

async function patchKey(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const context = contextOf(request);
  try {
    requireJson(request);
    requireExactOrigin(request, context.env);
    const { id } = parseBody(idSchema, { body: request.params } as FastifyRequest);
    const input = parseBody(patchSchema, request);
    const row = await withSessionTransaction(request, context, async (client, principal) => {
      const current = await queryOne<KeyRow>(client, 'SELECT id,tenant_id,user_id,group_id,name,prefix,status,quota_units,quota_epoch,expires_at,deleted_at,revision,created_at,updated_at,last_used_at FROM api_keys WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [principal.tenantId, id]);
      if (current === undefined) throw appError('NOT_FOUND');
      if (principal.role !== 'admin' && current.user_id !== principal.userId) throw appError('ADMIN_REQUIRED');
      if (current.deleted_at !== null) throw appError('NOT_FOUND');
      if (Number(current.revision) !== input.expected_revision) throw appError('STALE_VERSION');
      // Losing group access must not prevent an owner from safely disabling or editing a key.
      // Rebinding is the only mutation that requests a fresh group grant.
      if (input.group_id !== undefined && input.group_id !== current.group_id) {
        const targetGroup = await queryOne<GroupRow>(client, 'SELECT id,tenant_id,name,description,status,is_exclusive,daily_units_per_user,revision,deleted_at,created_at,updated_at FROM groups WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [principal.tenantId, input.group_id]);
        const owner = await queryOne<UserRow>(client, 'SELECT id,tenant_id,username,display_name,role,status,password_hash,password_version,restrict_public_groups,created_at,updated_at FROM users WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [principal.tenantId, current.user_id]);
        if (owner === undefined || targetGroup === undefined) throw appError('NOT_FOUND');
        if (!(await canUserBindGroup(client, owner, targetGroup))) throw appError('GROUP_NOT_ALLOWED');
      }
      const updated = await queryOne<KeyRow>(client, `UPDATE api_keys SET name=COALESCE($3,name),group_id=COALESCE($4,group_id),status=COALESCE($5,status),quota_units=COALESCE($6,quota_units),expires_at=CASE WHEN $7::boolean THEN $8::timestamptz ELSE expires_at END,revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND revision=$9 AND deleted_at IS NULL RETURNING id,tenant_id,user_id,group_id,name,prefix,status,quota_units,quota_epoch,expires_at,deleted_at,revision,created_at,updated_at,last_used_at`, [principal.tenantId, id, input.name ?? null, input.group_id ?? null, input.status ?? null, input.quota_units ?? null, input.expires_at !== undefined, input.expires_at === undefined ? null : input.expires_at, input.expected_revision]);
      if (updated === undefined) throw appError('STALE_VERSION');
      await audit(client, principal, 'key.update', 'api_key', id, requestId(request), { fields: Object.keys(input).filter((key) => key !== 'expected_revision') });
      return updated;
    });
    return sendData(reply, keyDto(row));
  } catch (error) {
    return sendRequestError(reply, mapDbError(error));
  }
}

async function deleteKey(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const context = contextOf(request);
  try {
    requireExactOrigin(request, context.env);
    parseBody(z.object({}).strict().optional(), request);
    const { id } = parseBody(idSchema, { body: request.params } as FastifyRequest);
    const row = await withSessionTransaction(request, context, async (client, principal) => {
      const current = await queryOne<KeyRow>(client, 'SELECT id,tenant_id,user_id,group_id,name,prefix,status,quota_units,quota_epoch,expires_at,deleted_at,revision,created_at,updated_at,last_used_at FROM api_keys WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [principal.tenantId, id]);
      if (current === undefined) throw appError('NOT_FOUND');
      if (principal.role !== 'admin' && current.user_id !== principal.userId) throw appError('ADMIN_REQUIRED');
      if (current.deleted_at !== null) throw appError('NOT_FOUND');
      const deleted = await queryOne<KeyRow>(client, `UPDATE api_keys SET status='disabled',deleted_at=now(),revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND deleted_at IS NULL RETURNING id,tenant_id,user_id,group_id,name,prefix,status,quota_units,quota_epoch,expires_at,deleted_at,revision,created_at,updated_at,last_used_at`, [principal.tenantId, id]);
      if (deleted === undefined) throw appError('NOT_FOUND');
      await audit(client, principal, 'key.delete', 'api_key', id, requestId(request), {});
      return deleted;
    });
    return sendData(reply, keyDto(row));
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

export function registerAdminKeyRoutes(app: FastifyInstance): void {
  app.get('/api/admin/keys', listKeys);
  app.post('/api/admin/keys', createKey);
  app.get('/api/admin/keys/:id', getKey);
  app.patch('/api/admin/keys/:id', patchKey);
  app.delete('/api/admin/keys/:id', deleteKey);
}
