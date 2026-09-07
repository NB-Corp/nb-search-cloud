import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import type { DbHandle } from './client.js';

export type QueryExecutor = Pool | PoolClient;

export async function queryRows<T extends QueryResultRow>(executor: QueryExecutor, text: string, values: readonly unknown[] = []): Promise<T[]> {
  const result = await executor.query<T>(text, [...values]);
  return result.rows;
}

export async function queryOne<T extends QueryResultRow>(executor: QueryExecutor, text: string, values: readonly unknown[] = []): Promise<T | undefined> {
  const rows = await queryRows<T>(executor, text, values);
  return rows[0];
}

export async function withTransaction<T>(db: DbHandle, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the original failure. The connection is discarded by pg if needed.
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function withTenantLock<T>(client: PoolClient, tenantId: string, fn: () => Promise<T>): Promise<T> {
  await lockTenant(client, tenantId);
  return fn();
}

export async function lockTenant(client: PoolClient, tenantId: string): Promise<void> {
  const result = await client.query<{ id: string }>('SELECT id FROM tenants WHERE id = $1 FOR UPDATE', [tenantId]);
  if (result.rowCount !== 1) {
    throw new Error('TENANT_NOT_FOUND');
  }
}

export async function pingDatabase(db: DbHandle): Promise<boolean> {
  try {
    await db.pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

export async function getSchemaVersion(executor: QueryExecutor): Promise<number | null> {
  try {
    const result = await executor.query<{ version: number | string }>(
      "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
    );
    const value = result.rows[0]?.version;
    return value === undefined ? null : Number(value);
  } catch {
    return null;
  }
}

export type RawQueryResult<T extends QueryResultRow> = QueryResult<T>;
