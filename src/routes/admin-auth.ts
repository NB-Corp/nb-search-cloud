import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { queryOne, withTransaction } from '../db/transaction.js';
import { appError, isUniqueViolation } from '../errors.js';
import { requireJson, contextOf, parseBody, requireExactOrigin, rejectAuthorization, sendData, sendRequestError, requestId } from '../request-context.js';
import { consumeRateLimit } from '../auth/rate-limit.js';
import { verifyAgainstDummy, verifyPassword } from '../auth/password.js';
import { authenticateSession, clearSessionCookie, createSession, refreshCsrf, sessionView, setSessionCookie, withSessionTransaction } from '../auth/session.js';
import type { SessionRow, UserRow } from '../request-context.js';

const loginSchema = z.object({
  tenant: z.string().min(1).max(63),
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(128),
}).strict();

const emptySchema = z.object({}).strict();

function safeUser(row: UserRow, allowedGroupIds: string[] = []): Record<string, unknown> {
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

async function login(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const context = contextOf(request);
  requireJson(request);
  requireExactOrigin(request, context.env);
  rejectAuthorization(request);
  const input = parseBody(loginSchema, request);
  const normalizedUsername = input.username.toLowerCase();
  const ip = request.ip || 'unknown';
  try {
    await consumeRateLimit(context.db.pool, { scope: 'login_ip', subject: `${input.tenant.toLowerCase()}\0${ip}`, limit: context.env.loginIpLimit });
    await consumeRateLimit(context.db.pool, { scope: 'login_account', subject: `${input.tenant.toLowerCase()}\0${normalizedUsername}`, limit: context.env.loginAccountLimit });
    const row = await queryOne<LoginRow>(context.db.pool, `
      SELECT t.id AS tenant_id, t.slug AS tenant_slug, t.name AS tenant_name, t.status AS tenant_status,
             u.id AS user_id, u.username, u.display_name, u.role, u.status AS user_status,
             u.password_hash, u.password_version, u.restrict_public_groups, u.created_at, u.updated_at
        FROM tenants t LEFT JOIN users u ON u.tenant_id=t.id AND u.username=$2
       WHERE t.slug=$1`, [input.tenant.toLowerCase(), normalizedUsername]);
    const validHash = row === undefined || row.password_hash === null ? await verifyAgainstDummy(input.password) : await verifyPassword(input.password, row.password_hash);
    if (row === undefined || row.user_id === null || row.password_hash === null || row.password_version === null || row.user_status === null || row.role === null || !validHash || row.tenant_status !== 'active' || row.user_status !== 'active') throw appError('AUTH_REQUIRED');
    const tenantId = row.tenant_id;
    const userId = row.user_id;
    const snapshotPasswordVersion = row.password_version;
    const snapshotPasswordHash = row.password_hash;
    const session = await withTransaction(context.db, async (client) => {
      await client.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [tenantId]);
      const current = await queryOne<UserLoginRow>(client, 'SELECT id, tenant_id, username, display_name, role, status, password_hash, password_version, restrict_public_groups, created_at, updated_at FROM users WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [tenantId, userId]);
      if (current === undefined || current.status !== 'active' || current.password_version !== snapshotPasswordVersion || current.password_hash !== snapshotPasswordHash) throw appError('AUTH_REQUIRED');
      const created = await createSession(client, tenantId, userId, current.password_version);
      const allowed = await client.query<{ group_id: string }>('SELECT group_id FROM user_allowed_groups WHERE tenant_id=$1 AND user_id=$2 ORDER BY group_id', [tenantId, userId]);
      const tenant = await queryOne<{ slug: string; name: string; status: string }>(client, 'SELECT slug,name,status FROM tenants WHERE id=$1', [tenantId]);
      if (tenant === undefined || tenant.status !== 'active') throw appError('AUTH_REQUIRED');
      return { created, view: { tenant: { id: tenantId, slug: tenant.slug, name: tenant.name }, user: safeUser(current, allowed.rows.map((item) => item.group_id)), csrf_token: created.csrfToken, expires_at: created.expiresAt.toISOString() } };
    });
    setSessionCookie(reply, context.env, session.created.sessionToken);
    return sendData(reply, session.view);
  } catch (error) {
    return sendRequestError(reply, isUniqueViolation(error) ? appError('ALREADY_EXISTS') : error);
  }
}

async function getSession(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const context = contextOf(request);
  try {
    rejectAuthorization(request);
    requireExactOrigin(request, context.env, false);
    const result = await refreshCsrf(request, context);
    return sendData(reply, result.view);
  } catch (error) {
    return sendRequestError(reply, error);
  }
}

async function logout(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const context = contextOf(request);
  try {
    requireExactOrigin(request, context.env);
    rejectAuthorization(request);
    parseBody(emptySchema.optional(), request);
    const result = await withSessionTransaction(request, context, async (client, principal) => {
      if (principal.sessionId === undefined) throw appError('AUTH_REQUIRED');
      await client.query('UPDATE sessions SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL', [principal.sessionId]);
      await client.query('INSERT INTO audit_events(id,tenant_id,actor_user_id,action,target_type,target_id,request_id,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [randomUUID(), principal.tenantId, principal.userId, 'auth.logout', 'session', principal.sessionId, requestId(request), JSON.stringify({})]);
      return { logged_out: true };
    });
    clearSessionCookie(reply, context.env);
    return sendData(reply, result);
  } catch (error) {
    return sendRequestError(reply, error);
  }
}

export function registerAdminAuthRoutes(app: FastifyInstance): void {
  app.post('/api/admin/auth/login', login);
  app.get('/api/admin/auth/session', getSession);
  app.post('/api/admin/auth/logout', logout);
}

interface LoginRow {
  tenant_id: string;
  tenant_slug: string;
  tenant_name: string;
  tenant_status: 'active' | 'disabled';
  user_id: string | null;
  username: string | null;
  display_name: string | null;
  role: 'admin' | 'user' | null;
  user_status: 'active' | 'disabled' | null;
  password_hash: string | null;
  password_version: number | null;
  restrict_public_groups: boolean | null;
  created_at: Date | null;
  updated_at: Date | null;
}

type UserLoginRow = UserRow;
