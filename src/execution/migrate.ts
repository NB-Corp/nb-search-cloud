import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

/** Stage-B migration entrypoint; identity runner integration waits for candidate review. */
export async function applyExecutionMigration(pool: Pool): Promise<number> {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['nb-search-cloud:identity-migrations:v1']);
    const result = await tx.query<{ version: number }>('SELECT coalesce(max(version),0)::integer AS version FROM schema_migrations');
    const version = result.rows[0]!.version;
    if (version !== 1 && version !== 2) throw new Error('IDENTITY_SCHEMA_REQUIRED');
    if (version === 1) {
      const sql = await readFile(fileURLToPath(new URL('../../migrations/0002_execution.sql', import.meta.url)), 'utf8');
      await tx.query(sql);
      await tx.query('INSERT INTO schema_migrations(version) VALUES(2)');
    }
    await tx.query('COMMIT');
    return 2;
  } catch (error) {
    await tx.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { tx.release(); }
}
