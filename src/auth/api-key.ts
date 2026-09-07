import { createHash, randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { queryOne } from '../db/transaction.js';
import type { DbHandle } from '../db/client.js';
import { appError } from '../errors.js';
import { cookieName, type CloudEnv } from '../env.js';
import { canUserBindGroup } from './policy.js';
import { safeJsonInteger, type GroupRow, type KeyRow, type Principal, type UserRow } from '../request-context.js';

const TOKEN_PATTERN = /^nbc_[A-Za-z0-9_-]{43}$/;

export interface IssuedKey {
  accessKey: string;
  hash: Buffer;
  prefix: string;
}

export function issueAccessKey(): IssuedKey {
  const accessKey = `nbc_${randomBytes(32).toString('base64url')}`;
  return { accessKey, hash: hashAccessKey(accessKey), prefix: accessKey.slice(0, 12) };
}

export function hashAccessKey(accessKey: string): Buffer {
  return createHash('sha256').update(accessKey, 'utf8').digest();
}

export function parseBearer(request: FastifyRequest, env: Pick<CloudEnv, 'cookieMode'>): string {
  if (request.cookies?.[cookieName(env)] !== undefined) throw appError('AUTH_REQUIRED');
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !/^Bearer [^\s]+$/.test(header)) throw appError('AUTH_REQUIRED');
  const token = header.slice('Bearer '.length);
  if (!TOKEN_PATTERN.test(token)) throw appError('AUTH_REQUIRED');
  return token;
}

/**
 * Credential identity only: group availability is deliberately checked by the
 * action-specific policy, so a disabled group is not confused with bad credentials.
 */
export async function authenticateServiceKey(request: FastifyRequest, db: DbHandle, env: Pick<CloudEnv, 'cookieMode'>, now = new Date()): Promise<Principal> {
  const token = parseBearer(request, env);
  const row = await queryOne<KeyAuthRow>(db.pool, `
    SELECT k.id AS key_id,k.tenant_id,k.user_id,k.group_id,k.status AS key_status,k.deleted_at AS key_deleted_at,
           k.expires_at,u.role,u.status AS user_status,u.restrict_public_groups,t.status AS tenant_status
      FROM api_keys k JOIN users u ON u.tenant_id=k.tenant_id AND u.id=k.user_id JOIN tenants t ON t.id=k.tenant_id
     WHERE k.token_hash=$1`, [hashAccessKey(token)]);
  if (row === undefined || row.tenant_status !== 'active' || row.user_status !== 'active' || row.key_status !== 'active' || row.key_deleted_at !== null || (row.expires_at !== null && new Date(row.expires_at).getTime() <= now.getTime())) throw appError('AUTH_REQUIRED');
  return { tenantId: row.tenant_id, userId: row.user_id, role: row.role, keyId: row.key_id, groupId: row.group_id };
}

export async function serviceKeyGroupAvailable(db: DbHandle, principal: Principal, now = new Date()): Promise<boolean> {
  if (principal.keyId === undefined || principal.groupId === undefined) return false;
  const row = await queryOne<{ user_id: string; user_tenant_id: string; user_status: UserRow['status']; restrict_public_groups: boolean; group_id: string; group_tenant_id: string; group_status: GroupRow['status']; is_exclusive: boolean; group_deleted_at: Date | null; tenant_status: 'active' | 'disabled' }>(db.pool, `
    SELECT u.id AS user_id,u.tenant_id AS user_tenant_id,u.status AS user_status,u.restrict_public_groups,
           g.id AS group_id,g.tenant_id AS group_tenant_id,g.status AS group_status,g.is_exclusive,g.deleted_at AS group_deleted_at,
           t.status AS tenant_status
      FROM api_keys k JOIN users u ON u.tenant_id=k.tenant_id AND u.id=k.user_id
      JOIN groups g ON g.tenant_id=k.tenant_id AND g.id=k.group_id JOIN tenants t ON t.id=k.tenant_id
     WHERE k.tenant_id=$1 AND k.id=$2 AND k.user_id=$3 AND k.group_id=$4
       AND k.status='active' AND k.deleted_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>$5)`, [principal.tenantId, principal.keyId, principal.userId, principal.groupId, now]);
  if (row === undefined || row.tenant_status !== 'active') return false;
  return canUserBindGroup(db.pool, {
    id: row.user_id,
    tenant_id: row.user_tenant_id,
    status: row.user_status,
    restrict_public_groups: row.restrict_public_groups,
  }, {
    id: row.group_id,
    tenant_id: row.group_tenant_id,
    status: row.group_status,
    is_exclusive: row.is_exclusive,
    deleted_at: row.group_deleted_at,
  });
}

interface KeyAuthRow {
  key_id: string;
  tenant_id: string;
  user_id: string;
  group_id: string;
  key_status: 'active' | 'disabled';
  key_deleted_at: Date | null;
  expires_at: Date | null;
  role: 'admin' | 'user';
  user_status: 'active' | 'disabled';
  tenant_status: 'active' | 'disabled';
}

export function keyDto(row: KeyRow, now = new Date()): Record<string, unknown> {
  const quota = safeJsonInteger(row.quota_units);
  let effectiveStatus: string = row.status;
  if (row.deleted_at !== null) effectiveStatus = 'deleted';
  else if (row.expires_at !== null && row.expires_at.getTime() <= now.getTime()) effectiveStatus = 'expired';
  return {
    id: row.id,
    user_id: row.user_id,
    group_id: row.group_id,
    name: row.name,
    prefix: row.prefix,
    status: row.status,
    effective_status: effectiveStatus,
    quota_units: quota,
    expires_at: row.expires_at?.toISOString() ?? null,
    deleted_at: row.deleted_at?.toISOString() ?? null,
    revision: safeJsonInteger(row.revision),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    last_used_at: row.last_used_at?.toISOString() ?? null,
  };
}

export type { KeyRow };
