import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createDb, closeDb, type DbHandle } from '../../src/db/client.js';
import { getSchemaVersion } from '../../src/db/transaction.js';
import { runMigrations } from '../../src/db/migrate.js';
import { applyExecutionMigration } from '../../src/execution/migrate.js';
import { hashPassword } from '../../src/auth/password.js';
import { loadEnv } from '../../src/env.js';
import { SecretVault } from '../../src/execution/crypto.js';
import { ProviderService } from '../../src/execution/providers.js';
import { ExecutionStore } from '../../src/execution/store.js';
import { registerAdminExecutionRoutes } from '../../src/routes/admin-execution.js';
import { registerAdminUsageRoutes } from '../../src/routes/admin-usage.js';

const origin = 'http://127.0.0.1:3000';
const canary = 'fake-admin-provider-canary-never-return';
let db: DbHandle;
let app: ReturnType<typeof buildApp>;
let tenant: string;
let user: string;
let session: { cookie: string; csrf: string };
const headers = () => ({ cookie: session.cookie, 'x-csrf-token': session.csrf, origin, 'content-type': 'application/json' });

describe('provider/group management API backed by real PG (execution remains unavailable)', () => {
  beforeAll(async () => {
    const raw = process.env['DATABASE_URL']; if (!raw || !['/nbcloud_test_execution', '/nbcloud_test_task18'].includes(new URL(raw).pathname) || new URL(raw).hostname !== '127.0.0.1') throw new Error('DEDICATED_EXECUTION_TEST_DB_REQUIRED');
    await (await import('../helpers/identity.js')).prepareIntegrationDatabase();
    db = createDb(raw);
    tenant = randomUUID(); user = randomUUID();
    const password = 'Fake-admin-password-123';
    const hash = await hashPassword(password);
    await db.pool.query('INSERT INTO tenants(id,slug,name) VALUES($1,$2,$2)', [tenant, `t-${tenant}`]);
    await db.pool.query("INSERT INTO users(id,tenant_id,username,display_name,role,password_hash) VALUES($1,$2,'admin','Admin','admin',$3)", [user, tenant, hash]);
    const providers = new ProviderService('management-only-fixture', new SecretVault('fake-management-key', randomBytes(32).toString('base64')), () => undefined);
    const store = new ExecutionStore(db, 'management-only-fixture', () => false);
    app = buildApp({ db, env: loadEnv({ DATABASE_URL: raw, PUBLIC_ORIGIN: origin, COOKIE_MODE: 'loopback', HOST: '127.0.0.1', PORT: '3000', NODE_ENV: 'test' }), registerAdditionalRoutes: (a) => { registerAdminExecutionRoutes(a, providers, store, () => false); registerAdminUsageRoutes(a, store); } });
    await app.ready();
    const login = await app.inject({ method: 'POST', url: '/api/admin/auth/login', headers: { origin, 'content-type': 'application/json' }, payload: { tenant: `t-${tenant}`, username: 'admin', password } });
    expect(login.statusCode).toBe(200);
    session = { cookie: String(login.headers['set-cookie']).split(';')[0]!, csrf: login.json().data.csrf_token };
  });
  afterAll(async () => { await app?.close(); if (db) await closeDb(db); });
  it('provides admin write-only secret CRUD, immutable rotation, and unavailable group capabilities without a CLI', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { logs.push(String(chunk)); return true; });
    try {
      let response = await app.inject({ method: 'POST', url: '/api/admin/providers', headers: headers(), payload: { name: 'configured exa', provider_id: 'exa', secret: canary } });
      expect(response.statusCode).toBe(201); expect(response.body).not.toContain(canary);
      const provider = response.json().data;
      expect(provider.credential_configured).toBe(true);
      response = await app.inject({ method: 'PATCH', url: `/api/admin/providers/${provider.id}`, headers: headers(), payload: { expected_revision: 1, base_url: 'https://configured.example/api' } });
      expect(response.statusCode).toBe(200); expect(response.json().data.credential_configured).toBe(true);
      expect(response.body).not.toContain(canary);
      response = await app.inject({ method: 'POST', url: '/api/admin/lanes', headers: headers(), payload: { id: 'exa.search', provider_id: provider.id, operation_id: 'search', latency: 'fast', cost: 'cheap' } });
      expect(response.statusCode).toBe(201);
      response = await app.inject({ method: 'POST', url: '/api/admin/groups', headers: headers(), payload: { name: 'real group', daily_units_per_user: 3 } });
      expect(response.statusCode).toBe(201); const group = response.json().data;
      response = await app.inject({ method: 'PUT', url: `/api/admin/groups/${group.id}/capabilities`, headers: headers(), payload: { expected_revision: group.revision, lanes: [{ lane_id: 'exa.search', units_per_query: 1 }], default_search_lane: 'exa.search', default_fetch_pipeline: null, presets: { p: ['exa.search'] } } });
      expect(response.statusCode).toBe(200);
      expect(response.json().data.lanes[0]).toMatchObject({ configured: false, effective_execution_modes: [], issues: [{ code: 'CLOUD_EGRESS_UNVERIFIED' }] });
      response = await app.inject({ method: 'GET', url: '/api/admin/me/quotas', headers: headers() });
      expect(response.statusCode).toBe(200); expect(response.json().data.items.find((row: { group_id: string }) => row.group_id === group.id)).toMatchObject({ daily_units_per_user: 3, used_units: 0, reserved_units: 0, remaining_units: 3 });
      response = await app.inject({ method: 'GET', url: '/api/admin/usage', headers: headers() });
      expect(response.statusCode).toBe(200); expect(response.json().data.items).toEqual([]);
      response = await app.inject({ method: 'PATCH', url: `/api/admin/providers/${provider.id}`, headers: headers(), payload: { expected_revision: 2, clear_secret: true } });
      expect(response.statusCode).toBe(200); expect(response.json().data.credential_configured).toBe(false);
      response = await app.inject({ method: 'GET', url: `/api/admin/providers/${provider.id}`, headers: headers() });
      expect(response.statusCode).toBe(200); expect(response.body).not.toContain(canary); expect(response.body).not.toContain('ciphertext');
      const audit = await db.pool.query('SELECT metadata FROM audit_events WHERE tenant_id=$1', [tenant]);
      expect(JSON.stringify(audit.rows)).not.toContain(canary);
      expect(logs.join('')).not.toContain(canary);
    } finally { spy.mockRestore(); }
  });
  it('rejects missing CSRF, service Bearer, unknown configuration fields, and unreviewed operations', async () => {
    let response = await app.inject({ method: 'POST', url: '/api/admin/providers', headers: { origin, cookie: session.cookie, 'content-type': 'application/json' }, payload: { name: 'bad', provider_id: 'exa', secret: canary } });
    expect(response.statusCode).toBe(403);
    response = await app.inject({ method: 'POST', url: '/api/admin/providers', headers: { ...headers(), authorization: 'Bearer nbc_not_a_browser_session' }, payload: { name: 'bad', provider_id: 'exa' } });
    expect(response.statusCode).toBe(401);
    response = await app.inject({ method: 'POST', url: '/api/admin/providers', headers: headers(), payload: { name: 'bad', provider_id: 'exa', options: { code: 'no-code-loading' } } });
    expect(response.statusCode).toBe(422);
    response = await app.inject({ method: 'POST', url: '/api/admin/providers', headers: headers(), payload: { name: 'browser', provider_id: 'browser-render' } });
    expect(response.statusCode).toBe(422);
    expect(response.body).not.toContain(canary);
  });
});
