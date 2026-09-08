import { randomUUID, randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { createNbSearchRemoteClient, builtInProviderRegistrations } from '@nb-corp/nb-search';
import { buildApp } from '../../src/app.js';
import { executionService } from '../../src/execution/service.js';
import { createDb, closeDb, type DbHandle } from '../../src/db/client.js';
import { integrationDatabaseUrl, prepareIntegrationDatabase, seedUser } from '../helpers/identity.js';
let db: DbHandle, app: ReturnType<typeof buildApp>, worker: ChildProcess, home: string, base: string, headers: Record<string,string>;
const tenant = randomUUID(), user = randomUUID();
beforeAll(async () => {
  expect(builtInProviderRegistrations().some(r => r.descriptor.provider_id === 'script')).toBe(true);
  await prepareIntegrationDatabase(); db = createDb(integrationDatabaseUrl());
  home = await mkdtemp(resolve(tmpdir(), 'nbcloud-script-test-'));
  await writeFile(resolve(home, 'fixture.mjs'), `export async function execute(request, context) { return [{title:'Trusted script',url:'https://example.com/script',snippet:context.options.prefix+':'+request.query+':'+(context.credential==='fake-script-A'?'A':context.credential==='fake-script-B'?'B':'none')}]; }`);
  const manifest = resolve(home, 'manifest.json'); await writeFile(manifest, JSON.stringify({ channels: [{ id: 'fixture', label: 'Trusted fixture', module: './fixture.mjs', params: { prefix: 'operator' } }] }));
  await db.pool.query('INSERT INTO tenants(id,slug,name) VALUES($1,$2,$2)', [tenant, 'script-'+tenant]);
  await seedUser(db, { tenantId: tenant, userId: user, username: 'admin', password: 'Script-test-password-123', role: 'admin' });
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, DATABASE_URL: integrationDatabaseUrl(), CLOUD_SECRET_MASTER_KEY: randomBytes(32).toString('base64'), CLOUD_SECRET_KEY_ID: 'script-test', CLOUD_SCRIPT_CHANNELS: manifest, CLOUD_EXECUTION_HOME: resolve(home, 'worker') };
  const service = executionService(db, env);
  // Reserve/listen is not a public port: this fixture accepts loopback only.
  app = buildApp({ db, env: { DATABASE_URL: integrationDatabaseUrl(), PUBLIC_ORIGIN: 'http://127.0.0.1:3000', COOKIE_MODE: 'loopback' }, registerAdditionalRoutes: service.register });
  base = await app.listen({ host: '127.0.0.1', port: 0 });
  const login = await app.inject({ method: 'POST', url: '/api/admin/auth/login', headers: { origin: 'http://127.0.0.1:3000' }, payload: { tenant: 'script-'+tenant, username: 'admin', password: 'Script-test-password-123' } });
  expect(login.statusCode).toBe(200); headers = { origin: 'http://127.0.0.1:3000', cookie: String(login.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': login.json().data.csrf_token };
  worker = spawn(process.execPath, ['test/fixtures/execution-worker.mjs'], { env, stdio: ['ignore','pipe','pipe','ipc'] });
  worker.stdout!.on('data', () => undefined); worker.stderr!.on('data', () => undefined);
  await new Promise<void>((ok, fail) => { const timer = setTimeout(() => fail(Error('WORKER_TIMEOUT')), 15000); worker.on('message', (m: any) => { if (m.stage === 'ready') { clearTimeout(timer); ok(); } }); worker.once('error', fail); });
});
afterAll(async () => {
  if (worker && worker.exitCode === null) { const ended = new Promise<void>(ok => worker.once('close', () => ok())); worker.kill('SIGTERM'); const timer = setTimeout(() => worker.kill('SIGKILL'), 5000); await ended.finally(() => clearTimeout(timer)); }
  await app?.close(); if (db) await closeDb(db); if (home) await rm(home, { recursive: true, force: true });
});
async function post(path: string, payload: object) { const r = await app.inject({ method: 'POST', url: '/api/admin'+path, headers, payload }); expect(r.statusCode).toBe(201); return r.json().data; }
it('runs registered module through real SDK/independent worker in sync and PG async modes; tenant cannot choose paths', async () => {
  const catalog = await app.inject({ method: 'GET', url: '/api/admin/providers/catalog', headers });
  expect(catalog.json().data.script_channels).toEqual([{ id: 'fixture', label: 'Trusted fixture' }]); expect(catalog.body).not.toContain(home);
  for (const options of [{ module: '/tmp/tenant-upload.mjs' }, { channel_id: 'missing' }, { channel_id: 'fixture', module: '/tmp/override.mjs' }]) {
    expect((await app.inject({ method: 'POST', url: '/api/admin/providers', headers, payload: { name: 'rejected', provider_id: 'script', options } })).statusCode).toBe(422);
  }
  const provider = await post('/providers', { name: 'script fixture', provider_id: 'script', options: { channel_id: 'fixture', params: { prefix: 'tenant' } }, key_pool: [{ secret: 'fake-script-A' }, { secret: 'fake-script-B' }] });
  await post('/lanes', { id: 'script.fixture', provider_id: provider.id, operation_id: 'search', latency: 'fast', cost: 'free' });
  const group = await post('/groups', { name: 'script group' });
  const configured = await app.inject({ method: 'PUT', url: `/api/admin/groups/${group.id}/capabilities`, headers, payload: { expected_revision: group.revision, lanes: [{ lane_id: 'script.fixture', units_per_query: 1 }], default_search_lane: 'script.fixture', default_fetch_pipeline: null, presets: {} } }); expect(configured.statusCode).toBe(200);
  const key = await post('/keys', { name: 'script key', group_id: group.id });
  const client = createNbSearchRemoteClient({ base_url: base, access_key: key.access_key, allow_loopback_http: true });
  const sync = await client.search({ action: 'run', query: 'sync-check' }); expect(sync.status).toBe('succeeded'); expect(JSON.stringify(sync)).toContain('tenant:sync-check:A');
  const run: any = await client.search({ action: 'run', query: 'async-check', execution: 'async', idempotency_key: 'script-one' }); expect(run.status).toBe('queued');
  let job: any; const until = Date.now()+15000;
  do { job = await client.search({ action: 'get', job_id: run.job.job_id }); if (job.state === 'succeeded' || job.state === 'failed') break; await new Promise(ok => setTimeout(ok, 50)); } while (Date.now()<until);
  expect(job.state).toBe('succeeded');
  const page: any = await client.search({ action: 'read', job_id: run.job.job_id });
  expect(Buffer.concat(page.chunks.map((c: any) => Buffer.from(c.data_base64,'base64'))).toString()).toContain('tenant:async-check:B');
  expect((await db.pool.query("SELECT count(*)::int AS count FROM usage_reservations WHERE tenant_id=$1 AND state='settled'", [tenant])).rows[0].count).toBe(2);
});
