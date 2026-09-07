import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { PoolClient } from 'pg';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createDb, closeDb, type DbHandle } from '../../src/db/client.js';
import { grantRuntimeAccess, provisionDatabase, roleConnections } from '../../src/db/provision.js';
import { hashPassword } from '../../src/auth/password.js';
import { authenticateServiceKey, serviceKeyGroupAvailable, issueAccessKey } from '../../src/auth/api-key.js';
import { loadEnv } from '../../src/env.js';
import { sendData, sendRequestError } from '../../src/request-context.js';
import { appError } from '../../src/errors.js';
import { prepareIntegrationDatabase, integrationDatabaseUrl, integrationOwnerUrl, TEST_ORIGIN } from '../helpers/identity.js';

let runtime: DbHandle, owner: DbHandle, admin: DbHandle, app: FastifyInstance;
const applicationName = `identity-review-${randomUUID()}`;
const password = 'Fake-password-canary-A-review-2026';
let hash: string;
interface Session { cookie: string; csrf: string; id: string; userId: string; tenantId: string; setCookie: string }
interface Team { id: string; slug: string; adminId: string; secondId: string; memberId: string }
async function team(): Promise<Team> {
  const id = randomUUID(), slug = `t-${id}`, adminId = randomUUID(), secondId = randomUUID(), memberId = randomUUID();
  await owner.pool.query('INSERT INTO tenants(id,slug,name) VALUES($1,$2,$2)', [id, slug]);
  for (const [uid, username, role] of [[adminId, 'admin', 'admin'], [secondId, 'second', 'admin'], [memberId, 'member', 'user']]) await owner.pool.query('INSERT INTO users(id,tenant_id,username,display_name,role,password_hash) VALUES($1,$2,$3,$3,$4,$5)', [uid, id, username, role, hash]);
  return { id, slug, adminId, secondId, memberId };
}
async function login(t: Team, username: 'admin' | 'second' | 'member' = 'admin', application = app, origin = TEST_ORIGIN): Promise<Session> {
  const response = await application.inject({ method: 'POST', url: '/api/admin/auth/login', headers: { origin, 'content-type': 'application/json' }, payload: { tenant: t.slug, username, password } });
  expect(response.statusCode).toBe(200);
  const data = response.json().data;
  const setCookie = String(response.headers['set-cookie']); const cookie = setCookie.split(';')[0]!;
  const token = cookie.slice(cookie.indexOf('=') + 1);
  const row = (await owner.pool.query<{ id: string }>('SELECT id FROM sessions WHERE token_hash=$1', [createHash('sha256').update(token).digest()])).rows[0]!;
  return { cookie, csrf: data.csrf_token, id: row.id, userId: data.user.id, tenantId: t.id, setCookie };
}
function headers(s: Session, requestId = randomUUID()) { return { cookie: s.cookie, origin: TEST_ORIGIN, 'content-type': 'application/json', 'x-csrf-token': s.csrf, 'x-request-id': requestId }; }
async function group(t: Team, exclusive = false): Promise<string> {
  const id = randomUUID(); await owner.pool.query('INSERT INTO groups(id,tenant_id,name,is_exclusive) VALUES($1,$2,$4,$3)', [id, t.id, exclusive, id]); return id;
}
async function key(t: Team, userId: string, groupId: string) {
  const id = randomUUID(), issued = issueAccessKey();
  await owner.pool.query("INSERT INTO api_keys(id,tenant_id,user_id,group_id,name,token_hash,prefix) VALUES($1,$2,$3,$4,'fixture',$5,$6)", [id, t.id, userId, groupId, issued.hash, issued.prefix]);
  return { id, token: issued.accessKey };
}
async function holdTenant(tenantId: string) {
  const tx = await owner.pool.connect(); let open = true;
  await tx.query('BEGIN'); await tx.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [tenantId]);
  const pid = (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  return {
    tx,
    async waitForBlocked(count = 1) {
      const until = Date.now() + 15_000;
      while (Date.now() < until) {
        // Later tuple-lock waiters can block on the first waiter, not directly on the holder.
        // Follow the actual PG wait graph so BOTH requests are proven past their initial checks.
        const rows = await admin.pool.query<{ count: string }>(`WITH RECURSIVE blocked(pid) AS (
          SELECT a.pid FROM pg_stat_activity a WHERE $2=ANY(pg_blocking_pids(a.pid))
          UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=ANY(pg_blocking_pids(a.pid))
        ) SELECT count(*)::text AS count FROM blocked b JOIN pg_stat_activity a ON a.pid=b.pid WHERE a.application_name=$1 AND a.wait_event_type='Lock'`, [applicationName, pid]);
        if (Number(rows.rows[0]!.count) >= count) return;
        await delay(10);
      }
      throw new Error('CONTROLLED_LOCK_BARRIER_NOT_REACHED');
    },
    async commit() { await tx.query('COMMIT'); open = false; tx.release(); },
    async close() { if (open) { await tx.query('ROLLBACK'); open = false; tx.release(); } },
  };
}
async function noSuccessAudit(requestId: string) { expect((await owner.pool.query('SELECT id FROM audit_events WHERE request_id=$1', [requestId])).rows).toHaveLength(0); }

