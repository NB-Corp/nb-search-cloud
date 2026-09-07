import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import type { DbHandle } from '../db/client.js';
import { lockTenant, queryOne, withTransaction, type QueryExecutor } from '../db/transaction.js';
import { appError } from '../errors.js';
import { cookieName, type CloudEnv } from '../env.js';
import type { Principal, RouteContext, SessionRow } from '../request-context.js';

const SESSION_BYTES = 32;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface SessionSecretPair {
  id: string;
  sessionToken: string;
  csrfToken: string;
  expiresAt: Date;
}

export interface SessionView {
  tenant: { id: string; slug: string; name: string };
  user: Record<string, unknown>;
  csrf_token: string;
  expires_at: string;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function tokenHash(value: string): Buffer {
  return digest(value);
}

export function cookieOptions(env: Pick<CloudEnv, 'cookieMode'>): { httpOnly: true; sameSite: 'strict'; path: '/'; secure: boolean } {
  return { httpOnly: true, sameSite: 'strict', path: '/', secure: env.cookieMode === 'production' };
}

export async function createSession(client: QueryExecutor, tenantId: string, userId: string, passwordVersion: number, now = new Date()): Promise<SessionSecretPair> {
  const sessionToken = randomBytes(SESSION_BYTES).toString('base64url');
  const csrfToken = randomBytes(SESSION_BYTES).toString('base64url');
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  const id = randomUUID();
  await client.query('INSERT INTO sessions(id,tenant_id,user_id,token_hash,csrf_hash,password_version,created_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [id, tenantId, userId, digest(sessionToken), digest(csrfToken), passwordVersion, now, expiresAt]);
  return { id, sessionToken, csrfToken, expiresAt };
}

function cookieToken(request: FastifyRequest, env: Pick<CloudEnv, 'cookieMode'>): string {
  const token = request.cookies?.[cookieName(env)];
  if (typeof token !== 'string' || !SESSION_TOKEN_PATTERN.test(token)) throw appError('AUTH_REQUIRED');
  return token;
}

export async function authenticateSession(request: FastifyRequest, db: DbHandle, env: Pick<CloudEnv, 'cookieMode'>, now = new Date()): Promise<Principal> {
  if (request.headers.authorization !== undefined) throw appError('AUTH_REQUIRED');
  const token = cookieToken(request, env);
  const row = await queryOne<SessionRow>(db.pool, `
    SELECT s.id,s.tenant_id,s.user_id,s.token_hash,s.csrf_hash,s.password_version,s.created_at,s.expires_at,s.revoked_at,
           u.role,u.status AS user_status,u.password_version AS password_version_current,
           t.status AS tenant_status,t.slug AS tenant_slug,t.name AS tenant_name,
           u.username,u.display_name,u.restrict_public_groups,u.created_at AS user_created_at,u.updated_at AS user_updated_at
      FROM sessions s JOIN users u ON u.tenant_id=s.tenant_id AND u.id=s.user_id JOIN tenants t ON t.id=s.tenant_id
     WHERE s.token_hash=$1`, [digest(token)]);
  if (!sessionUsable(row, now)) throw appError('AUTH_REQUIRED');
  return principalFromRow(row);
}

function sessionUsable(row: SessionRow | undefined, now: Date): row is SessionRow {
  return row !== undefined && row.revoked_at === null && new Date(row.expires_at).getTime() > now.getTime() && row.tenant_status === 'active' && row.user_status === 'active' && row.password_version === row.password_version_current;
}

function principalFromRow(row: SessionRow): Principal {
  return { tenantId: row.tenant_id, userId: row.user_id, role: row.role, sessionId: row.id, passwordVersion: row.password_version };
}

export async function recheckSessionInTransaction(client: PoolClient, request: FastifyRequest, env: Pick<CloudEnv, 'cookieMode'>, tenantId: string, now = new Date()): Promise<{ principal: Principal; row: SessionRow }> {
  const token = cookieToken(request, env);
  const row = await queryOne<SessionRow>(client, `
    SELECT s.id,s.tenant_id,s.user_id,s.token_hash,s.csrf_hash,s.password_version,s.created_at,s.expires_at,s.revoked_at,
           u.role,u.status AS user_status,u.password_version AS password_version_current,
           t.status AS tenant_status,t.slug AS tenant_slug,t.name AS tenant_name,
           u.username,u.display_name,u.restrict_public_groups,u.created_at AS user_created_at,u.updated_at AS user_updated_at
      FROM sessions s JOIN users u ON u.tenant_id=s.tenant_id AND u.id=s.user_id JOIN tenants t ON t.id=s.tenant_id
     WHERE s.tenant_id=$1 AND s.token_hash=$2
     FOR UPDATE`, [tenantId, digest(token)]);
  if (!sessionUsable(row, now)) throw appError('AUTH_REQUIRED');
  return { principal: principalFromRow(row), row };
}

export async function withAdminTransaction<T>(request: FastifyRequest, context: RouteContext, fn: (client: PoolClient, principal: Principal) => Promise<T>): Promise<T> {
  return withSessionTransaction(request, context, async (client, principal) => {
    if (principal.role !== 'admin') throw appError('ADMIN_REQUIRED');
    return fn(client, principal);
  });
}

export async function withSessionTransaction<T>(request: FastifyRequest, context: RouteContext, fn: (client: PoolClient, principal: Principal) => Promise<T>): Promise<T> {
  const initial = await authenticateSession(request, context.db, context.env);
  return withTransaction(context.db, async (client) => {
    await lockTenant(client, initial.tenantId);
    const current = await recheckSessionInTransaction(client, request, context.env, initial.tenantId);
    verifyCsrf(request, current.row);
    return fn(client, current.principal);
  });
}

export async function refreshCsrf(request: FastifyRequest, context: RouteContext): Promise<{ principal: Principal; csrfToken: string; expiresAt: Date; view: SessionView }> {
  const initial = await authenticateSession(request, context.db, context.env);
  return withTransaction(context.db, async (client) => {
    await lockTenant(client, initial.tenantId);
    const current = await recheckSessionInTransaction(client, request, context.env, initial.tenantId);
    const csrfToken = randomBytes(SESSION_BYTES).toString('base64url');
    await client.query('UPDATE sessions SET csrf_hash=$1 WHERE id=$2', [digest(csrfToken), current.principal.sessionId]);
    const allowed = await client.query<{ group_id: string }>('SELECT group_id FROM user_allowed_groups WHERE tenant_id=$1 AND user_id=$2 ORDER BY group_id', [current.principal.tenantId, current.principal.userId]);
    const row = { ...current.row, allowed_group_ids: allowed.rows.map((item) => item.group_id) };
    return { principal: current.principal, csrfToken, expiresAt: current.row.expires_at, view: sessionView(row, csrfToken) };
  });
}

export function verifyCsrf(request: FastifyRequest, row: Pick<SessionRow, 'csrf_hash'>): void {
  const csrf = request.headers['x-csrf-token'];
  if (typeof csrf !== 'string' || csrf.length === 0) throw appError('CSRF_REJECTED');
  const actual = digest(csrf);
  if (row.csrf_hash.length !== actual.length || !timingSafeEqual(actual, row.csrf_hash)) throw appError('CSRF_REJECTED');
}

export function sessionView(row: Pick<SessionRow, 'tenant_slug' | 'tenant_name' | 'tenant_id' | 'user_id' | 'username' | 'display_name' | 'role' | 'user_status' | 'restrict_public_groups' | 'expires_at' | 'user_created_at' | 'user_updated_at'> & { allowed_group_ids?: string[] }, csrfToken: string): SessionView {
  return {
    tenant: { id: row.tenant_id, slug: row.tenant_slug, name: row.tenant_name },
    user: {
      id: row.user_id,
      username: row.username,
      display_name: row.display_name,
      role: row.role,
      status: row.user_status,
      restrict_public_groups: row.restrict_public_groups,
      allowed_group_ids: row.allowed_group_ids ?? [],
      created_at: new Date(row.user_created_at).toISOString(),
      updated_at: new Date(row.user_updated_at).toISOString(),
    },
    csrf_token: csrfToken,
    expires_at: new Date(row.expires_at).toISOString(),
  };
}

export function setSessionCookie(reply: { setCookie(name: string, value: string, options: object): unknown }, env: Pick<CloudEnv, 'cookieMode'>, token: string): void {
  reply.setCookie(cookieName(env), token, cookieOptions(env));
}

export function clearSessionCookie(reply: { clearCookie(name: string, options: object): unknown }, env: Pick<CloudEnv, 'cookieMode'>): void {
  reply.clearCookie(cookieName(env), cookieOptions(env));
}

export { digest as sessionDigest };
