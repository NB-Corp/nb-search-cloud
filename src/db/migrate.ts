import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { getSchemaVersion } from './transaction.js';

export const CURRENT_SCHEMA_VERSION = 4;
const MIGRATION_LOCK_KEY = 'nb-search-cloud:identity-migrations:v1';
const MIGRATIONS = ['0001_identity.sql', '0002_execution.sql', '0003_provider_key_pool.sql', '0004_script_channels.sql'] as const;

/** The caller must use the migration owner, not the service's runtime pool. */
export async function runMigrations(pool: Pool): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [MIGRATION_LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied = await client.query<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version');
    if (applied.rows.some((row, index) => row.version !== index + 1) || applied.rows.length > CURRENT_SCHEMA_VERSION) throw new Error('SCHEMA_VERSION_INCOMPATIBLE');
    for (let index = applied.rows.length; index < MIGRATIONS.length; index++) {
      const path = resolve(dirname(fileURLToPath(import.meta.url)), '../../migrations', MIGRATIONS[index]!);
      await client.query(await readFile(path, 'utf8'));
      await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [index + 1]);
    }
    await client.query('COMMIT');
    return CURRENT_SCHEMA_VERSION;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the migration error.
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function schemaReady(pool: Pool): Promise<boolean> {
  const version = await getSchemaVersion(pool);
  return version === CURRENT_SCHEMA_VERSION;
}
