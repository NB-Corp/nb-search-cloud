import { Pool, type PoolConfig } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { parseDatabaseConnection } from './connection.js';

export interface DbHandle {
  pool: Pool;
  orm: NodePgDatabase<Record<string, never>>;
}

export function createDb(databaseUrl: string, options: Pick<PoolConfig, 'max' | 'idleTimeoutMillis' | 'connectionTimeoutMillis' | 'application_name'> = {}): DbHandle {
  const connection = parseDatabaseConnection(databaseUrl);
  if (Object.keys(options).some((key) => !['max', 'idleTimeoutMillis', 'connectionTimeoutMillis', 'application_name'].includes(key))) throw new Error('INVALID_DATABASE_POOL_OPTIONS');
  const pool = new Pool({
    ...connection,
    max: options.max ?? 10,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
    application_name: options.application_name ?? connection.application_name ?? 'nb-search-cloud',
  });
  // node-postgres emits idle-client failures on the Pool, outside any query promise.
  // Observe them without logging the Error, client, or connection configuration.
  pool.on('error', () => { process.stderr.write('{"level":"warn","code":"DB_IDLE_CONNECTION_LOST"}\n'); });
  return { pool, orm: drizzle(pool) };
}

export async function closeDb(db: DbHandle): Promise<void> {
  await db.pool.end();
}
