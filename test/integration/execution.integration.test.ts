import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, closeDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { getSchemaVersion, lockTenant, queryOne, withTransaction } from '../../src/db/transaction.js';
import { applyExecutionMigration } from '../../src/execution/migrate.js';
import { ProviderService } from '../../src/execution/providers.js';
import { SecretVault } from '../../src/execution/crypto.js';
import { ExecutionStore } from '../../src/execution/store.js';
import { canonicalContent, contentHash } from '../../src/execution/idempotency.js';
import { issueAccessKey } from '../../src/auth/api-key.js';
import { runReceipt } from '../../src/execution/projections.js';
import type { JobRow, Json, ServicePrincipal } from '../../src/execution/types.js';

let db: DbHandle;
let providers: ProviderService;
let store: ExecutionStore;
const version = 'repository-fixture-v1';
const run = (key: string, extra: Record<string, Json> = {}): Record<string, Json> => ({ action: 'run', execution: 'async', idempotency_key: key, query: 'q', ...extra });
async function locked<T>(tenant: string, fn: Parameters<typeof withTransaction<T>>[1]): Promise<T> { return withTransaction(db, async (tx) => { await lockTenant(tx, tenant); return fn(tx); }); }
async function fixture(limit = 0, keyQuota = 0) {
  const tenant = randomUUID(), user = randomUUID(), group = randomUUID(), key = randomUUID();
  await db.pool.query('INSERT INTO tenants(id,slug,name) VALUES($1,$2,$2)', [tenant, `t-${tenant}`]);
  const issued = issueAccessKey();
  let providerId = '';
  await locked(tenant, async (tx) => {
    // Repository fixture only: no login is asserted by these tests.
    await tx.query("INSERT INTO users(id,tenant_id,username,display_name,role,password_hash) VALUES($1,$2,'member','Member','user','unused-test-hash')", [user, tenant]);
    await tx.query("INSERT INTO groups(id,tenant_id,name,daily_units_per_user) VALUES($1,$2,'search',$3)", [group, tenant, limit]);
    await tx.query("INSERT INTO api_keys(id,tenant_id,user_id,group_id,name,token_hash,prefix,quota_units) VALUES($1,$2,$3,$4,'fixture',$5,$6,$7)", [key, tenant, user, group, issued.hash, issued.prefix, keyQuota]);
    const provider = await providers.create(tx, tenant, { name: 'exa fixture', provider_id: 'exa', base_url: 'https://provider.example', secret: 'fake-encrypted-provider-canary' });
    providerId = String(provider['id']);
    await tx.query("INSERT INTO lanes(tenant_id,id,kind,provider_id,operation_id,latency,cost) VALUES($1,'exa.search','search',$2,'search','fast','cheap'),($1,'exa.alternate','search',$2,'search','fast','cheap')", [tenant, providerId]);
    await tx.query("INSERT INTO group_lanes(tenant_id,group_id,lane_id) VALUES($1,$2,'exa.search'),($1,$2,'exa.alternate')", [tenant, group]);
    await tx.query("UPDATE groups SET default_search_lane='exa.search',presets='{\"p\":[\"exa.search\"]}' WHERE tenant_id=$1 AND id=$2", [tenant, group]);
  });
  const principal: ServicePrincipal = { tenantId: tenant, userId: user, groupId: group, keyId: key };
  return { tenant, user, group, key, principal, providerId, issued };
}
async function finishOne() {
  const claimed = (await store.claim())!; expect(claimed).toBeDefined();
  const dispatched = (await store.markDispatch(claimed))!; expect(dispatched).toBeDefined();
  const output = { channel: 'results', schema_id: 'nb-search.results@1', status: 'empty', lanes: ['exa.search'], results: [], lane_outcomes: [], merge_summary: { input_rows: 0, canonical_dedup: 0, independent_evidence_groups: 0, result_count: 0 }, hints: [] };
  expect(await store.complete(dispatched, { state: 'succeeded', envelope: { schema_version: '3.0', action: 'run', execution: 'sync', status: 'empty', output }, artifact: output })).toBe(true);
  return dispatched;
}
async function counters(tenant: string) {
  return (await db.pool.query<{ reserved: string; used: string }>('SELECT coalesce(sum(reserved_units),0)::text AS reserved,coalesce(sum(used_units),0)::text AS used FROM group_usage_buckets WHERE tenant_id=$1', [tenant])).rows[0]!;
}

