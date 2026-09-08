import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { authenticateServiceKey, serviceKeyGroupAvailable } from '../../src/auth/api-key.js';
import { createDb, closeDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { consumeRateLimit, subjectHash } from '../../src/auth/rate-limit.js';
import { loadEnv, type CloudEnv } from '../../src/env.js';
import { AppError } from '../../src/errors.js';
import { seedUser, integrationDatabaseUrl, integrationOwnerUrl, prepareIntegrationDatabase, assertIsTaskDatabase, TEST_ORIGIN } from '../helpers/identity.js';

interface LoginResult { cookie: string; csrf: string; user: Record<string, unknown> }

let db: DbHandle;
let env: CloudEnv;
let app: ReturnType<typeof buildApp>;
let tenantA: string;
let tenantB: string;
let tenantC: string;
let adminA: string;
let adminA2: string;
let bob: string;
let adminB: string;
let adminC: string;
let adminD: string;
let adminC1: string;
let adminC2: string;

async function login(tenant: string, username: string, password: string): Promise<LoginResult> {
  const response = await app.inject({ method: 'POST', url: '/api/admin/auth/login', headers: { origin: TEST_ORIGIN, 'content-type': 'application/json' }, payload: { tenant, username, password } });
  expect(response.statusCode).toBe(200);
  const body = response.json() as { data: { csrf_token: string; user: Record<string, unknown> } };
  return { cookie: String(response.headers['set-cookie']).split(';')[0]!, csrf: body.data.csrf_token, user: body.data.user };
}

function mutationHeaders(session: LoginResult): Record<string, string> {
  return { cookie: session.cookie, origin: TEST_ORIGIN, 'content-type': 'application/json', 'x-csrf-token': session.csrf };
}

async function createTenant(id: string, slug: string): Promise<void> {
  await db.pool.query('INSERT INTO tenants(id,slug,name,status) VALUES($1,$2,$2,\'active\')', [id, slug]);
}

describe('Stage A real PostgreSQL identity foundation', () => {
  beforeAll(async () => {
    const url = integrationDatabaseUrl();
    assertIsTaskDatabase(url);
    env = loadEnv({ DATABASE_URL: url, PUBLIC_ORIGIN: TEST_ORIGIN, COOKIE_MODE: 'loopback', HOST: '127.0.0.1', PORT: '3000', NODE_ENV: 'test' });
    db = createDb(env.databaseUrl, { max: 12 });
    await prepareIntegrationDatabase(true);
    tenantA = randomUUID();
    tenantB = randomUUID();
    tenantC = randomUUID();
    adminA = randomUUID();
    adminA2 = randomUUID();
    bob = randomUUID();
    adminB = randomUUID();
    adminC = randomUUID();
    adminD = randomUUID();
    adminC1 = randomUUID();
    adminC2 = randomUUID();
    await createTenant(tenantA, 'team-a');
    await createTenant(tenantB, 'team-b');
    await createTenant(tenantC, 'team-c');
    await seedUser(db, { tenantId: tenantA, userId: adminA, username: 'admin', password: 'Task18-Admin!2026', role: 'admin' });
    await seedUser(db, { tenantId: tenantA, userId: adminA2, username: 'admin-two', password: 'Task18-Admin2!2026', role: 'admin' });
    await seedUser(db, { tenantId: tenantA, userId: adminC, username: 'admin-three', password: 'Task18-Admin3!2026', role: 'admin' });
    await seedUser(db, { tenantId: tenantA, userId: adminD, username: 'admin-four', password: 'Task18-Admin4!2026', role: 'admin' });
    await seedUser(db, { tenantId: tenantA, userId: bob, username: 'bob', password: 'Task18-Bob!2026', role: 'user', restrictPublicGroups: true });
    await seedUser(db, { tenantId: tenantB, userId: adminB, username: 'admin', password: 'Task18-Other!2026', role: 'admin' });
    await seedUser(db, { tenantId: tenantC, userId: adminC1, username: 'admin', password: 'Task18-TeamC1!2026', role: 'admin' });
    await seedUser(db, { tenantId: tenantC, userId: adminC2, username: 'admin-two', password: 'Task18-TeamC2!2026', role: 'admin' });
    app = buildApp({ env, db });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    if (db) await closeDb(db);
  });

  it('runs the identity migration twice without changing the schema', async () => {
    const owner = createDb(integrationOwnerUrl());
    try { await expect(runMigrations(owner.pool)).resolves.toBe(4); } finally { await closeDb(owner); }
    const result = await db.pool.query<{ count: string }>('SELECT count(*)::text AS count FROM schema_migrations WHERE version=1');
    expect(result.rows[0]?.count).toBe('1');
    const tables = await db.pool.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('tenants','users','groups','user_allowed_groups','api_keys','sessions','auth_rate_buckets','audit_events') ORDER BY table_name");
    expect(tables.rows).toHaveLength(8);
  });

  it('uses an atomic concurrent limiter without skipping over the configured bound', async () => {
    const subject = `rate-${randomUUID()}`;
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => consumeRateLimit(db.pool, { scope: 'service', subject, limit: 3, windowMs: 60_000, now: new Date('2026-01-01T00:00:10.000Z') })));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(3);
    expect(results.filter((result) => result.status === 'rejected' && result.reason instanceof AppError && result.reason.code === 'RATE_LIMITED')).toHaveLength(9);
    const bucket = await db.pool.query<{ count: number }>('SELECT count FROM auth_rate_buckets WHERE scope=$1 AND subject_hash=$2', ['service', subjectHash('service', subject)]);
    expect(bucket.rows[0]?.count).toBe(12);
  });

  it('enforces strict Origin, JSON, and distinct browser credentials', async () => {
    const live = await app.inject({ method: 'GET', url: '/health/live' });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ status: 'ok' });
    const ready = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: 'ready' });
    const missingOrigin = await app.inject({ method: 'POST', url: '/api/admin/auth/login', headers: { 'content-type': 'application/json' }, payload: { tenant: 'team-a', username: 'admin', password: 'bad-password-value' } });
    expect(missingOrigin.statusCode).toBe(403);
    const wrongOrigin = await app.inject({ method: 'POST', url: '/api/admin/auth/login', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, payload: { tenant: 'team-a', username: 'admin', password: 'bad-password-value' } });
    expect(wrongOrigin.statusCode).toBe(403);
    const wrongPassword = await app.inject({ method: 'POST', url: '/api/admin/auth/login', headers: { origin: TEST_ORIGIN, 'content-type': 'application/json' }, payload: { tenant: 'team-a', username: 'admin', password: 'wrong-password-value' } });
    expect(wrongPassword.statusCode).toBe(401);
    const session = await login('team-a', 'admin', 'Task18-Admin!2026');
    const bearer = await app.inject({ method: 'GET', url: '/api/admin/auth/session', headers: { cookie: session.cookie, authorization: 'Bearer nbc_invalid', origin: TEST_ORIGIN } });
    expect(bearer.statusCode).toBe(401);
    const nonJson = await app.inject({ method: 'POST', url: '/api/admin/groups', headers: { ...mutationHeaders(session), 'content-type': 'text/plain' }, payload: 'not-json' });
    expect(nonJson.statusCode).toBe(422);
    const noCsrf = await app.inject({ method: 'POST', url: '/api/admin/groups', headers: { cookie: session.cookie, origin: TEST_ORIGIN, 'content-type': 'application/json' }, payload: { name: 'no-csrf' } });
    expect(noCsrf.statusCode).toBe(403);
  });

  it('preserves User to Groups to one-key semantics and live group authorization', async () => {
    const admin = await login('team-a', 'admin', 'Task18-Admin!2026');
    let response = await app.inject({ method: 'POST', url: '/api/admin/groups', headers: mutationHeaders(admin), payload: { name: 'public', is_exclusive: false } });
    expect(response.statusCode).toBe(201);
    const publicGroup = response.json().data as { id: string; revision: number };
    response = await app.inject({ method: 'POST', url: '/api/admin/groups', headers: mutationHeaders(admin), payload: { name: 'exclusive', is_exclusive: true } });
    expect(response.statusCode).toBe(201);
    const exclusiveGroup = response.json().data as { id: string; revision: number };
    response = await app.inject({ method: 'POST', url: '/api/admin/users', headers: mutationHeaders(admin), payload: { username: 'new-user', display_name: 'New user', password: 'Task18-NewUser!2026', restrict_public_groups: true } });
    expect(response.statusCode).toBe(201);
    const newUser = response.json().data as { id: string };
    response = await app.inject({ method: 'PUT', url: `/api/admin/users/${newUser.id}/allowed-groups`, headers: mutationHeaders(admin), payload: { group_ids: [exclusiveGroup.id] } });
    expect(response.statusCode).toBe(200);
    response = await app.inject({ method: 'POST', url: '/api/admin/keys', headers: mutationHeaders(admin), payload: { user_id: newUser.id, name: 'one-key', group_id: exclusiveGroup.id, quota_units: 0, expires_at: null } });
    expect(response.statusCode).toBe(201);
    const issued = response.json().data as { key: { id: string; quota_units: number; expires_at: null }; access_key: string };
    expect(issued.access_key).toMatch(/^nbc_/);
    const keyId = issued.key.id;
    response = await app.inject({ method: 'GET', url: '/api/admin/keys', headers: { cookie: admin.cookie, origin: TEST_ORIGIN } });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(issued.access_key);
    expect(response.body).not.toContain('token_hash');
    response = await app.inject({ method: 'PATCH', url: `/api/admin/keys/${keyId}`, headers: mutationHeaders(admin), payload: { expected_revision: 1, quota_units: 100, expires_at: '2030-01-01T00:00:00.000Z', group_id: publicGroup.id } });
    expect(response.statusCode).toBe(403);
    response = await app.inject({ method: 'PATCH', url: `/api/admin/keys/${keyId}`, headers: mutationHeaders(admin), payload: { expected_revision: 1, quota_units: 0, expires_at: null } });
    expect(response.statusCode).toBe(200);
    const updated = response.json().data as { revision: number; quota_units: number; expires_at: null };
    expect(updated.revision).toBe(2);
    expect(updated.quota_units).toBe(0);
    expect(updated.expires_at).toBeNull();
    response = await app.inject({ method: 'DELETE', url: `/api/admin/groups/${exclusiveGroup.id}`, headers: mutationHeaders(admin), payload: {} });
    expect(response.statusCode).toBe(200);
    const serviceRequest = { headers: { authorization: `Bearer ${issued.access_key}` }, cookies: {} } as never;
    const servicePrincipal = await authenticateServiceKey(serviceRequest, db, env);
    expect(await serviceKeyGroupAvailable(db, servicePrincipal)).toBe(false);
    response = await app.inject({ method: 'PATCH', url: `/api/admin/keys/${keyId}`, headers: mutationHeaders(admin), payload: { expected_revision: 2, group_id: publicGroup.id } });
    expect(response.statusCode).toBe(403);
    response = await app.inject({ method: 'DELETE', url: `/api/admin/keys/${keyId}`, headers: mutationHeaders(admin), payload: {} });
    expect(response.statusCode).toBe(200);
    response = await app.inject({ method: 'PATCH', url: `/api/admin/keys/${keyId}`, headers: mutationHeaders(admin), payload: { expected_revision: 3, status: 'active' } });
    expect(response.statusCode).toBe(404);
  });

  it('revokes sessions on disable and does not resurrect them on re-enable', async () => {
    const admin = await login('team-a', 'admin-three', 'Task18-Admin3!2026');
    const created = await app.inject({ method: 'POST', url: '/api/admin/users', headers: mutationHeaders(admin), payload: { username: 'toggle-user', display_name: 'Toggle user', password: 'Task18-Toggle!2026' } });
    expect(created.statusCode).toBe(201);
    const toggleId = (created.json() as { data: { id: string } }).data.id;
    const userSession = await login('team-a', 'toggle-user', 'Task18-Toggle!2026');
    let response = await app.inject({ method: 'PATCH', url: `/api/admin/users/${toggleId}`, headers: mutationHeaders(admin), payload: { status: 'disabled' } });
    expect(response.statusCode).toBe(200);
    response = await app.inject({ method: 'GET', url: '/api/admin/auth/session', headers: { cookie: userSession.cookie, origin: TEST_ORIGIN } });
    expect(response.statusCode).toBe(401);
    response = await app.inject({ method: 'PATCH', url: `/api/admin/users/${toggleId}`, headers: mutationHeaders(admin), payload: { status: 'active' } });
    expect(response.statusCode).toBe(200);
    response = await app.inject({ method: 'GET', url: '/api/admin/auth/session', headers: { cookie: userSession.cookie, origin: TEST_ORIGIN } });
    expect(response.statusCode).toBe(401);
  });

  it('does not commit two concurrent changes that would remove the last active admin', async () => {
    const first = await login('team-c', 'admin', 'Task18-TeamC1!2026');
    const second = await login('team-c', 'admin-two', 'Task18-TeamC2!2026');
    const results = await Promise.all([
      app.inject({ method: 'PATCH', url: `/api/admin/users/${adminC1}`, headers: mutationHeaders(first), payload: { status: 'disabled' } }),
      app.inject({ method: 'PATCH', url: `/api/admin/users/${adminC2}`, headers: mutationHeaders(second), payload: { role: 'user' } }),
    ]);
    expect(results.map((item) => item.statusCode).sort()).toEqual([200, 409]);
    const admins = await db.pool.query<{ count: string }>("SELECT count(*)::text AS count FROM users WHERE tenant_id=$1 AND role='admin' AND status='active'", [tenantC]);
    expect(Number(admins.rows[0]?.count)).toBeGreaterThanOrEqual(1);
  });

  it('revokes old sessions when a password version changes', async () => {
    const bobSession = await login('team-a', 'bob', 'Task18-Bob!2026');
    const admin = await login('team-a', 'admin-three', 'Task18-Admin3!2026');
    const reset = await app.inject({ method: 'POST', url: `/api/admin/users/${bob}/password`, headers: mutationHeaders(admin), payload: { password: 'Task18-Bob-New!2026' } });
    expect(reset.statusCode).toBe(200);
    const old = await app.inject({ method: 'GET', url: '/api/admin/auth/session', headers: { cookie: bobSession.cookie, origin: TEST_ORIGIN } });
    expect(old.statusCode).toBe(401);
    const fresh = await login('team-a', 'bob', 'Task18-Bob-New!2026');
    expect(fresh.user['id']).toBe(bob);
  });

  it('keeps tenants and same usernames isolated with composite identity keys', async () => {
    const a = await login('team-a', 'admin-four', 'Task18-Admin4!2026');
    const b = await login('team-b', 'admin', 'Task18-Other!2026');
    expect(a.user['id']).not.toBe(b.user['id']);
    const foreignGroup = await db.pool.query<{ id: string }>('SELECT id FROM groups WHERE tenant_id=$1 LIMIT 1', [tenantA]);
    const response = await app.inject({ method: 'GET', url: `/api/admin/groups/${foreignGroup.rows[0]?.id ?? randomUUID()}`, headers: { cookie: b.cookie, origin: TEST_ORIGIN } });
    expect(response.statusCode).toBe(404);
    const crossTenant = await db.pool.query('INSERT INTO api_keys(id,tenant_id,user_id,group_id,name,token_hash,prefix) VALUES($1,$2,$3,$4,$5,$6,$7)', [randomUUID(), tenantB, adminB, foreignGroup.rows[0]?.id ?? randomUUID(), 'bad', Buffer.alloc(32), 'nbc_12345678']).catch((error: unknown) => error);
    expect(crossTenant).toMatchObject({ code: '23503' });
  });
});
