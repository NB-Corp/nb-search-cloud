import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDb, closeDb, type DbHandle } from '../../src/db/client.js';
import { verifyPassword } from '../../src/auth/password.js';
import { createSession } from '../../src/auth/session.js';
import { withTransaction } from '../../src/db/transaction.js';
import { integrationDatabaseUrl, integrationOwnerUrl, prepareIntegrationDatabase } from '../helpers/identity.js';
let db: DbHandle;
beforeAll(async () => { await prepareIntegrationDatabase(); db = createDb(integrationDatabaseUrl()); });
afterAll(async () => { if (db) await closeDb(db); });
function run(args: string[], password?: string, migrate = false) {
  return execFileSync(process.execPath, args, {
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, DATABASE_URL: integrationDatabaseUrl(), ...(migrate ? { MIGRATION_DATABASE_URL: integrationOwnerUrl() } : {}) },
    input: password === undefined ? undefined : password + '\n', encoding: 'utf8', timeout: 15000,
  });
}
it('compiled migrate, bootstrap and reset succeed on restricted PG without HTTP/Cookie/master-key configuration', async () => {
  expect(run(['dist/server.js', 'migrate'], undefined, true)).toContain('schema_version=2');
  const slug = `offline-${randomUUID()}`, password = 'Offline-initial-fixture-123', replacement = 'Offline-replacement-fixture-456';
  const args = ['--tenant', slug, '--username', 'admin', '--password-stdin'];
  const created = run(['dist/cli/bootstrap-admin.js', ...args], password);
  expect(created).toContain('Created administrator'); expect(created).not.toContain(password);
  const initial = (await db.pool.query('SELECT u.* FROM users u JOIN tenants t ON t.id=u.tenant_id WHERE t.slug=$1', [slug])).rows[0];
  expect(await verifyPassword(password, initial.password_hash)).toBe(true);
  const session = await withTransaction(db, tx => createSession(tx, initial.tenant_id, initial.id, initial.password_version));
  const reset = run(['dist/cli/reset-password.js', ...args], replacement);
  expect(reset).toContain('Password reset'); expect(reset).not.toContain(replacement);
  const current = (await db.pool.query('SELECT * FROM users WHERE id=$1', [initial.id])).rows[0];
  expect(current.password_version).toBe(initial.password_version + 1);
  expect(await verifyPassword(replacement, current.password_hash)).toBe(true);
  expect(await verifyPassword(password, current.password_hash)).toBe(false);
  const sessions = (await db.pool.query('SELECT revoked_at FROM sessions WHERE tenant_id=$1 AND user_id=$2', [initial.tenant_id, initial.id])).rows;
  expect(sessions).toHaveLength(1); expect(sessions[0].revoked_at).not.toBeNull();
  expect(session.sessionToken).toBeTruthy();
  const audit = (await db.pool.query('SELECT action FROM audit_events WHERE tenant_id=$1 ORDER BY created_at', [initial.tenant_id])).rows.map(row => row.action);
  expect(audit).toEqual(['bootstrap.admin.create', 'user.password.reset.offline']);
  const role = (await db.pool.query('SELECT rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0];
  expect(role.rolsuper).toBe(false);
});
