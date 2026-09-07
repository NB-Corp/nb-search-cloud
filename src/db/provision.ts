import type { Pool } from 'pg';
import { parseDatabaseConnection, sameDatabaseTarget } from './connection.js';

export interface DatabaseRoles { owner: { name: string; password: string }; runtime: { name: string; password: string } }
export function roleConnections(adminUrl: string, migrationUrl: string, runtimeUrl: string): DatabaseRoles {
  const connections = [adminUrl, migrationUrl, runtimeUrl].map(parseDatabaseConnection);
  if (connections.some((connection) => !sameDatabaseTarget(connection, connections[0]!))) throw new Error('DATABASE_ROLE_TARGET_MISMATCH');
  const roles = connections.slice(1).map(({ user, password }) => ({ name: user, password }));
  if (roles.some((role) => !/^[a-z][a-z0-9_]{0,62}$/.test(role.name) || role.password.length < 12) || roles[0]!.name === roles[1]!.name || roles.some((role) => role.name === connections[0]!.user)) throw new Error('DISTINCT_DATABASE_ROLES_REQUIRED');
  return { owner: roles[0]!, runtime: roles[1]! };
}

export function migrationConnections(migrationUrl: string, runtimeUrl: string) {
  const migration = parseDatabaseConnection(migrationUrl), runtime = parseDatabaseConnection(runtimeUrl);
  if (!sameDatabaseTarget(migration, runtime) || migration.user === runtime.user) throw new Error('MIGRATION_OWNER_REQUIRED');
  return { migration, runtime };
}

/** Explicit administrator operation using dedicated roles only. Existing named roles have their
 * passwords, privileges and memberships changed CLUSTER-WIDE, not only in this database.
 * Database/schema grants target the configured database. Never run from the HTTP server. */
export async function provisionDatabase(admin: Pool, roles: DatabaseRoles): Promise<void> {
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL password_encryption='scram-sha-256'");
    await client.query(`CREATE OR REPLACE FUNCTION pg_temp.nbcloud_role(role_name text, role_password text) RETURNS void LANGUAGE plpgsql AS $$
      DECLARE inherited text;
      BEGIN
        IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN EXECUTE format('CREATE ROLE %I',role_name); END IF;
        EXECUTE format('ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD %L',role_name,role_password);
        FOR inherited IN SELECT parent.rolname FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid JOIN pg_roles child ON child.oid=m.member WHERE child.rolname=role_name LOOP
          EXECUTE format('REVOKE %I FROM %I',inherited,role_name);
        END LOOP;
      END $$`);
    await client.query('SELECT pg_temp.nbcloud_role($1,$2)', [roles.owner.name, roles.owner.password]);
    await client.query('SELECT pg_temp.nbcloud_role($1,$2)', [roles.runtime.name, roles.runtime.password]);
    await client.query(`CREATE OR REPLACE FUNCTION pg_temp.nbcloud_database_roles(owner_name text, runtime_name text) RETURNS void LANGUAGE plpgsql AS $$
      BEGIN
        EXECUTE format('ALTER DATABASE %I OWNER TO %I',current_database(),owner_name);
        EXECUTE format('ALTER SCHEMA public OWNER TO %I',owner_name);
        EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC',current_database());
        EXECUTE format('REVOKE ALL ON DATABASE %I FROM %I',current_database(),runtime_name);
        EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I',current_database(),runtime_name);
        REVOKE ALL ON SCHEMA public FROM PUBLIC;
        EXECUTE format('REVOKE ALL ON SCHEMA public FROM %I',runtime_name);
        EXECUTE format('GRANT USAGE ON SCHEMA public TO %I',runtime_name);
      END $$`);
    await client.query('SELECT pg_temp.nbcloud_database_roles($1,$2)', [roles.owner.name, roles.runtime.name]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}

/** Reapply after every owner-run migration. Runtime has DML, never ownership, DDL, or ledger writes. */
export async function grantRuntimeAccess(owner: Pool, runtimeRole: string): Promise<void> {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(runtimeRole)) throw new Error('INVALID_RUNTIME_ROLE');
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    const identity = (await client.query<{ current_user: string }>('SELECT current_user')).rows[0]!;
    if (identity.current_user === runtimeRole) throw new Error('DISTINCT_DATABASE_ROLES_REQUIRED');
    await client.query(`CREATE OR REPLACE FUNCTION pg_temp.nbcloud_runtime_grants(runtime_name text) RETURNS void LANGUAGE plpgsql AS $$
      BEGIN
        REVOKE ALL ON SCHEMA public FROM PUBLIC;
        EXECUTE format('REVOKE ALL ON SCHEMA public FROM %I',runtime_name);
        EXECUTE format('GRANT USAGE ON SCHEMA public TO %I',runtime_name);
        REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
        EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I',runtime_name);
        EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO %I',runtime_name);
        IF to_regclass('public.schema_migrations') IS NOT NULL THEN
          EXECUTE format('REVOKE INSERT,UPDATE,DELETE ON public.schema_migrations FROM %I',runtime_name);
        END IF;
        EXECUTE format('GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO %I',runtime_name);
        REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
        EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO %I',runtime_name);
        ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
        EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO %I',runtime_name);
        ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
        EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO %I',runtime_name);
      END $$`);
    await client.query('SELECT pg_temp.nbcloud_runtime_grants($1)', [runtimeRole]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}
