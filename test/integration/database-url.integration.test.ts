import { spawn } from 'node:child_process';
import { expect, it } from 'vitest';
import { createDb, closeDb } from '../../src/db/client.js';
import { parseDatabaseConnection } from '../../src/db/connection.js';
import { integrationDatabaseUrl, integrationOwnerUrl, assertIsTaskDatabase } from '../helpers/identity.js';

it('A-DB01 provisions/migrates dedicated task roles with safe query options and connects as restricted runtime', async () => {
  const runtime = integrationDatabaseUrl(), owner = integrationOwnerUrl(), admin = process.env.DATABASE_ADMIN_URL;
  if (!admin) throw new Error('TASK_ADMIN_REQUIRED'); assertIsTaskDatabase(admin);
  const query = (url: string, name: string) => `${url}?sslmode=disable&application_name=${name}`;
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, DATABASE_ADMIN_URL: query(admin, 'url-admin'), MIGRATION_DATABASE_URL: query(owner, 'url-owner'), DATABASE_URL: query(runtime, 'url-runtime'), PUBLIC_ORIGIN: 'http://127.0.0.1:3000', COOKIE_MODE: 'loopback' };
  for (const [args, marker] of [[['dist/cli/provision-database.js'], 'database_roles_provisioned'], [['dist/server.js', 'migrate'], 'schema_version=2']] as const) {
    const child = spawn(process.execPath, [...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; child.stdout.on('data', (chunk) => { out += chunk; }); child.stderr.on('data', (chunk) => { err += chunk; });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    expect(code).toBe(0); expect(err).toBe(''); expect(out).toContain(marker);
  }
  for (const [url, name] of [[runtime, 'nb-search-cloud'], [env.DATABASE_URL, 'url-runtime']]) {
    const db = createDb(url!);
    try {
      const row = (await db.pool.query("SELECT current_user AS role,current_database() AS database,current_setting('application_name') AS application_name,rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user")).rows[0];
      const parsed = parseDatabaseConnection(runtime);
      expect(row).toEqual({ role: parsed.user, database: parsed.database, application_name: name, rolsuper: false, rolcreatedb: false, rolcreaterole: false });
      expect((await db.pool.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public' AND tableowner=current_user")).rows[0].n).toBe(0);
      await expect(db.pool.query('CREATE TABLE public.runtime_must_not_create(id integer)')).rejects.toMatchObject({ code: '42501' });
    } finally { await closeDb(db); }
  }
});
