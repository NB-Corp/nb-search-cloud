import { expect, it } from 'vitest';
import { migrationConnections, roleConnections } from '../../src/db/provision.js';
import { parseDatabaseConnection } from '../../src/db/connection.js';
import { loadEnv } from '../../src/env.js';
import { createDb, closeDb, type DbHandle } from '../../src/db/client.js';
const urls = ['admin', 'owner', 'runtime'].map((user) => `postgresql://${user}:fixture-password-only@127.0.0.1:55432/nbcloud_test_url`);
const queries = ['host=elsewhere.invalid', 'port=5433', 'user=owner', 'password=other-fixture-password', '%68ost=elsewhere.invalid', '%75ser=owner', 'user=runtime&user=owner', 'HOST=elsewhere.invalid', '%2575ser=owner', 'dbname=other_database', 'p%6frt=5433', 'pass%77ord=other', 'port=5432&port=5433', 'password=first&password=second', 'user=owner&%75ser=runtime', 'host=a.invalid&host=b.invalid', 'sslmode=disable&sslmode=verify-full', 'application_name=a&application_name=b', 'sslmode=require', 'sslrootcert=/fixture-only', 'sslkey=/fixture-only', 'sslcert=/fixture-only', 'options=-csearch_path=other'];
it.each(queries)('A-DB01 rejects query %s in every role URL before provisioning', (query) => {
  for (let index = 0; index < 3; index++) {
    const input = [...urls]; input[index] += `?${query}`;
    expect(() => roleConnections(input[0]!, input[1]!, input[2]!)).toThrow();
  }
});
it.each(queries)('A-DB01 runtime rejects query %s before creating a usable connection', async (query) => {
  let db: DbHandle | undefined;
  try { expect(() => { db = createDb(urls[2]! + `?${query}`); }).toThrow(); }
  finally { if (db) await closeDb(db); }
});
it('compares and connects explicit decoded fields, without connectionString or identity fallbacks', async () => {
  const raw = 'postgresql://runtime:fixture%40password@LOCALHOST/nbcloud%5ftest_url?application_name=fixture.app&sslmode=verify-full';
  const parsed = parseDatabaseConnection(raw);
  expect(parsed).toEqual({ host: 'localhost', port: 5432, user: 'runtime', password: 'fixture@password', database: 'nbcloud_test_url', application_name: 'fixture.app', ssl: { rejectUnauthorized: true } });
  const db = createDb(raw);
  try { expect(db.pool.options).toMatchObject(parsed); expect(db.pool.options).not.toHaveProperty('connectionString'); }
  finally { await closeDb(db); }
  const owner = 'postgres://owner:fixture-password-only@localhost:5432/nbcloud_test_url?sslmode=disable';
  expect(migrationConnections(owner, raw).runtime.user).toBe('runtime');
  expect(() => migrationConnections(raw, raw)).toThrow('MIGRATION_OWNER_REQUIRED');
  expect(() => migrationConnections(owner.replace('5432', '5433'), raw)).toThrow('MIGRATION_OWNER_REQUIRED');
  expect(() => createDb(raw, { host: 'elsewhere.invalid' } as never)).toThrow('INVALID_DATABASE_POOL_OPTIONS');
});
it('validates migration/runtime configuration before use and rejects implicit credentials', () => {
  for (const query of queries) {
    expect(() => migrationConnections(urls[1]! + '?' + query, urls[2]!)).toThrow();
    expect(() => migrationConnections(urls[1]!, urls[2]! + '?' + query)).toThrow();
    expect(() => loadEnv({ DATABASE_URL: urls[2]! + '?' + query, PUBLIC_ORIGIN: 'http://localhost:3000', COOKIE_MODE: 'loopback' })).toThrow();
  }
  for (const raw of ['postgres://runtime@localhost/db', 'postgres://:password@localhost/db', 'postgres://runtime:password@/db', urls[2]! + '#fragment']) expect(() => parseDatabaseConnection(raw)).toThrow();
  expect(roleConnections(...urls.map((raw) => raw + '?sslmode=disable&application_name=fixture') as [string,string,string]).runtime.name).toBe('runtime');
});