beforeAll(async () => {
  await prepareIntegrationDatabase(false);
  runtime = createDb(integrationDatabaseUrl(), { max: 16, application_name: applicationName });
  owner = createDb(integrationOwnerUrl(), { max: 4 });
  const adminUrl = process.env['DATABASE_ADMIN_URL']; if (!adminUrl) throw new Error('TASK_DATABASE_ADMIN_REQUIRED');
  const parsed = new URL(adminUrl), runtimeUrl = new URL(integrationDatabaseUrl());
  if (parsed.host !== runtimeUrl.host || parsed.pathname !== runtimeUrl.pathname) throw new Error('TASK_DATABASE_MISMATCH');
  admin = createDb(adminUrl, { max: 3 }); hash = await hashPassword(password);
  const env = loadEnv({ DATABASE_URL: integrationDatabaseUrl(), PUBLIC_ORIGIN: TEST_ORIGIN, COOKIE_MODE: 'loopback', HOST: '127.0.0.1', NODE_ENV: 'test' });
  app = buildApp({ env, db: runtime, registerAdditionalRoutes: (a) => {
    a.get('/test/service-identity', async (request, reply) => {
      try { const p = await authenticateServiceKey(request, runtime, env); if (!await serviceKeyGroupAvailable(runtime, p)) throw appError('GROUP_NOT_ALLOWED'); return sendData(reply, { user_id: p.userId }); }
      catch (error) { return sendRequestError(reply, error); }
    });
  } }); await app.ready();
});
afterAll(async () => { await app?.close(); for (const db of [runtime, owner, admin]) if (db) await closeDb(db); });

