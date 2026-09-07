import { queryOne, type QueryExecutor } from '../db/transaction.js';
import type { GroupRow, UserRow } from '../request-context.js';

export async function canUserBindGroup(client: QueryExecutor, user: Pick<UserRow, 'id' | 'tenant_id' | 'status' | 'restrict_public_groups'>, group: Pick<GroupRow, 'id' | 'tenant_id' | 'status' | 'is_exclusive' | 'deleted_at'>): Promise<boolean> {
  if (user.tenant_id !== group.tenant_id || user.status !== 'active' || group.status !== 'active' || group.deleted_at !== null) return false;
  if (!group.is_exclusive && !user.restrict_public_groups) return true;
  const membership = await queryOne<{ user_id: string }>(client, 'SELECT user_id FROM user_allowed_groups WHERE tenant_id=$1 AND user_id=$2 AND group_id=$3', [user.tenant_id, user.id, group.id]);
  return membership !== undefined;
}

export async function canUserBindGroupById(client: QueryExecutor, tenantId: string, userId: string, groupId: string): Promise<boolean> {
  const row = await queryOne<{ user_id: string; user_tenant_id: string; user_status: UserRow['status']; restrict_public_groups: boolean; group_id: string; group_tenant_id: string; group_status: GroupRow['status']; is_exclusive: boolean; group_deleted_at: Date | null }>(client, `
    SELECT u.id AS user_id,u.tenant_id AS user_tenant_id,u.status AS user_status,u.restrict_public_groups,
           g.id AS group_id,g.tenant_id AS group_tenant_id,g.status AS group_status,g.is_exclusive,g.deleted_at AS group_deleted_at
      FROM users u JOIN groups g ON g.tenant_id=u.tenant_id
     WHERE u.tenant_id=$1 AND u.id=$2 AND g.id=$3`, [tenantId, userId, groupId]);
  if (row === undefined) return false;
  return canUserBindGroup(client, {
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

export async function listAllowedGroupIds(client: QueryExecutor, tenantId: string, userId: string): Promise<string[]> {
  const rows = await client.query<{ group_id: string }>('SELECT group_id FROM user_allowed_groups WHERE tenant_id=$1 AND user_id=$2 ORDER BY group_id', [tenantId, userId]);
  return rows.rows.map((row) => row.group_id);
}
