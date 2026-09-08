import type { Pool } from 'pg';
import { runMigrations } from '../db/migrate.js';

/** Compatibility entrypoint; all database upgrades share the ordered migration runner. */
export async function applyExecutionMigration(pool: Pool): Promise<number> {
  return runMigrations(pool);
}
