import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { hashPassword } from '../auth/password.js';
import { authenticateSession, withAdminTransaction } from '../auth/session.js';
import { queryOne, queryRows } from '../db/transaction.js';
import { appError, isForeignKeyViolation, isUniqueViolation } from '../errors.js';
import { contextOf, parseBody, requireExactOrigin, requireJson, requestId, sendData, sendRequestError, type Principal, type UserRow } from '../request-context.js';

const uuid = z.string().uuid();
const username = z.string().regex(/^[a-z0-9._-]+$/).min(1).max(64);
const password = z.string().min(12).max(128);
const createSchema = z.object({
  username,
  display_name: z.string().min(1).max(120),
  password,
  role: z.enum(['admin', 'user']).optional(),
  restrict_public_groups: z.boolean().optional(),
  allowed_group_ids: z.array(uuid).max(100).optional(),
}).strict();
const patchSchema = z.object({
  display_name: z.string().min(1).max(120).optional(),
  role: z.enum(['admin', 'user']).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  restrict_public_groups: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, { message: 'empty patch' });
const groupsSchema = z.object({ group_ids: z.array(uuid).max(100) }).strict();
const passwordSchema = z.object({ password }).strict();
const idSchema = z.object({ id: uuid });

function userDto(row: UserRow, allowedGroupIds: string[]): Record<string, unknown> {
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    role: row.role,
    status: row.status,
    restrict_public_groups: row.restrict_public_groups,
    allowed_group_ids: allowedGroupIds,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

async function dto(client: Parameters<typeof queryOne>[0], row: UserRow): Promise<Record<string, unknown>> {
  const allowed = await queryRows<{ group_id: string }>(client, 'SELECT group_id FROM user_allowed_groups WHERE tenant_id=$1 AND user_id=$2 ORDER BY group_id', [row.tenant_id, row.id]);
  return userDto(row, allowed.map((item) => item.group_id));
}

async function requireAdminRead(request: FastifyRequest): Promise<Principal> {
  const context = contextOf(request);
  requireExactOrigin(request, context.env, false);
  const principal = await authenticateSession(request, context.db, context.env);
  if (principal.role !== 'admin') throw appError('ADMIN_REQUIRED');
  return principal;
}

async function listUsers(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const context = contextOf(request);
  try {
    const principal = await requireAdminRead(request);
    const query = request.query as Record<string, unknown>;
    assertQueryKeys(query, ['limit', 'cursor']);
    const limitRaw = typeof query['limit'] === 'string' ? Number(query['limit']) : 25;
    if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 100) throw appError('VALIDATION_FAILED', { fields: [{ path: 'limit', code: 'RANGE' }] });
    const cursor = typeof query['cursor'] === 'string' ? decodeCursor(query['cursor']) : undefined;
    const params: unknown[] = [principal.tenantId];
    let where = 'tenant_id=$1';
    if (cursor !== undefined) {
      params.push(cursor.createdAt, cursor.id);
      where += ` AND (created_at,id) < ($${params.length - 1},$${params.length})`;
    }
    params.push(limitRaw + 1);
    const rows = await queryRows<UserRow>(context.db.pool, `SELECT id,tenant_id,username,display_name,role,status,password_hash,password_version,restrict_public_groups,created_at,updated_at FROM users WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT $${params.length}`, params);
    const hasMore = rows.length > limitRaw;
    const page = hasMore ? rows.slice(0, limitRaw) : rows;
    const items = await Promise.all(page.map((row) => dto(context.db.pool, row)));
    const nextCursor = hasMore ? encodeCursor(page[page.length - 1]!) : null;
    return sendData(reply, { items, next_cursor: nextCursor });
  } catch (error) {
    return sendRequestError(reply, error);
  }
}

async function createUser(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const context = contextOf(request);
  try {
    requireJson(request);
    requireExactOrigin(request, context.env);
    const input = parseBody(createSchema, request);
    const preflight = await authenticateSession(request, context.db, context.env);
    if (preflight.role !== 'admin') throw appError('ADMIN_REQUIRED');
    const passwordHash = await hashPassword(input.password);
    const id = randomUUID();
    const row = await withAdminTransaction(request, context, async (client, principal) => {
      const allowed = [...new Set(input.allowed_group_ids ?? [])];
      if (allowed.length !== (input.allowed_group_ids ?? []).length) throw appError('VALIDATION_FAILED', { fields: [{ path: 'allowed_group_ids', code: 'DUPLICATE' }] });
      if (allowed.length > 0) {
        const groups = await queryRows<{ id: string }>(client, 'SELECT id FROM groups WHERE tenant_id=$1 AND id=ANY($2::uuid[])', [principal.tenantId, allowed]);
        if (groups.length !== allowed.length) throw appError('NOT_FOUND');
      }
      const inserted = await queryOne<UserRow>(client, `INSERT INTO users(id,tenant_id,username,display_name,role,status,password_hash,password_version,restrict_public_groups) VALUES($1,$2,$3,$4,$5,'active',$6,1,$7) RETURNING id,tenant_id,username,display_name,role,status,password_hash,password_version,restrict_public_groups,created_at,updated_at`, [id, principal.tenantId, input.username, input.display_name, input.role ?? 'user', passwordHash, input.restrict_public_groups ?? false]);
      if (inserted === undefined) throw appError('INTERNAL');
      if (allowed.length > 0) await client.query('INSERT INTO user_allowed_groups(tenant_id,user_id,group_id) SELECT $1,$2,unnest($3::uuid[])', [principal.tenantId, id, allowed]);
      await audit(client, principal, 'user.create', 'user', id, requestId(request), { role: input.role ?? 'user' });
      return inserted;
    });
    return sendData(reply, await dto(context.db.pool, row), 201);
  } catch (error) {
    return sendRequestError(reply, mapDbError(error));
  }
}

async function getUser(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const context = contextOf(request);
  try {
    const principal = await requireAdminRead(request);
    const { id } = parseBody(idSchema, { body: request.params } as FastifyRequest);
    const row = await queryOne<UserRow>(context.db.pool, 'SELECT id,tenant_id,username,display_name,role,status,password_hash,password_version,restrict_public_groups,created_at,updated_at FROM users WHERE tenant_id=$1 AND id=$2', [principal.tenantId, id]);
    if (row === undefined) throw appError('NOT_FOUND');
    return sendData(reply, await dto(context.db.pool, row));
  } catch (error) {
    return sendRequestError(reply, error);
  }
}

async function patchUser(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const context = contextOf(request);
  try {
    requireJson(request);
    requireExactOrigin(request, context.env);
    const { id } = parseBody(idSchema, { body: request.params } as FastifyRequest);
    const input = parseBody(patchSchema, request);
    const row = await withAdminTransaction(request, context, async (client, principal) => {
      const current = await queryOne<UserRow>(client, 'SELECT id,tenant_id,username,display_name,role,status,password_hash,password_version,restrict_public_groups,created_at,updated_at FROM users WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [principal.tenantId, id]);
      if (current === undefined) throw appError('NOT_FOUND');
      const nextRole = input.role ?? current.role;
      const nextStatus = input.status ?? current.status;
      if (current.role === 'admin' && current.status === 'active' && (nextRole !== 'admin' || nextStatus !== 'active')) {
        const count = await queryOne<{ count: string }>(client, "SELECT count(*)::text AS count FROM users WHERE tenant_id=$1 AND role='admin' AND status='active' AND id<>$2", [principal.tenantId, id]);
        if (Number(count?.count ?? 0) === 0) throw appError('LAST_ADMIN');
      }
      const updated = await queryOne<UserRow>(client, `UPDATE users SET display_name=COALESCE($3,display_name), role=COALESCE($4,role), status=COALESCE($5,status), restrict_public_groups=COALESCE($6,restrict_public_groups), updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING id,tenant_id,username,display_name,role,status,password_hash,password_version,restrict_public_groups,created_at,updated_at`, [principal.tenantId, id, input.display_name ?? null, input.role ?? null, input.status ?? null, input.restrict_public_groups ?? null]);
      if (updated === undefined) throw appError('NOT_FOUND');
      if (nextStatus === 'disabled' && current.status !== 'disabled') await client.query('UPDATE sessions SET revoked_at=now() WHERE tenant_id=$1 AND user_id=$2 AND revoked_at IS NULL', [principal.tenantId, id]);
      await audit(client, principal, 'user.update', 'user', id, requestId(request), { fields: Object.keys(input), ...(nextStatus === 'disabled' && current.status !== 'disabled' ? { sessions_revoked: true } : {}) });
      return updated;
    });
    return sendData(reply, await dto(context.db.pool, row));
  } catch (error) {
    return sendRequestError(reply, mapDbError(error));
  }
}

async function replaceGroups(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const context = contextOf(request);
  try {
    requireJson(request);
    requireExactOrigin(request, context.env);
    const { id } = parseBody(idSchema, { body: request.params } as FastifyRequest);
    const input = parseBody(groupsSchema, request);
    const row = await withAdminTransaction(request, context, async (client, principal) => {
      const groups = [...new Set(input.group_ids)];
      if (groups.length !== input.group_ids.length) throw appError('VALIDATION_FAILED', { fields: [{ path: 'group_ids', code: 'DUPLICATE' }] });
      const user = await queryOne<UserRow>(client, 'SELECT id,tenant_id,username,display_name,role,status,password_hash,password_version,restrict_public_groups,created_at,updated_at FROM users WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [principal.tenantId, id]);
      if (user === undefined) throw appError('NOT_FOUND');
      if (groups.length > 0) {
        const found = await queryRows<{ id: string }>(client, 'SELECT id FROM groups WHERE tenant_id=$1 AND id=ANY($2::uuid[])', [principal.tenantId, groups]);
        if (found.length !== groups.length) throw appError('NOT_FOUND');
      }
      await client.query('DELETE FROM user_allowed_groups WHERE tenant_id=$1 AND user_id=$2', [principal.tenantId, id]);
      if (groups.length > 0) await client.query('INSERT INTO user_allowed_groups(tenant_id,user_id,group_id) SELECT $1,$2,unnest($3::uuid[])', [principal.tenantId, id, groups]);
      const updated = await queryOne<UserRow>(client, 'UPDATE users SET updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING id,tenant_id,username,display_name,role,status,password_hash,password_version,restrict_public_groups,created_at,updated_at', [principal.tenantId, id]);
      if (updated === undefined) throw appError('NOT_FOUND');
      await audit(client, principal, 'user.allowed_groups.replace', 'user', id, requestId(request), { count: groups.length });
      return updated;
    });
    return sendData(reply, await dto(context.db.pool, row));
  } catch (error) {
    return sendRequestError(reply, mapDbError(error));
  }
}

async function resetPassword(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const context = contextOf(request);
  try {
    requireJson(request);
    requireExactOrigin(request, context.env);
    const { id } = parseBody(idSchema, { body: request.params } as FastifyRequest);
    const input = parseBody(passwordSchema, request);
    const preflight = await authenticateSession(request, context.db, context.env);
    if (preflight.role !== 'admin') throw appError('ADMIN_REQUIRED');
    const passwordHash = await hashPassword(input.password);
    await withAdminTransaction(request, context, async (client, principal) => {
      const target = await queryOne<UserRow>(client, 'SELECT id,tenant_id,username,display_name,role,status,password_hash,password_version,restrict_public_groups,created_at,updated_at FROM users WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [principal.tenantId, id]);
      if (target === undefined) throw appError('NOT_FOUND');
      await client.query('UPDATE users SET password_hash=$3,password_version=password_version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2', [principal.tenantId, id, passwordHash]);
      await client.query('UPDATE sessions SET revoked_at=now() WHERE tenant_id=$1 AND user_id=$2 AND revoked_at IS NULL', [principal.tenantId, id]);
      await audit(client, principal, 'user.password.reset', 'user', id, requestId(request), { sessions_revoked: true });
    });
    return sendData(reply, { sessions_revoked: true });
  } catch (error) {
    return sendRequestError(reply, mapDbError(error));
  }
}

function decodeCursor(value: string): { createdAt: Date; id: string } {
  if (value.length > 2048) throw appError('VALIDATION_FAILED', { fields: [{ path: 'cursor', code: 'FORMAT' }] });
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { v?: number; created_at?: string; id?: string };
    if (decoded.v !== 1 || typeof decoded.created_at !== 'string' || typeof decoded.id !== 'string' || !uuid.safeParse(decoded.id).success) throw new Error('invalid');
    const date = new Date(decoded.created_at);
    if (Number.isNaN(date.getTime())) throw new Error('invalid');
    return { createdAt: date, id: decoded.id };
  } catch {
    throw appError('VALIDATION_FAILED', { fields: [{ path: 'cursor', code: 'FORMAT' }] });
  }
}

function encodeCursor(row: UserRow): string {
  return Buffer.from(JSON.stringify({ v: 1, created_at: row.created_at.toISOString(), id: row.id }), 'utf8').toString('base64url');
}

function assertQueryKeys(query: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(query).some((key) => !allowed.includes(key))) throw appError('VALIDATION_FAILED');
}

async function audit(client: Parameters<typeof queryOne>[0], principal: Principal, action: string, targetType: string, targetId: string, requestIdValue: string, metadata: Record<string, unknown>): Promise<void> {
  await client.query('INSERT INTO audit_events(id,tenant_id,actor_user_id,action,target_type,target_id,request_id,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [randomUUID(), principal.tenantId, principal.userId, action, targetType, targetId, requestIdValue, JSON.stringify(metadata)]);
}

function mapDbError(error: unknown): unknown {
  if (isUniqueViolation(error)) return appError('ALREADY_EXISTS');
  if (isForeignKeyViolation(error)) return appError('NOT_FOUND');
  return error;
}

export function registerAdminUserRoutes(app: FastifyInstance): void {
  app.get('/api/admin/users', listUsers);
  app.post('/api/admin/users', createUser);
  app.get('/api/admin/users/:id', getUser);
  app.patch('/api/admin/users/:id', patchUser);
  app.put('/api/admin/users/:id/allowed-groups', replaceGroups);
  app.post('/api/admin/users/:id/password', resetPassword);
}