describe('A-DB01 owner/runtime privilege separation', () => {
  it('uses a non-superuser non-owner runtime with DML but no schema/table/role DDL or migration writes', async () => {
    const role = (await runtime.pool.query<{ name: string; rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean; rolbypassrls: boolean }>('SELECT current_user AS name,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]!;
    expect(role).toMatchObject({ name: 'nbcloud_runtime', rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false });
    expect((await owner.pool.query('SELECT rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({ rolsuper: false });
    const ownership = await runtime.pool.query<{ tableowner: string }>("SELECT tableowner FROM pg_tables WHERE schemaname='public'");
    expect(ownership.rows.length).toBeGreaterThan(15); expect(new Set(ownership.rows.map((r) => r.tableowner))).toEqual(new Set(['nbcloud_owner']));
    for (const sql of ['CREATE TABLE public.runtime_ddl_probe(id integer)', 'CREATE SCHEMA runtime_ddl_probe', 'CREATE TEMP TABLE runtime_ddl_probe(id integer)', 'ALTER TABLE users ADD COLUMN runtime_ddl_probe integer', 'TRUNCATE users CASCADE', 'INSERT INTO schema_migrations(version) VALUES(99)', 'CREATE ROLE runtime_ddl_probe']) await expect(runtime.pool.query(sql)).rejects.toMatchObject({ code: '42501' });
    const t = await team(), s = await login(t);
    const revision = (await owner.pool.query('SELECT revision FROM tenants WHERE id=$1', [t.id])).rows[0].revision;
    const response = await app.inject({ method: 'POST', url: '/api/admin/groups', headers: headers(s), payload: { name: 'restricted-runtime-crud' } });
    expect(response.statusCode).toBe(201);
    expect(BigInt((await owner.pool.query('SELECT revision FROM tenants WHERE id=$1', [t.id])).rows[0].revision)).toBeGreaterThan(BigInt(revision));
    expect((await owner.pool.query("SELECT id FROM audit_events WHERE tenant_id=$1 AND action='group.create'", [t.id])).rows).toHaveLength(1);
  });
  it('reprovisions and reapplies grants/revokes repeatably, including future owner-created tables', async () => {
    const roles = roleConnections(process.env['DATABASE_ADMIN_URL']!, integrationOwnerUrl(), integrationDatabaseUrl());
    await provisionDatabase(admin.pool, roles); await provisionDatabase(admin.pool, roles);
    await grantRuntimeAccess(owner.pool, roles.runtime.name);
    await owner.pool.query('CREATE TABLE public.runtime_grant_probe(id integer PRIMARY KEY)');
    try {
      await runtime.pool.query('INSERT INTO public.runtime_grant_probe VALUES(1)');
      await owner.pool.query('REVOKE ALL ON public.runtime_grant_probe FROM nbcloud_runtime');
      await expect(runtime.pool.query('INSERT INTO public.runtime_grant_probe VALUES(2)')).rejects.toMatchObject({ code: '42501' });
      await grantRuntimeAccess(owner.pool, roles.runtime.name); await grantRuntimeAccess(owner.pool, roles.runtime.name);
      await runtime.pool.query('INSERT INTO public.runtime_grant_probe VALUES(2)');
      expect((await runtime.pool.query('SELECT * FROM public.runtime_grant_probe ORDER BY id')).rows).toEqual([{ id: 1 }, { id: 2 }]);
      await expect(runtime.pool.query('ALTER TABLE public.runtime_grant_probe ADD COLUMN bad text')).rejects.toMatchObject({ code: '42501' });
    } finally { await owner.pool.query('DROP TABLE public.runtime_grant_probe'); }
  });
});

describe('A-G01-V01 controlled PostgreSQL interleavings', () => {
  for (const change of ['disable', 'demote'] as const) it(`rejects a queued actor after ${change} commits, without target or success audit side effects`, async () => {
    const t = await team(), s = await login(t), id = randomUUID(); const block = await holdTenant(t.id);
    const pending = app.inject({ method: 'POST', url: '/api/admin/groups', headers: headers(s, id), payload: { name: 'must-not-exist' } });
    try {
      await block.waitForBlocked();
      await block.tx.query(change === 'disable' ? "UPDATE users SET status='disabled' WHERE id=$1" : "UPDATE users SET role='user' WHERE id=$1", [t.adminId]);
      await block.commit();
      const response = await pending; expect(response.statusCode).toBe(change === 'disable' ? 401 : 403);
      expect((await owner.pool.query("SELECT id FROM groups WHERE tenant_id=$1 AND name='must-not-exist'", [t.id])).rows).toHaveLength(0); await noSuccessAudit(id);
    } finally { await block.close(); await pending; }
  });
  for (const change of ['disable', 'demote'] as const) it(`serializes two admins mutually ${change}ing each other after both initial checks`, async () => {
    const t = await team(), first = await login(t), second = await login(t, 'second');
    const block = await holdTenant(t.id), firstId = randomUUID(), secondId = randomUUID();
    const payload = change === 'disable' ? { status: 'disabled' } : { role: 'user' };
    const one = app.inject({ method: 'PATCH', url: `/api/admin/users/${t.secondId}`, headers: headers(first, firstId), payload });
    const two = app.inject({ method: 'PATCH', url: `/api/admin/users/${t.adminId}`, headers: headers(second, secondId), payload });
    try {
      await block.waitForBlocked(2); await block.commit();
      const responses = await Promise.all([one, two]); expect(responses.filter((r) => r.statusCode === 200)).toHaveLength(1);
      const failed = responses.findIndex((r) => r.statusCode !== 200); expect([401, 403]).toContain(responses[failed]!.statusCode);
      await noSuccessAudit(failed === 0 ? firstId : secondId);
      expect(Number((await owner.pool.query("SELECT count(*) AS count FROM users WHERE tenant_id=$1 AND role='admin' AND status='active'", [t.id])).rows[0].count)).toBe(1);
      expect((await owner.pool.query("SELECT id FROM audit_events WHERE tenant_id=$1 AND action='user.update'", [t.id])).rows).toHaveLength(1);
    } finally { await block.close(); await Promise.all([one, two]); }
  });
  it('rejects an old-password login whose hash completed before a reset wins the tenant lock', async () => {
    const t = await team(); const newHash = await hashPassword('Different-fake-password-123'); const block = await holdTenant(t.id);
    const pending = app.inject({ method: 'POST', url: '/api/admin/auth/login', headers: { origin: TEST_ORIGIN, 'content-type': 'application/json' }, payload: { tenant: t.slug, username: 'admin', password } });
    try {
      await block.waitForBlocked(); // Production reaches this lock only after successful password verification.
      await block.tx.query('UPDATE users SET password_hash=$2,password_version=password_version+1 WHERE id=$1', [t.adminId, newHash]);
      await block.commit(); expect((await pending).statusCode).toBe(401);
      expect((await owner.pool.query('SELECT id FROM sessions WHERE user_id=$1', [t.adminId])).rows).toHaveLength(0);
    } finally { await block.close(); await pending; }
  });
  it('rejects a login when tenant disable commits after password verification', async () => {
    const t = await team(), block = await holdTenant(t.id);
    const pending = app.inject({ method: 'POST', url: '/api/admin/auth/login', headers: { origin: TEST_ORIGIN, 'content-type': 'application/json' }, payload: { tenant: t.slug, username: 'admin', password } });
    try {
      await block.waitForBlocked(); await block.tx.query("UPDATE tenants SET status='disabled' WHERE id=$1", [t.id]); await block.commit();
      expect((await pending).statusCode).toBe(401);
      expect((await owner.pool.query('SELECT id FROM sessions WHERE tenant_id=$1', [t.id])).rows).toHaveLength(0);
    } finally { await block.close(); await pending; }
  });
  for (const revoke of ['allowed', 'group'] as const) it(`rejects queued issuance and rebind after ${revoke} revocation commits`, async () => {
    const t = await team(), s = await login(t, 'member'); const original = await group(t), target = await group(t, true);
    await owner.pool.query('INSERT INTO user_allowed_groups(tenant_id,user_id,group_id) VALUES($1,$2,$3)', [t.id, t.memberId, target]);
    const existing = await key(t, t.memberId, original); const block = await holdTenant(t.id); const issueId = randomUUID(), rebindId = randomUUID();
    const issue = app.inject({ method: 'POST', url: '/api/admin/keys', headers: headers(s, issueId), payload: { name: 'queued-issue', group_id: target } });
    const rebind = app.inject({ method: 'PATCH', url: `/api/admin/keys/${existing.id}`, headers: headers(s, rebindId), payload: { expected_revision: 1, group_id: target } });
    try {
      await block.waitForBlocked(2);
      if (revoke === 'allowed') await block.tx.query('DELETE FROM user_allowed_groups WHERE tenant_id=$1 AND user_id=$2 AND group_id=$3', [t.id, t.memberId, target]);
      else await block.tx.query("UPDATE groups SET status='disabled' WHERE id=$1", [target]);
      await block.commit(); expect((await issue).statusCode).toBe(403); expect((await rebind).statusCode).toBe(403);
      expect((await owner.pool.query('SELECT group_id,revision FROM api_keys WHERE id=$1', [existing.id])).rows[0]).toMatchObject({ group_id: original, revision: '1' });
      expect((await owner.pool.query('SELECT id FROM api_keys WHERE tenant_id=$1', [t.id])).rows).toHaveLength(1);
      await noSuccessAudit(issueId); await noSuccessAudit(rebindId);
    } finally { await block.close(); await Promise.all([issue, rebind]); }
  });
  it('rejects a session that expires while its mutation waits for the tenant lock', async () => {
    const t = await team(), s = await login(t), id = randomUUID(), block = await holdTenant(t.id);
    const pending = app.inject({ method: 'POST', url: '/api/admin/groups', headers: headers(s, id), payload: { name: 'expired-session-write' } });
    try {
      await block.waitForBlocked(); await block.tx.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE id=$1", [s.id]); await block.commit();
      expect((await pending).statusCode).toBe(401); await noSuccessAudit(id);
      expect((await owner.pool.query('SELECT id FROM groups WHERE tenant_id=$1', [t.id])).rows).toHaveLength(0);
    } finally { await block.close(); await pending; }
  });
});

describe('A-KEY01 and A-G02-V01 member/credential/tenant boundaries', () => {
  it('allows a member to issue/edit/rebind/disable/reactivate their own key with real public-group grants', async () => {
    const t = await team(), s = await login(t, 'member'), first = await group(t), second = await group(t);
    let response = await app.inject({ method: 'POST', url: '/api/admin/keys', headers: headers(s), payload: { name: 'member-self-key', group_id: first } });
    expect(response.statusCode).toBe(201); const issued = response.json().data; let revision = issued.key.revision;
    expect(issued.key).toMatchObject({ user_id: t.memberId, group_id: first, quota_units: 0, expires_at: null });
    for (const patch of [{ quota_units: 25, expires_at: '2030-01-01T00:00:00.000Z' }, { quota_units: 100, expires_at: '2040-01-01T00:00:00.000Z' }, { expires_at: null, group_id: second }, { status: 'disabled' }, { status: 'active' }]) {
      response = await app.inject({ method: 'PATCH', url: `/api/admin/keys/${issued.key.id}`, headers: headers(s), payload: { expected_revision: revision, ...patch } });
      expect(response.statusCode).toBe(200); revision = response.json().data.revision;
    }
    expect(response.json().data).toMatchObject({ status: 'active', group_id: second, expires_at: null, quota_units: 100 });
    expect((await app.inject({ method: 'GET', url: '/test/service-identity', headers: { authorization: `Bearer ${issued.access_key}` } })).statusCode).toBe(200);
    for (const url of ['/api/admin/users', '/api/admin/groups']) expect((await app.inject({ method: 'POST', url, headers: headers(s), payload: url.endsWith('users') ? { username: 'no-admin', display_name: 'No', password } : { name: 'no-admin' } })).statusCode).toBe(403);
    const foreign = await key(t, t.secondId, first);
    for (const method of ['GET', 'PATCH', 'DELETE'] as const) {
      const result = await app.inject({ method, url: `/api/admin/keys/${foreign.id}`, headers: headers(s), ...(method === 'PATCH' ? { payload: { expected_revision: 1, name: 'not-owner' } } : method === 'DELETE' ? { payload: {} } : {}) });
      expect(result.statusCode).toBe(403);
    }
  });
  for (const revoke of ['allowed', 'group'] as const) it(`A-KEY01 permits independent edits/disable after ${revoke} loss; restoring group never reactivates a disabled key`, async () => {
    const t = await team(), s = await login(t, 'member'), target = await group(t, true);
    await owner.pool.query('INSERT INTO user_allowed_groups(tenant_id,user_id,group_id) VALUES($1,$2,$3)', [t.id, t.memberId, target]);
    const issued = await key(t, t.memberId, target);
    if (revoke === 'allowed') await owner.pool.query('DELETE FROM user_allowed_groups WHERE tenant_id=$1 AND user_id=$2', [t.id, t.memberId]);
    else await owner.pool.query("UPDATE groups SET status='disabled' WHERE id=$1", [target]);
    expect((await app.inject({ method: 'GET', url: '/test/service-identity', headers: { authorization: `Bearer ${issued.token}` } })).statusCode).toBe(403);
    const changed = await app.inject({ method: 'PATCH', url: `/api/admin/keys/${issued.id}`, headers: headers(s), payload: { expected_revision: 1, status: 'disabled', name: 'safe-disabled', quota_units: 100, expires_at: null, group_id: target } });
    expect(changed.statusCode).toBe(200);
    if (revoke === 'allowed') await owner.pool.query('INSERT INTO user_allowed_groups(tenant_id,user_id,group_id) VALUES($1,$2,$3)', [t.id, t.memberId, target]);
    else await owner.pool.query("UPDATE groups SET status='active' WHERE id=$1", [target]);
    expect((await app.inject({ method: 'GET', url: '/test/service-identity', headers: { authorization: `Bearer ${issued.token}` } })).statusCode).toBe(401);
    expect((await owner.pool.query('SELECT status FROM api_keys WHERE id=$1', [issued.id])).rows[0].status).toBe('disabled');
  });
  it('separates cookie and Bearer credentials and rejects disabled/deleted/expired keys and users', async () => {
    const t = await team(), s = await login(t, 'member'), g = await group(t), issued = await key(t, t.memberId, g);
    expect((await app.inject({ method: 'GET', url: '/test/service-identity', headers: { cookie: s.cookie } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/test/service-identity', headers: { cookie: s.cookie, authorization: `Bearer ${issued.token}` } })).statusCode).toBe(401);
    for (const sql of ["UPDATE api_keys SET status='disabled' WHERE id=$1", "UPDATE api_keys SET status='active',expires_at=now()-interval '1 second' WHERE id=$1", "UPDATE api_keys SET expires_at=NULL,deleted_at=now() WHERE id=$1"]) {
      await owner.pool.query(sql, [issued.id]); expect((await app.inject({ method: 'GET', url: '/test/service-identity', headers: { authorization: `Bearer ${issued.token}` } })).statusCode).toBe(401);
    }
    const active = await key(t, t.memberId, g); await owner.pool.query("UPDATE users SET status='disabled' WHERE id=$1", [t.memberId]);
    expect((await app.inject({ method: 'GET', url: '/test/service-identity', headers: { authorization: `Bearer ${active.token}` } })).statusCode).toBe(401);
  });
  it('returns the same 404 for foreign/unknown user, group, and key CRUD and enforces composite FKs', async () => {
    const a = await team(), b = await team(), s = await login(a), foreignGroup = await group(b), localGroup = await group(a), foreignKey = await key(b, b.memberId, foreignGroup);
    for (const [route, id, patch] of [['users', b.memberId, { display_name: 'foreign' }], ['groups', foreignGroup, { expected_revision: 1, name: 'foreign' }], ['keys', foreignKey.id, { expected_revision: 1, name: 'foreign' }]] as const) {
      for (const target of [id, randomUUID()]) {
        expect((await app.inject({ method: 'GET', url: `/api/admin/${route}/${target}`, headers: headers(s) })).statusCode).toBe(404);
        expect((await app.inject({ method: 'PATCH', url: `/api/admin/${route}/${target}`, headers: headers(s), payload: patch })).statusCode).toBe(404);
      }
    }
    const issued = issueAccessKey();
    for (const [u, g] of [[b.memberId, localGroup], [a.memberId, foreignGroup]]) await expect(runtime.pool.query("INSERT INTO api_keys(id,tenant_id,user_id,group_id,name,token_hash,prefix) VALUES($1,$2,$3,$4,'wrong',$5,$6)", [randomUUID(), a.id, u, g, issued.hash, issued.prefix])).rejects.toMatchObject({ code: '23503' });
    for (const [u, g] of [[b.memberId, localGroup], [a.memberId, foreignGroup]]) await expect(runtime.pool.query('INSERT INTO user_allowed_groups(tenant_id,user_id,group_id) VALUES($1,$2,$3)', [a.id, u, g])).rejects.toMatchObject({ code: '23503' });
    await expect(runtime.pool.query("INSERT INTO groups(id,tenant_id,name) VALUES($1,$2,'no-tenant')", [randomUUID(), randomUUID()])).rejects.toMatchObject({ code: '23503' });
  });
  it('captures logs, safe errors, DB hashes and audit canaries; validates actual production/loopback Set-Cookie', async () => {
    const logs: string[] = [], errors: string[] = [];
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { logs.push(String(chunk)); return true; });
    const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { errors.push(String(chunk)); return true; });
    let production: FastifyInstance | undefined;
    try {
      const t = await team(), s = await login(t, 'member'), g = await group(t);
      expect(s.setCookie).toMatch(/HttpOnly/i); expect(s.setCookie).toMatch(/SameSite=Strict/i); expect(s.setCookie).toMatch(/Path=\//i); expect(s.setCookie).not.toMatch(/;\s*Secure/i);
      const issuedResponse = await app.inject({ method: 'POST', url: '/api/admin/keys', headers: headers(s), payload: { name: 'safe-visible-prefix', group_id: g } });
      expect(issuedResponse.statusCode).toBe(201); const issued = issuedResponse.json().data;
      const list = await app.inject({ method: 'GET', url: '/api/admin/keys', headers: headers(s) }); expect(list.body).not.toContain(issued.access_key); expect(list.body).not.toContain('token_hash');
      const rejected = await app.inject({ method: 'PATCH', url: `/api/admin/keys/${issued.key.id}`, headers: headers(s), payload: { expected_revision: 1, unsupported: password } }); expect(rejected.statusCode).toBe(422); expect(rejected.body).not.toContain(password);
      const stored = (await owner.pool.query<{ token_hash: Buffer }>('SELECT token_hash FROM api_keys WHERE id=$1', [issued.key.id])).rows[0]!;
      expect(stored.token_hash.equals(createHash('sha256').update(issued.access_key).digest())).toBe(true);
      expect((await owner.pool.query('SELECT password_hash FROM users WHERE id=$1', [t.memberId])).rows[0].password_hash).not.toContain(password);
      const audit = JSON.stringify((await owner.pool.query('SELECT * FROM audit_events WHERE tenant_id=$1', [t.id])).rows);
      for (const text of [audit, logs.join(''), errors.join('')]) { expect(text).not.toContain(password); expect(text).not.toContain(issued.access_key); }
      production = buildApp({ db: runtime, env: loadEnv({ DATABASE_URL: integrationDatabaseUrl(), PUBLIC_ORIGIN: 'https://cloud.example', COOKIE_MODE: 'production', HOST: '127.0.0.1', NODE_ENV: 'test' }) }); await production.ready();
      const prodSession = await login(t, 'member', production, 'https://cloud.example');
      expect(prodSession.setCookie).toMatch(/^__Host-nbcloud_session=/); expect(prodSession.setCookie).toMatch(/;\s*Secure/i); expect(prodSession.setCookie).toMatch(/HttpOnly/i); expect(prodSession.setCookie).toMatch(/SameSite=Strict/i); expect(prodSession.setCookie).toMatch(/Path=\//i); expect(prodSession.setCookie).not.toMatch(/Domain=/i);
      expect(() => loadEnv({ DATABASE_URL: integrationDatabaseUrl(), PUBLIC_ORIGIN: TEST_ORIGIN, COOKIE_MODE: 'production' })).toThrow();
      expect(() => loadEnv({ DATABASE_URL: integrationDatabaseUrl(), PUBLIC_ORIGIN: TEST_ORIGIN, COOKIE_MODE: 'loopback', HOST: '0.0.0.0' })).toThrow();
    } finally { await production?.close(); out.mockRestore(); err.mockRestore(); }
  });
});
