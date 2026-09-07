import type { QueryExecutor } from '../db/transaction.js';
import { queryOne } from '../db/transaction.js';
import { canUserBindGroup } from '../auth/policy.js';
import type { UserRow, KeyRow, GroupRow } from '../request-context.js';
import { ExecutionError } from './errors.js';
import type { JobRow, ServicePrincipal } from './types.js';

export interface ExecutionGroup extends GroupRow { default_search_lane: string | null; default_fetch_pipeline: string | null; presets: Record<string, string[]> }
export async function currentIdentity(tx: QueryExecutor, principal: ServicePrincipal): Promise<{ key: KeyRow; user: UserRow; group: ExecutionGroup }> {
  const key = await queryOne<KeyRow>(tx, "SELECT * FROM api_keys WHERE tenant_id=$1 AND id=$2 AND user_id=$3 AND status='active' AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at>clock_timestamp())", [principal.tenantId, principal.keyId, principal.userId]);
  const user = await queryOne<UserRow>(tx, "SELECT u.* FROM users u JOIN tenants t ON t.id=u.tenant_id WHERE u.tenant_id=$1 AND u.id=$2 AND u.status='active' AND t.status='active'", [principal.tenantId, principal.userId]);
  if (!key || !user) throw new ExecutionError('UNAUTHENTICATED');
  const group = await queryOne<ExecutionGroup>(tx, 'SELECT * FROM groups WHERE tenant_id=$1 AND id=$2', [principal.tenantId, key.group_id]);
  if (!group || !await canUserBindGroup(tx, user, group)) throw new ExecutionError('FORBIDDEN');
  return { key, user, group };
}
export type JobPrincipal = ServicePrincipal | { tenantId: string; userId: string; sessionAuthenticated: true; sessionId: string };
export async function jobAccess(tx: QueryExecutor, principal: JobPrincipal, job: JobRow, recovery: boolean): Promise<void> {
  const denied = () => new ExecutionError(recovery ? 'FORBIDDEN' : 'NOT_FOUND');
  if (job.tenant_id !== principal.tenantId || job.user_id !== principal.userId || !job.first_plan || job.purged_at || (job.expires_at && job.expires_at.getTime() <= Date.now())) throw new ExecutionError('NOT_FOUND');
  if ('sessionAuthenticated' in principal) {
    const user = await queryOne<UserRow>(tx, "SELECT u.* FROM users u JOIN tenants t ON t.id=u.tenant_id JOIN sessions s ON s.tenant_id=u.tenant_id AND s.user_id=u.id WHERE u.tenant_id=$1 AND u.id=$2 AND u.status='active' AND t.status='active' AND s.id=$3 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND s.password_version=u.password_version", [principal.tenantId, principal.userId, principal.sessionId]);
    if (!user) throw new ExecutionError('UNAUTHENTICATED');
    const group = await queryOne<ExecutionGroup>(tx, 'SELECT * FROM groups WHERE tenant_id=$1 AND id=$2', [principal.tenantId, job.group_id]);
    if (!user || !group || !await canUserBindGroup(tx, user, group)) throw denied();
  } else {
    let current;
    try { current = await currentIdentity(tx, principal); } catch (error) {
      if (error instanceof ExecutionError && error.code === 'FORBIDDEN') throw denied();
      throw error;
    }
    if (current.key.group_id !== job.group_id) throw denied();
  }
  for (const selected of job.first_plan.selected) {
    const permitted = await queryOne(tx, `SELECT l.id FROM group_lanes gl JOIN lanes l ON l.tenant_id=gl.tenant_id AND l.id=gl.lane_id JOIN providers p ON p.tenant_id=l.tenant_id AND p.id=l.provider_id
      WHERE gl.tenant_id=$1 AND gl.group_id=$2 AND l.id=$3 AND l.kind=$4 AND l.provider_id=$5 AND l.operation_id=$6 AND l.status='active' AND p.status='active' AND p.deleted_at IS NULL`, [principal.tenantId, job.group_id, selected.lane_id, selected.kind, selected.provider_resource_id, selected.operation_id]);
    if (!permitted) throw denied();
  }
}
