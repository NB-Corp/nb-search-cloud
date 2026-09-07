import { createDb, closeDb } from '../db/client.js';
import { provisionDatabase, roleConnections } from '../db/provision.js';

if (process.argv.includes('--help')) {
  process.stdout.write('Set DATABASE_ADMIN_URL, MIGRATION_DATABASE_URL and DATABASE_URL for the same database and three distinct dedicated roles. WARNING: provisioning changes the named existing roles passwords, privileges and memberships CLUSTER-WIDE, not only in this database. Never use shared roles. Passwords belong only in protected deployment environment, never argv. URLs require explicit credentials; only application_name and sslmode=disable|verify-full query options are supported, without duplicates. Other query options are rejected. Run db:provision, then db:migrate. Start the service with DATABASE_URL only.\n');
} else {
  let db: ReturnType<typeof createDb> | undefined;
  try {
    const admin = process.env['DATABASE_ADMIN_URL'], migration = process.env['MIGRATION_DATABASE_URL'], runtime = process.env['DATABASE_URL'];
    if (!admin || !migration || !runtime) throw new Error('DATABASE_ROLE_CONFIGURATION_REQUIRED');
    const roles = roleConnections(admin, migration, runtime);
    db = createDb(admin);
    await provisionDatabase(db.pool, roles);
    process.stdout.write('database_roles_provisioned\n');
  } catch { process.stderr.write('Database role provisioning failed; check the protected administrator/owner/runtime configuration.\n'); process.exitCode = 1; }
  finally { if (db) await closeDb(db); }
}
