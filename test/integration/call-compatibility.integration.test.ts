import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createDb, closeDb, type DbHandle } from '../../src/db/client.js';
import { executionService } from '../../src/execution/service.js';
import { integrationDatabaseUrl, prepareIntegrationDatabase, seedUser, TEST_ORIGIN as origin } from '../helpers/identity.js';
let db: DbHandle, app: ReturnType<typeof buildApp>, tenant: string, user: string;
let headers: Record<string, string>;
const password = 'Only-local-call-compatibility-123';
async function login() {
  const r = await app.inject({ method: 'POST', url: '/api/admin/auth/login', headers: { origin }, payload: { tenant: `compat-${tenant}`, username: 'admin', password } });
  expect(r.statusCode).toBe(200);
  return { origin, cookie: String(r.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': r.json().data.csrf_token as string };
}
async function create(path: string, payload: object) {
  const r = await app.inject({ method: 'POST', url: `/api/admin/${path}`, headers, payload });
  expect(r.statusCode).toBe(201); return r.json().data;
}
beforeAll(async () => {
  await prepareIntegrationDatabase(); db = createDb(integrationDatabaseUrl());
  tenant = randomUUID(); user = randomUUID();
  await db.pool.query('INSERT INTO tenants(id,slug,name) VALUES($1,$2,$2)', [tenant, `compat-${tenant}`]);
  await seedUser(db, { tenantId: tenant, userId: user, username: 'admin', password, role: 'admin' });
  app = buildApp({ db, env: { DATABASE_URL: integrationDatabaseUrl(), PUBLIC_ORIGIN: origin, COOKIE_MODE: 'loopback' }, registerAdditionalRoutes: executionService(db, {}).register });
  await app.ready(); headers = await login();
});
afterAll(async () => { await app?.close(); if (db) await closeDb(db); });
for (const legacy of [false, true]) {
  const body = legacy ? { payload: {} } : {};
  it(`accepts ${legacy ? 'legacy {}' : 'no body or Content-Type'} for all five payload-free actions`, async () => {
    const group = await create('groups', { name: `compat-group-${legacy}` });
    const { key } = await create('keys', { name: 'compat-key', group_id: group.id });
    const provider = await create('providers', { name: `compat-provider-${legacy}`, provider_id: 'exa' });
    const job = randomUUID();
    // A queued storage fixture; this test covers HTTP cancellation, not quota admission.
    await db.pool.query("INSERT INTO jobs(id,tenant_id,user_id,group_id,admitting_key_id,kind,delivery,state,first_plan,selection,request_id) VALUES($1,$2,$3,$4,$5,'search','async','queued','{\"selected\":[]}','{}','compat')", [job, tenant, user, group.id, key.id]);
    const cancelled = await app.inject({ method: 'POST', url: `/api/admin/jobs/${job}/cancel`, headers, ...body });
    expect(cancelled.statusCode).toBe(200);
    expect((await db.pool.query('SELECT state FROM jobs WHERE id=$1', [job])).rows[0].state).toBe('cancelled');
    for (const [kind, id] of [['keys', key.id], ['providers', provider.id], ['groups', group.id]]) {
      const r = await app.inject({ method: 'DELETE', url: `/api/admin/${kind}/${id}`, headers, ...body });
      expect(r.statusCode).toBe(200);
    }
    const logoutHeaders = await login();
    const logout = await app.inject({ method: 'POST', url: '/api/admin/auth/logout', headers: logoutHeaders, ...body });
    expect(logout.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/admin/auth/session', headers: logoutHeaders })).statusCode).toBe(401);
  });
}
it('keeps no-body auth, Origin, CSRF, and supplied-body schema validation', async () => {
  const group = await create('groups', { name: 'retained' });
  const targets = [
    { method: 'DELETE' as const, url: `/api/admin/groups/${group.id}` },
    { method: 'DELETE' as const, url: `/api/admin/keys/${randomUUID()}` },
    { method: 'DELETE' as const, url: `/api/admin/providers/${randomUUID()}` },
    { method: 'POST' as const, url: `/api/admin/jobs/${randomUUID()}/cancel` },
    { method: 'POST' as const, url: '/api/admin/auth/logout' },
  ];
  for (const target of targets) {
    expect((await app.inject({ ...target, headers: { origin } })).statusCode).toBe(401);
    expect((await app.inject({ ...target, headers: { ...headers, origin: 'https://wrong.example' } })).statusCode).toBe(403);
    expect((await app.inject({ ...target, headers: { cookie: headers.cookie!, 'x-csrf-token': headers['x-csrf-token']! } })).statusCode).toBe(403);
    expect((await app.inject({ ...target, headers: { ...headers, authorization: 'Bearer fake-mixed-auth' } })).statusCode).toBe(401);
    expect((await app.inject({ ...target, headers: { ...headers, 'content-type': 'application/json' }, payload: '{' })).statusCode).toBe(422);
    expect((await app.inject({ ...target, headers: { cookie: headers.cookie!, origin } })).statusCode).toBe(403);
    // Group DELETE historically ignores its JSON body; do not invent a new schema gate.
    if (!target.url.startsWith('/api/admin/groups/')) for (const payload of [{ unexpected: true }, null, []]) {
      expect((await app.inject({ ...target, headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify(payload) })).statusCode).toBe(422);
    }
    expect((await app.inject({ ...target, headers: { ...headers, 'content-type': 'text/plain' }, payload: '{}' })).statusCode).toBe(422);
  }
  expect((await db.pool.query('SELECT deleted_at FROM groups WHERE id=$1', [group.id])).rows[0].deleted_at).toBeNull();
  for (const url of ['/api/admin/groups', '/api/admin/providers', '/api/admin/keys', '/api/admin/auth/login']) {
    expect((await app.inject({ method: 'POST', url, headers })).statusCode).toBe(422);
    expect((await app.inject({ method: 'POST', url, headers, payload: {} })).statusCode).toBe(422);
  }
});
it('preserves group DELETE ignoring supplied JSON rather than adding a new schema gate', async () => {
  const group = await create('groups', { name: 'ignored-delete-payload' });
  const result = await app.inject({ method: 'DELETE', url: `/api/admin/groups/${group.id}`, headers, payload: { name: 'not-a-patch', status: 'active' } });
  expect(result.statusCode).toBe(200);
  expect(result.json().data).toMatchObject({ name: 'ignored-delete-payload', status: 'disabled' });
});
it('retains owner, administrator and tenant isolation for bodyless actions', async () => {
  const group = await create('groups', { name: 'ownership' });
  const { key } = await create('keys', { name: 'admin-owned', group_id: group.id });
  const provider = await create('providers', { name: 'ownership-provider', provider_id: 'exa' });
  await seedUser(db, { tenantId: tenant, userId: randomUUID(), username: 'member', password });
  const login = await app.inject({ method: 'POST', url: '/api/admin/auth/login', headers: { origin }, payload: { tenant: `compat-${tenant}`, username: 'member', password } });
  expect(login.statusCode).toBe(200);
  const member = { origin, cookie: String(login.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': login.json().data.csrf_token };
  const job = randomUUID();
  await db.pool.query("INSERT INTO jobs(id,tenant_id,user_id,group_id,admitting_key_id,kind,delivery,state,first_plan,selection,request_id) VALUES($1,$2,$3,$4,$5,'search','async','queued','{\"selected\":[]}','{}','compat-owner')", [job, tenant, user, group.id, key.id]);
  for (const [kind, id] of [['keys', key.id], ['groups', group.id], ['providers', provider.id]]) {
    expect((await app.inject({ method: 'DELETE', url: `/api/admin/${kind}/${id}`, headers: member })).statusCode).toBe(403);
  }
  expect((await app.inject({ method: 'POST', url: `/api/admin/jobs/${job}/cancel`, headers: member })).statusCode).toBe(404);
  expect((await db.pool.query('SELECT state FROM jobs WHERE id=$1', [job])).rows[0].state).toBe('queued');
  expect((await db.pool.query('SELECT deleted_at FROM api_keys WHERE id=$1', [key.id])).rows[0].deleted_at).toBeNull();
  const foreignTenant = randomUUID(), foreignGroup = randomUUID();
  await db.pool.query('INSERT INTO tenants(id,slug,name) VALUES($1,$2,$2)', [foreignTenant, `compat-${foreignTenant}`]);
  await db.pool.query("INSERT INTO groups(id,tenant_id,name) VALUES($1,$2,'foreign')", [foreignGroup, foreignTenant]);
  expect((await app.inject({ method: 'DELETE', url: `/api/admin/groups/${foreignGroup}`, headers })).statusCode).toBe(404);
  expect((await db.pool.query('SELECT deleted_at FROM groups WHERE id=$1', [foreignGroup])).rows[0].deleted_at).toBeNull();
});
it('defaults missing protocol to v1, accepts explicit 1, rejects explicit 2, and retains bearer auth/schema', async () => {
  const group = await create('groups', { name: 'protocol' });
  const key = await create('keys', { name: 'protocol-key', group_id: group.id });
  for (const protocol of [undefined, '1', '2']) {
    const h = { authorization: `Bearer ${key.access_key}`, ...(protocol === undefined ? {} : { 'x-nb-search-protocol': protocol }) };
    const r = await app.inject({ method: 'POST', url: '/v1/capabilities', headers: h, payload: {} });
    expect(r.headers['x-nb-search-protocol']).toBe('1');
    expect(r.statusCode).toBe(protocol === '2' ? 426 : 200);
    if (protocol === '2') expect(r.json().error.code).toBe('PROTOCOL_UNSUPPORTED');
  }
  expect((await app.inject({ method: 'POST', url: '/v1/capabilities', payload: {} })).statusCode).toBe(401);
  expect((await app.inject({ method: 'POST', url: '/v1/search', headers: { authorization: `Bearer ${key.access_key}` }, payload: {} })).statusCode).toBe(400);
});