describe('Stage B durable repository on real isolated PostgreSQL', () => {
  beforeAll(async () => {
    const raw = process.env['DATABASE_URL'];
    if (!raw) throw new Error('REAL_PG_REQUIRED');
    const url = new URL(raw);
    if (url.hostname !== '127.0.0.1' || !['/nbcloud_test_execution', '/nbcloud_test_task18'].includes(url.pathname)) throw new Error('DEDICATED_EXECUTION_TEST_DB_REQUIRED');
    await (await import('../helpers/identity.js')).prepareIntegrationDatabase();
    db = createDb(raw, { max: 24 });
    providers = new ProviderService(version, new SecretVault('fake-test-key', randomBytes(32).toString('base64')), () => undefined);
    // Explicit repository readiness fixture, NOT proof of SDK bridge or egress readiness.
    store = new ExecutionStore(db, version, (lane) => lane.secret_key_id !== null);
  });
  afterAll(async () => { if (db) await closeDb(db); });

  it('applies migration twice, enforces immutable config and tenant FKs, never returns stored secret', async () => {
    const migrationOwner = createDb((await import('../helpers/identity.js')).integrationOwnerUrl());
    try { expect(await applyExecutionMigration(migrationOwner.pool)).toBe(2); } finally { await closeDb(migrationOwner); }
    const a = await fixture(); const b = await fixture();
    const config = await queryOne<{ current_config_id: string }>(db.pool, 'SELECT current_config_id FROM providers WHERE id=$1', [a.providerId]);
    const before = await providers.config(db.pool, a.tenant, config!.current_config_id);
    expect(JSON.stringify(await providers.get(db.pool, a.tenant, a.providerId))).not.toContain('fake-encrypted-provider-canary');
    expect(before.ciphertext!.toString()).not.toContain('fake-encrypted-provider-canary');
    expect(providers.decrypt(before)).toBe('fake-encrypted-provider-canary');
    await expect(db.pool.query("UPDATE provider_configs SET options='{\"bad\":true}' WHERE id=$1", [before.id])).rejects.toMatchObject({ code: 'P0001' });
    await expect(db.pool.query("INSERT INTO lanes(tenant_id,id,kind,provider_id,operation_id,latency,cost) VALUES($1,'wrong','search',$2,'search','fast','cheap')", [b.tenant, a.providerId])).rejects.toMatchObject({ code: '23503' });
    await locked(a.tenant, (tx) => providers.patch(tx, a.tenant, a.providerId, { expected_revision: 1, base_url: 'https://changed.example' }));
    const current = (await queryOne<{ current_config_id: string }>(db.pool, 'SELECT current_config_id FROM providers WHERE id=$1', [a.providerId]))!;
    const changed = await providers.config(db.pool, a.tenant, current.current_config_id);
    expect(changed.id).not.toBe(before.id); expect(providers.decrypt(changed)).toBe('fake-encrypted-provider-canary');
    expect(() => providers.decrypt({ ...changed, tenant_id: b.tenant })).toThrow();
  });
  it('atomically reserves group and key budgets, while unlimited zero still meters', async () => {
    for (const [groupLimit, keyLimit] of [[3, 0], [0, 3]]) {
      const f = await fixture(groupLimit, keyLimit);
      const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => store.admit(f.principal, 'search', run(`concurrent-${i}`), `request-${i}`)));
      expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(3);
      expect(results.filter((item) => item.status === 'rejected' && item.reason.code === 'RATE_LIMITED')).toHaveLength(17);
      expect(await counters(f.tenant)).toEqual({ reserved: '3', used: '0' });
      for (const item of results) if (item.status === 'fulfilled') await store.cancel(f.principal, 'search', item.value.job.id);
      expect(await counters(f.tenant)).toEqual({ reserved: '0', used: '0' });
    }
  });
  it('concurrent matching admission converges; content conflicts and defaults changes do not dispatch again', async () => {
    const f = await fixture(1);
    const results = await Promise.all(Array.from({ length: 20 }, () => store.admit(f.principal, 'search', run('same'), 'idem')));
    expect(new Set(results.map((r) => r.job.id)).size).toBe(1);
    expect(results.filter((r) => !r.reused)).toHaveLength(1);
    const first = results[0]!.job;
    await locked(f.tenant, async (tx) => {
      await tx.query("UPDATE groups SET default_search_lane='exa.alternate' WHERE tenant_id=$1 AND id=$2", [f.tenant, f.group]);
      await tx.query('UPDATE group_lanes SET units_per_query=99 WHERE tenant_id=$1 AND group_id=$2', [f.tenant, f.group]);
      await providers.patch(tx, f.tenant, f.providerId, { expected_revision: 1, secret: 'fake-rotated-provider-canary' });
    });
    const replay = await store.admit(f.principal, 'search', run('same'), 'lost-response');
    expect(replay.job.id).toBe(first.id); expect(replay.job.first_plan).toEqual(first.first_plan); expect(replay.reused).toBe(true);
    await expect(store.admit(f.principal, 'search', run('same', { max_results: 10 }), 'conflict')).rejects.toMatchObject({ code: 'CONFLICT' });
    const rotated = issueAccessKey(); const newId = randomUUID();
    await locked(f.tenant, (tx) => tx.query("INSERT INTO api_keys(id,tenant_id,user_id,group_id,name,token_hash,prefix) VALUES($1,$2,$3,$4,'rotation',$5,$6)", [newId, f.tenant, f.user, f.group, rotated.hash, rotated.prefix]));
    expect((await store.admit({ ...f.principal, keyId: newId }, 'search', run('same'), 'rotation')).job.id).toBe(first.id);
    await locked(f.tenant, (tx) => tx.query("DELETE FROM group_lanes WHERE tenant_id=$1 AND group_id=$2 AND lane_id='exa.search'", [f.tenant, f.group]));
    await expect(store.get(f.principal, 'search', first.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(store.admit(f.principal, 'search', run('same'), 'revoked')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const claimed = (await store.claim())!;
    expect(claimed.id).toBe(first.id);
    expect(await store.markDispatch(claimed)).toBeUndefined();
    expect(await counters(f.tenant)).toEqual({ reserved: '0', used: '0' });
  });
  it('fences worker loss before versus after dispatch and never refunds uncertain provider work', async () => {
    const f = await fixture();
    const admitted = await store.admit(f.principal, 'search', run('before'), 'before');
    const firstClaim = (await store.claim())!;
    expect(firstClaim.id).toBe(admitted.job.id);
    await db.pool.query("UPDATE jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [firstClaim.id]);
    await store.reconcile();
    const second = (await store.claim())!; expect(second.id).toBe(firstClaim.id); expect(second.claim_count).toBe(2);
    await db.pool.query("UPDATE jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [second.id]);
    await store.reconcile();
    expect((await store.get(f.principal, 'search', admitted.job.id)).state).toBe('failed');
    expect(await counters(f.tenant)).toEqual({ reserved: '0', used: '0' });
    const next = await store.admit(f.principal, 'search', run('after'), 'after');
    const claim = (await store.claim())!; const dispatched = (await store.markDispatch(claim))!;
    await db.pool.query("UPDATE jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [claim.id]);
    await store.reconcile(); await store.reconcile();
    expect(await store.complete(dispatched, { state: 'succeeded', envelope: {} })).toBe(false);
    expect(await counters(f.tenant)).toEqual({ reserved: '0', used: '1' });
    const replay = await store.admit(f.principal, 'search', run('after'), 'recover-failed');
    expect(replay.job.id).toBe(next.job.id); expect(runReceipt(replay.job, true)).toMatchObject({ status: 'failed', reused: true, job: { state: 'failed' }, error: { code: 'WORKER_LOST' } });
  });
  it('publishes immutable chunks/hash atomically and protects owner/kind/cursor even without new quota', async () => {
    const f = await fixture(1); const foreign = await fixture();
    const admitted = await store.admit(f.principal, 'search', run('artifact'), 'artifact');
    const claim = (await store.claim())!, dispatched = (await store.markDispatch(claim))!;
    const output = { text: 'x'.repeat(40_000) };
    expect(await store.complete(dispatched, { state: 'succeeded', envelope: {}, artifact: output })).toBe(true);
    const page = await store.read(f.principal, 'search', admitted.job.id, undefined, 2);
    expect(page['next_cursor']).toBeTypeOf('string');
    const second = await store.read(f.principal, 'search', admitted.job.id, String(page['next_cursor']), 2);
    const chunks = [...page['chunks'] as { data_base64: string }[], ...second['chunks'] as { data_base64: string }[]];
    const bytes = Buffer.concat(chunks.map((c) => Buffer.from(c.data_base64, 'base64')));
    expect(bytes.toString()).toBe(JSON.stringify(output));
    expect(page['artifact']).toMatchObject({ sha256: createHash('sha256').update(bytes).digest('hex'), byte_length: bytes.length });
    await expect(store.read(foreign.principal, 'search', admitted.job.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(store.get(f.principal, 'fetch', admitted.job.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(store.admit(f.principal, 'search', run('new'), 'exhausted')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect((await store.cancel(f.principal, 'search', admitted.job.id)).state).toBe('succeeded');
    expect((await store.admit(f.principal, 'search', run('artifact'), 'receipt')).reused).toBe(true);
    await expect(db.pool.query("UPDATE artifacts SET sha256=repeat('0',64) WHERE job_id=$1", [admitted.job.id])).rejects.toMatchObject({ code: 'P0001' });
  });
  it('quota reset opens a new key epoch without deleting ledger or resetting group usage', async () => {
    const f = await fixture(3, 1);
    const pending = await store.admit(f.principal, 'search', run('reset'), 'reset');
    await expect(locked(f.tenant, (tx) => store.resetKeyQuota(tx, f.tenant, f.key, 1))).rejects.toMatchObject({ code: 'ACTIVE_RESERVATIONS' });
    await finishOne();
    await locked(f.tenant, (tx) => store.resetKeyQuota(tx, f.tenant, f.key, 1));
    expect(await counters(f.tenant)).toEqual({ reserved: '0', used: '1' });
    const row = (await db.pool.query<{ quota_epoch: number }>('SELECT quota_epoch FROM api_keys WHERE id=$1', [f.key])).rows[0]!;
    expect(row.quota_epoch).toBe(2);
    expect((await store.admit(f.principal, 'search', run('reset'), 'old-key')).job.id).toBe(pending.job.id);
    await store.admit(f.principal, 'search', run('new-epoch'), 'new-epoch');
    const dispatched = await finishOne(); expect(dispatched.first_plan?.tenant_id).toBe(f.tenant);
    expect(await counters(f.tenant)).toEqual({ reserved: '0', used: '2' });
    expect((await db.pool.query('SELECT * FROM key_usage_buckets WHERE key_id=$1 ORDER BY epoch', [f.key])).rows).toHaveLength(2);
  });
  it('retains active associations beyond initial TTL, but expired terminal associations can admit again', async () => {
    const f = await fixture();
    const original = await store.admit(f.principal, 'search', run('live'), 'live');
    // Original active association remains independent of any initial advertised retention time.
    await db.pool.query("UPDATE idempotency_admissions SET created_at=now()-interval '4 days' WHERE job_id=$1", [original.job.id]);
    expect((await store.admit(f.principal, 'search', run('live'), 'live-again')).job.id).toBe(original.job.id);
    await store.cancel(f.principal, 'search', original.job.id);
    const historicalId = randomUUID(); const canonical = canonicalContent('search', run('history'));
    await locked(f.tenant, async (tx) => {
      await tx.query("INSERT INTO jobs(id,tenant_id,user_id,group_id,admitting_key_id,kind,delivery,state,first_plan,selection,request_id,created_at,completed_at,expires_at,public_error) VALUES($1,$2,$3,$4,$5,'search','async','failed',$6,$7,'old',now()-interval '5 days',now()-interval '4 days',now()-interval '1 day','{\"code\":\"WORKER_LOST\",\"message\":\"Worker lost.\",\"retryable\":false}')", [historicalId, f.tenant, f.user, f.group, f.key, JSON.stringify(original.job.first_plan), JSON.stringify(original.job.selection)]);
      await tx.query("INSERT INTO idempotency_admissions(tenant_id,user_id,kind,key,canonical_content,content_sha256,job_id) VALUES($1,$2,'search','history',$3,$4,$5)", [f.tenant, f.user, canonical, contentHash(canonical), historicalId]);
    });
    const replacement = await store.admit(f.principal, 'search', run('history'), 'history-again');
    expect(replacement.job.id).not.toBe(historicalId);
    await expect(store.get(f.principal, 'search', historicalId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const old = await queryOne<JobRow>(db.pool, 'SELECT * FROM jobs WHERE id=$1', [historicalId]);
    expect(old!.first_plan).toBeNull(); expect(old!.purged_at).not.toBeNull();
    await store.cancel(f.principal, 'search', replacement.job.id);
  });
  it('rejects NULL-based constraint bypasses and active plan mutation', async () => {
    const f = await fixture();
    const job = (await store.admit(f.principal, 'search', run('immutable'), 'immutable')).job;
    await expect(db.pool.query("UPDATE jobs SET first_plan='{}' WHERE id=$1", [job.id])).rejects.toMatchObject({ code: 'P0001' });
    await expect(db.pool.query('UPDATE jobs SET first_plan=NULL,purged_at=now() WHERE id=$1', [job.id])).rejects.toMatchObject({ code: 'P0001' });
    await expect(db.pool.query("UPDATE jobs SET state='failed',completed_at=now(),expires_at=NULL WHERE id=$1", [job.id])).rejects.toMatchObject({ code: '23514' });
    await expect(db.pool.query("INSERT INTO provider_configs(id,tenant_id,provider_id,version,sdk_version,adapter_version,base_url,secret_key_id,credential_updated_at) VALUES($1,$2,$3,99,'fixture','1','https://provider.example','incomplete',now())", [randomUUID(), f.tenant, f.providerId])).rejects.toMatchObject({ code: '23514' });
    expect((await store.get(f.principal, 'search', job.id)).first_plan).toEqual(job.first_plan);
    await store.cancel(f.principal, 'search', job.id);
  });
});
