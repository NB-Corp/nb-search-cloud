import { URL } from 'node:url';
import { closeDb, createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { grantRuntimeAccess, migrationConnections } from '../../src/db/provision.js';
import { hashPassword } from '../../src/auth/password.js';

export const TEST_ORIGIN = 'http://127.0.0.1:3000';
export function integrationDatabaseUrl(): string {
  const value = process.env['DATABASE_URL'];
  if (!value) throw new Error('REAL_PG_REQUIRED: use the isolated test database controller.');
  assertIsTaskDatabase(value); return value;
}
export function integrationOwnerUrl(): string {
  const value = process.env['MIGRATION_DATABASE_URL'];
  if (!value) throw new Error('REAL_PG_OWNER_REQUIRED');
  assertIsTaskDatabase(value);
  migrationConnections(value, integrationDatabaseUrl());
  return value;
}
export function assertIsTaskDatabase(databaseUrl: string): void {
  const parsed = new URL(databaseUrl);
  if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) || !parsed.pathname.startsWith('/nbcloud_test_')) throw new Error('Refusing integration writes outside an isolated local nbcloud_test_* database.');
}
export async function prepareIntegrationDatabase(reset = false): Promise<void> {
  const owner = createDb(integrationOwnerUrl());
  try {
    await runMigrations(owner.pool);
    await grantRuntimeAccess(owner.pool, decodeURIComponent(new URL(integrationDatabaseUrl()).username));
    if (reset) await owner.pool.query('TRUNCATE TABLE audit_events, auth_rate_buckets, sessions, api_keys, user_allowed_groups, groups, users, tenants RESTART IDENTITY CASCADE');
  } finally { await closeDb(owner); }
}
export async function openIntegrationDb(): Promise<DbHandle> {
  await prepareIntegrationDatabase(true);
  return createDb(integrationDatabaseUrl(), { max: 12 });
}

export async function seedUser(db: DbHandle, input: { tenantId: string; userId: string; username: string; password: string; role?: 'admin' | 'user'; restrictPublicGroups?: boolean }): Promise<void> {
  const passwordHash = await hashPassword(input.password);
  await db.pool.query('INSERT INTO users(id,tenant_id,username,display_name,role,status,password_hash,password_version,restrict_public_groups) VALUES($1,$2,$3,$4,$5,\'active\',$6,1,$7)', [input.userId, input.tenantId, input.username, input.username, input.role ?? 'user', passwordHash, input.restrictPublicGroups ?? false]);
}
