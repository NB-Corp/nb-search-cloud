import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, realpath, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { createNbSearchRemoteClient } from '@nb-corp/nb-search';
import { buildApp } from '../../src/app.js';
import { createDb, closeDb, type DbHandle } from '../../src/db/client.js';
import { issueAccessKey } from '../../src/auth/api-key.js';
import { executionService } from '../../src/execution/service.js';
import { withTransaction, lockTenant } from '../../src/db/transaction.js';
import { integrationDatabaseUrl, prepareIntegrationDatabase } from '../helpers/identity.js';
import { tlsProvider } from '../fixtures/tls-provider.js';

let db: DbHandle, app: ReturnType<typeof buildApp>, service: ReturnType<typeof executionService>, tls: Awaited<ReturnType<typeof tlsProvider>>, home: string, base: string;
let worker: ChildProcess | undefined;
const messages: any[] = []; let childErrors = '';
const ownedTenants: string[] = [];
let workerEnv: NodeJS.ProcessEnv;
async function until<T>(check: () => Promise<T> | T, timeout = 15000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await check(); if (result) return result; await new Promise((ok) => setTimeout(ok, 25)); }
  throw new Error('FIXTURE_WAIT_TIMEOUT');
}
async function stopWorker() {
  if (!worker) return; const child = worker; worker = undefined;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((ok) => child.once('exit', () => ok())); child.kill('SIGKILL'); await exited;
}
async function startWorker(pause?: string) {
  await stopWorker(); messages.length = 0;
  worker = spawn(process.execPath, ['--import', './test/fixtures/no-sdk-launchers.mjs', 'test/fixtures/execution-worker.mjs'], { env: { ...workerEnv, ...(pause ? { TASK_PAUSE_STAGE: pause } : {}) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  worker.on('message', (value) => messages.push(value)); worker.stderr!.on('data', (chunk) => { childErrors += chunk.toString(); });
  await until(() => messages.some((message) => message.stage === 'ready'));
}
async function seed() {
  const tenant = randomUUID(), user = randomUUID(), group = randomUUID(), key = randomUUID(), issued = issueAccessKey();
  await db.pool.query('INSERT INTO tenants(id,slug,name) VALUES($1,$2,$2)', [tenant, `b-${tenant}`]); ownedTenants.push(tenant);
  await withTransaction(db, async (tx) => {
    await lockTenant(tx, tenant);
    await tx.query("INSERT INTO users(id,tenant_id,username,display_name,password_hash) VALUES($1,$2,'member','Member','unused-service-fixture')", [user, tenant]);
    await tx.query("INSERT INTO groups(id,tenant_id,name) VALUES($1,$2,'Execution')", [group, tenant]);
    await tx.query("INSERT INTO api_keys(id,tenant_id,user_id,group_id,name,token_hash,prefix) VALUES($1,$2,$3,$4,'test',$5,$6)", [key, tenant, user, group, issued.hash, issued.prefix]);
    for (const mode of ['exa', 'chat_completions', 'messages']) {
      const provider = await service.providers.create(tx, tenant, { name: mode, provider_id: mode === 'exa' ? 'exa' : 'grok-multi-agent', base_url: tls.base, secret: `fixture-${mode}-secret`, ...(mode === 'exa' ? {} : { options: { api_mode: mode } }) });
      for (const operation of mode === 'exa' ? ['search', 'contents'] : ['research']) {
        const lane = mode === 'exa' ? `exa.${operation}` : `gma.${mode}`;
        await tx.query("INSERT INTO lanes(tenant_id,id,kind,provider_id,operation_id,latency,cost) VALUES($1,$2,$3,$4,$5,'fast','cheap')", [tenant, lane, operation === 'contents' ? 'fetch' : 'search', provider.id, operation]);
        await tx.query('INSERT INTO group_lanes(tenant_id,group_id,lane_id) VALUES($1,$2,$3)', [tenant, group, lane]);
      }
    }
    await tx.query("UPDATE groups SET default_search_lane='exa.search',default_fetch_pipeline='exa.contents' WHERE id=$1", [group]);
  });
  const client = createNbSearchRemoteClient({ base_url: base, access_key: issued.accessKey, allow_loopback_http: true, timeout_ms: 20000 });
  return { tenant, user, group, key, issued, client, principal: { tenantId: tenant, userId: user, groupId: group, keyId: key } };
}
async function terminal(client: any, id: string) { return until(async () => { const result = await client.search({ action: 'get', job_id: id }); return ['succeeded', 'failed', 'cancelled'].includes(result.state) ? result : false; }); }
async function raw(token: string, kind: string, input: unknown, headers: Record<string,string> = {}) {
  const result = await fetch(`${base}/v1/${kind}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-nb-search-protocol': '1', ...headers }, body: JSON.stringify(input) });
  return { status: result.status, headers: result.headers, body: await result.json() as any };
}
beforeAll(async () => {
  await prepareIntegrationDatabase(true); db = createDb(integrationDatabaseUrl(), { max: 20 }); tls = await tlsProvider(); home = await mkdtemp(resolve(tmpdir(), 'nbcloud-task18-execution-'));
  const key = randomBytes(32).toString('base64');
  workerEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, DATABASE_URL: integrationDatabaseUrl(), CLOUD_SECRET_MASTER_KEY: key, CLOUD_SECRET_KEY_ID: 'task-fixture', CLOUD_EXECUTION_HOME: resolve(home, 'worker'), TASK_PROVIDER_PORT: String(tls.port), TASK_CA_CERT: tls.cert.toString() };
  const poisonHome = resolve(home, 'unrelated-personal-fixture'); await mkdir(poisonHome); await writeFile(resolve(poisonHome, 'config.json'), '{invalid-personal-fixture-config');
  Object.assign(workerEnv, { NB_SEARCH_HOME: poisonHome, HOME: poisonHome, USERPROFILE: poisonHome, NB_SEARCH_EXA_API_KEY: 'must-not-inherit-personal-canary', NB_SEARCH_GROK_API_KEY: 'must-not-inherit-personal-canary', NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: `http://127.0.0.1:${tls.port}`, HTTP_PROXY: `http://127.0.0.1:${tls.port}` });
  service = executionService(db, workerEnv);
  app = buildApp({ db, env: { DATABASE_URL: integrationDatabaseUrl(), PUBLIC_ORIGIN: 'http://127.0.0.1:3000', COOKIE_MODE: 'loopback' }, registerAdditionalRoutes: service.register });
  base = await app.listen({ host: '127.0.0.1', port: 0 });
});
afterEach(async () => {
  await stopWorker(); if (!db) return;
  // After assertions, restore only our fixture credentials so failed expiry cases can be cancelled safely.
  await db.pool.query('UPDATE api_keys SET expires_at=NULL WHERE tenant_id=ANY($1::uuid[]) AND expires_at IS NOT NULL', [ownedTenants]);
  // A failing vector must not dispatch its queued fixtures in the next test.
  const pending = (await db.pool.query("SELECT * FROM jobs WHERE tenant_id=ANY($1::uuid[]) AND state IN ('queued','running')", [ownedTenants])).rows;
  for (const job of pending) await service.store.cancel({ tenantId: job.tenant_id, userId: job.user_id, keyId: job.admitting_key_id, groupId: job.group_id }, job.kind, job.id);
  await db.pool.query("UPDATE jobs SET lease_expires_at=now()-interval '1 second' WHERE tenant_id=ANY($1::uuid[]) AND state='running'", [ownedTenants]);
  await service.store.reconcile();
});
afterAll(async () => { await stopWorker(); if (app) await app.close(); if (db) await closeDb(db); if (tls) await tls.close(); if (home) await rm(home, { recursive: true, force: true }); });

it('runs actual SDK search/fetch and both typed modes through HTTP, pinned TLS, restricted PG and a separate worker', async () => {
  const f = await seed(); await startWorker();
  const caps: any = await f.client.capabilities({}); expect(JSON.stringify(caps)).not.toContain(tls.base);
  for (const lane of ['exa.search', 'gma.chat_completions', 'gma.messages']) {
    const output: any = await f.client.search({ action: 'run', query: 'fixture evidence', lane });
    expect(output.status).toBe('succeeded'); expect(output.execution).toBe('sync');
    expect(output.output.channel).toBe(lane === 'exa.search' ? 'results' : 'typed');
    if (lane.startsWith('gma.')) expect(output.output.data.api_mode).toBe(lane.slice(4));
  }
  const fetched: any = await f.client.fetch({ action: 'run', source: { kind: 'url', url: 'https://source.example/document' } });
  expect(fetched.status).toBe('succeeded'); expect(fetched.documents[0].content).toContain('Trusted local evidence.');
  const fetchJob = (await db.pool.query("SELECT id FROM jobs WHERE tenant_id=$1 AND kind='fetch'", [f.tenant])).rows[0];
  const fetchState: any = await f.client.fetch({ action: 'get', job_id: fetchJob.id }); expect(fetchState.artifact.byte_length).toBeGreaterThan(0);
  const fetchPage: any = await f.client.fetch({ action: 'read', job_id: fetchJob.id });
  expect(JSON.parse(Buffer.concat(fetchPage.chunks.map((chunk: any) => Buffer.from(chunk.data_base64, 'base64'))).toString()).documents[0].content).toBe(fetched.documents[0].content);
  expect(tls.seen.map((entry) => entry.path)).toEqual(expect.arrayContaining(['/search', '/contents', '/chat/completions', '/messages']));
  expect(childErrors).toBe('');
  await db.pool.query("UPDATE lanes SET status='disabled' WHERE tenant_id=$1 AND id='exa.search'", [f.tenant]);
  const reduced: any = await f.client.capabilities({});
  expect(reduced.search.lanes.find((lane: any) => lane.id === 'exa.search')).toMatchObject({ availability: 'unavailable', execution_modes: [] });
  expect(reduced.fetch.pipelines.find((lane: any) => lane.id === 'exa.contents').availability).toBe('ready');
  expect(reduced.providers.instances.find((provider: any) => provider.provider_id === 'exa').availability).toBe('ready');
  const missingKey = executionService(db, {});
  const missingCaps = await withTransaction(db, async (tx) => { await lockTenant(tx, f.tenant); return (await import('../../src/execution/capabilities.js')).capabilities(tx, f.principal, missingKey.ready); });
  expect(missingCaps.search.lanes.every((lane) => lane.availability === 'unavailable' && lane.execution_modes.length === 0)).toBe(true);
});
it('delivers >70KiB async artifacts with immutable hash/chunks while sync fails OUTPUT_TOO_LARGE; real CLI uses HTTP', async () => {
  const f = await seed(); await startWorker();
  const sync: any = await f.client.search({ action: 'run', query: 'large-output', lane: 'exa.search' });
  expect(sync.status).toBe('failed'); expect(sync.error.code).toBe('OUTPUT_TOO_LARGE');
  const run: any = await f.client.search({ action: 'run', execution: 'async', query: 'large-output', lane: 'exa.search', idempotency_key: 'large-one' });
  expect(run.status).toBe('queued'); const job = await terminal(f.client, run.job.job_id); expect(job.state).toBe('succeeded'); expect(job.artifact.byte_length).toBeGreaterThan(70 * 1024);
  const chunks: Buffer[] = []; let cursor: string | undefined;
  do { const page: any = await f.client.search({ action: 'read', job_id: run.job.job_id, ...(cursor ? { cursor } : {}), page_size: 2 });
    for (const chunk of page.chunks) { expect(chunk.byte_length).toBeLessThanOrEqual(12288); chunks.push(Buffer.from(chunk.data_base64, 'base64')); }
    cursor = page.next_cursor;
  } while (cursor);
  const bytes = Buffer.concat(chunks); expect(bytes.length).toBe(job.artifact.byte_length); expect(createHash('sha256').update(bytes).digest('hex')).toBe(job.artifact.sha256);
  expect(Date.parse(job.artifact.expires_at) - Date.parse(job.completed_at)).toBe(72 * 3600 * 1000);
  await expect(db.pool.query('UPDATE artifacts SET sha256=$2 WHERE job_id=$1', [run.job.job_id, '0'.repeat(64)])).rejects.toMatchObject({ code: 'P0001' });
  await expect(db.pool.query("UPDATE artifact_chunks SET data=decode('00','hex'),byte_length=1 WHERE job_id=$1", [run.job.job_id])).rejects.toMatchObject({ code: 'P0001' });
  const cliHome = resolve(home, randomUUID()); await mkdir(cliHome, { mode: 0o700 });
  if (process.platform === 'win32') {
    // Restrict only this newly-created task fixture; never repair or relax a user's existing CLI home.
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; $p=$env:TASK_CLI_HOME; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=Get-Acl -LiteralPath $p; $acl.SetAccessRuleProtection($true,$false); foreach($rule in @($acl.Access)){$acl.RemoveAccessRuleSpecific($rule)}; $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule); Set-Acl -LiteralPath $p -AclObject $acl"], { env: { ...process.env, TASK_CLI_HOME: cliHome }, stdio: 'ignore', timeout: 15000 });
  }
  await writeFile(resolve(cliHome, 'profiles.json'), JSON.stringify({ schema_version: '1', profiles: { cloud: { kind: 'remote', base_url: base, allow_loopback_http: true, token_env: 'TASK_TOKEN' } } }));
  async function cli(kind: 'search' | 'fetch' | 'capabilities', input?: unknown, expectedExit = 0) {
    const child = spawn(process.execPath, [await realpath('node_modules/@nb-corp/nb-search/dist/cli.mjs'), '--profile', 'cloud', kind, ...(input === undefined ? [] : ['--stdin'])], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NB_SEARCH_HOME: cliHome, TASK_TOKEN: f.issued.accessKey }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = ''; child.stdout.on('data', (v) => { out += v; }); child.stderr.on('data', (v) => { err += v; }); child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
    const exit = await new Promise((ok) => child.on('close', ok)); expect(err).toBe(''); expect(exit).toBe(expectedExit); return JSON.parse(out);
  }
  expect((await cli('capabilities')).search.lanes).toHaveLength(3);
  expect((await cli('search', { action: 'run', query: 'CLI fixture' })).status).toBe('succeeded');
  expect((await cli('fetch', { action: 'run', source: { kind: 'url', url: 'https://source.example/document' } })).status).toBe('succeeded');
  expect((await cli('search', { action: 'run', query: 'CLI typed fixture', lane: 'gma.messages' })).output.channel).toBe('typed');
  const cliRun = await cli('search', { action: 'run', execution: 'async', query: 'CLI async fixture', idempotency_key: 'cli-async' }, 7);
  await terminal(f.client, cliRun.job.job_id);
  expect((await cli('search', { action: 'get', job_id: cliRun.job.job_id })).state).toBe('succeeded');
  expect((await cli('search', { action: 'read', job_id: cliRun.job.job_id, page_size: 1 })).chunks.length).toBeGreaterThan(0);
  expect((await cli('search', { action: 'cancel', job_id: cliRun.job.job_id })).state).toBe('succeeded');
});
it('enforces protocol errors, unknown/unowned/wrong-kind job 404 and same-group rotation recovery without another dispatch', async () => {
  const f = await seed(), other = await seed(); await startWorker();
  expect((await raw(f.issued.accessKey, 'search', { action: 'run', query: 'q' }, { 'x-nb-search-protocol': '2' })).status).toBe(426);
  expect((await raw(f.issued.accessKey, 'search', { action: 'run', query: 'q' }, { cookie: 'x=y' })).status).toBe(401);
  const input = { action: 'run' as const, execution: 'async' as const, query: 'rotation', idempotency_key: 'rotation' };
  const receipt: any = await f.client.search(input); await terminal(f.client, receipt.job.job_id);
  for (const [token, kind, id] of [[f.issued.accessKey, 'search', randomUUID()], [other.issued.accessKey, 'search', receipt.job.job_id], [f.issued.accessKey, 'fetch', receipt.job.job_id]]) expect((await raw(token!, kind!, { action: 'get', job_id: id })).status).toBe(404);
  const rotated = issueAccessKey(); await db.pool.query("INSERT INTO api_keys(id,tenant_id,user_id,group_id,name,token_hash,prefix,quota_units) VALUES($1,$2,$3,$4,'rotated',$5,$6,1)", [randomUUID(), f.tenant, f.user, f.group, rotated.hash, rotated.prefix]);
  await db.pool.query('UPDATE groups SET daily_units_per_user=1 WHERE id=$1', [f.group]); await db.pool.query("UPDATE api_keys SET status='disabled' WHERE id=$1", [f.key]);
  const before = tls.seen.length; const recovered = await raw(rotated.accessKey, 'search', input);
  expect(recovered.status).toBe(200); expect(recovered.body.reused).toBe(true); expect(recovered.body.job.job_id).toBe(receipt.job.job_id); expect(tls.seen.length).toBe(before);
  expect((await raw(rotated.accessKey, 'search', { ...input, query: 'conflict' })).status).toBe(409);
  expect((await raw(rotated.accessKey, 'search', { action: 'run', query: 'new' })).status).toBe(429);
  await db.pool.query("DELETE FROM group_lanes WHERE tenant_id=$1 AND group_id=$2 AND lane_id='exa.search'", [f.tenant, f.group]);
  expect((await raw(rotated.accessKey, 'search', { action: 'get', job_id: receipt.job.job_id })).status).toBe(404);
  expect((await raw(rotated.accessKey, 'search', input)).status).toBe(403);
});
it('kills an owned worker before marker, recovers its lease, fences stale completion, then never redispatches after marker loss', async () => {
  const f = await seed(); await startWorker('prepared');
  const receipt: any = await f.client.search({ action: 'run', execution: 'async', query: 'before-kill', idempotency_key: 'before-kill' });
  const held = await until(() => messages.find((message) => message.stage === 'prepared' && message.id === receipt.job.job_id));
  const old = (await db.pool.query('SELECT * FROM jobs WHERE id=$1', [held.id])).rows[0]; const before = tls.seen.length;
  await stopWorker(); await db.pool.query("UPDATE jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [held.id]); await startWorker();
  expect((await terminal(f.client, held.id)).state).toBe('succeeded'); expect(tls.seen.length - before).toBe(1);
  expect(await service.store.complete(old, { state: 'failed', envelope: {} })).toBe(false);
  await startWorker();
  const after: any = await f.client.search({ action: 'run', execution: 'async', query: 'hang-worker-after-kill', idempotency_key: 'after-kill' });
  await until(() => messages.find((message) => message.stage === 'dispatched' && message.id === after.job.job_id));
  await until(() => tls.seen.some((request) => request.body.query === 'hang-worker-after-kill'));
  const afterCount = tls.seen.length; await stopWorker(); await db.pool.query("UPDATE jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [after.job.job_id]); await startWorker();
  const terminalAfter = await terminal(f.client, after.job.job_id); expect(terminalAfter.state).toBe('failed'); expect(tls.seen.length).toBe(afterCount);
  const reservation = (await db.pool.query('SELECT state,reason FROM usage_reservations WHERE job_id=$1', [after.job.job_id])).rows[0]; expect(reservation.state).toBe('settled');
  await service.store.reconcile(); expect((await db.pool.query("SELECT count(*)::int AS n FROM usage_events WHERE job_id=$1 AND event='settle'", [after.job.job_id])).rows[0].n).toBe(1);
});
it('freezes first config/base/default and SDK version; supports queued cancellation and retained bucket settlement across UTC days', async () => {
  const f = await seed(); await stopWorker();
  const wire = { action: 'run' as const, execution: 'async' as const, query: 'frozen', idempotency_key: 'frozen' };
  const receipt: any = await f.client.search(wire);
  const original = (await db.pool.query('SELECT * FROM jobs WHERE id=$1', [receipt.job.job_id])).rows[0];
  const selected = original.first_plan.selected[0];
  await withTransaction(db, async (tx) => {
    await lockTenant(tx, f.tenant);
    await service.providers.patch(tx, f.tenant, selected.provider_resource_id, { expected_revision: 1, base_url: tls.base + '/changed', secret: 'fixture-new-secret' });
    await tx.query("UPDATE groups SET default_search_lane='gma.messages' WHERE id=$1", [f.group]);
    // Controlled midnight fixture: admission reservation belongs to yesterday; settlement occurs today.
    await tx.query("INSERT INTO group_usage_buckets(tenant_id,user_id,group_id,utc_day,reserved_units) VALUES($1,$2,$3,(now() AT TIME ZONE 'UTC')::date-1,1)", [f.tenant, f.user, f.group]);
    await tx.query("UPDATE usage_reservations SET utc_day=(now() AT TIME ZONE 'UTC')::date-1 WHERE job_id=$1", [receipt.job.job_id]);
    await tx.query("UPDATE usage_events SET utc_day=(now() AT TIME ZONE 'UTC')::date-1 WHERE job_id=$1", [receipt.job.job_id]);
    await tx.query("UPDATE group_usage_buckets SET reserved_units=0 WHERE tenant_id=$1 AND user_id=$2 AND group_id=$3 AND utc_day=(now() AT TIME ZONE 'UTC')::date", [f.tenant, f.user, f.group]);
  });
  const differentVersion = new (await import('../../src/execution/store.js')).ExecutionStore(db, 'future-version', service.ready);
  const replay = await differentVersion.admit(f.principal, 'search', original.first_plan.parsed_wire, randomUUID());
  expect(replay.job.first_plan).toEqual(original.first_plan); expect(replay.reused).toBe(true);
  const before = tls.seen.length; await startWorker(); expect((await terminal(f.client, receipt.job.job_id)).state).toBe('succeeded');
  expect(tls.seen[before]).toMatchObject({ path: '/search', headers: { 'x-api-key': 'fixture-exa-secret' } });
  const buckets = (await db.pool.query("SELECT utc_day::text,reserved_units,used_units,utc_day=(now() AT TIME ZONE 'UTC')::date AS today FROM group_usage_buckets WHERE tenant_id=$1 ORDER BY utc_day", [f.tenant])).rows;
  expect(buckets).toEqual([expect.objectContaining({ reserved_units: '0', used_units: '1', today: false }), expect.objectContaining({ reserved_units: '0', used_units: '0', today: true })]);
  await stopWorker();
  const queued: any = await f.client.search({ ...wire, idempotency_key: 'cancel-queued' });
  const cancelled: any = await f.client.search({ action: 'cancel', job_id: queued.job.job_id }); expect(cancelled.state).toBe('cancelled');
  const reservation = (await db.pool.query('SELECT state FROM usage_reservations WHERE job_id=$1', [queued.job.job_id])).rows[0]; expect(reservation.state).toBe('released');
  expect((await f.client.search({ action: 'cancel', job_id: queued.job.job_id }) as any).state).toBe('cancelled');
});
it('exposes real management wrappers and quota-reset 409 without clearing group usage; rejects stale/expired artifact cursors', async () => {
  const f = await seed(); await stopWorker();
  const { hashPassword } = await import('../../src/auth/password.js');
  await db.pool.query("UPDATE users SET role='admin',password_hash=$2 WHERE id=$1", [f.user, await hashPassword('Task-only-admin-password')]);
  const login = await fetch(base + '/api/admin/auth/login', { method: 'POST', headers: { origin: 'http://127.0.0.1:3000', 'content-type': 'application/json' }, body: JSON.stringify({ tenant: `b-${f.tenant}`, username: 'member', password: 'Task-only-admin-password' }) });
  expect(login.status).toBe(200); const session: any = await login.json(); const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  async function admin(path: string, method = 'GET', body?: unknown) {
    const response = await fetch(base + '/api/admin' + path, { method, headers: { cookie, origin: 'http://127.0.0.1:3000', 'content-type': 'application/json', 'x-csrf-token': session.data.csrf_token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  }
  const deniedConnections = tls.connections;
  expect((await admin('/providers', 'POST', { name: 'invalid-private', provider_id: 'exa', base_url: `https://127.0.0.1:${tls.port}`, secret: 'fixture-invalid-secret' })).status).toBe(422);
  expect((await admin('/providers', 'POST', { name: 'invalid-mode', provider_id: 'grok-multi-agent', base_url: tls.base + '/messages', options: { api_mode: 'chat_completions' } })).status).toBe(422);
  expect(tls.connections).toBe(deniedConnections);
  const providers = await admin('/providers?limit=1'); expect(providers.body.data.items).toHaveLength(1); expect(providers.body.data.next_cursor).toBeTypeOf('string');
  expect((await admin('/lanes')).body.data.items).toHaveLength(4);
  const cap = await admin(`/groups/${f.group}/capabilities`); expect(cap.body.data.lanes.every((lane: any) => lane.configured)).toBe(true);
  expect((await admin(`/groups/${f.group}/capabilities`, 'PUT', { expected_revision: cap.body.data.revision, lanes: cap.body.data.lanes.map((lane: any) => ({ lane_id: lane.lane_id, units_per_query: lane.units_per_query })), default_search_lane: 'exa.search', default_fetch_pipeline: 'exa.contents', presets: {} })).status).toBe(200);
  const created = await admin('/providers', 'POST', { name: 'metadata fixture', provider_id: 'exa', base_url: tls.base }); expect(created.status).toBe(201); expect(created.body.data.credential_configured).toBe(false);
  const secret = await admin(`/providers/${created.body.data.id}`, 'PATCH', { expected_revision: 1, secret: 'fixture-write-only-secret' }); expect(secret.status).toBe(200); expect(secret.body.data.credential_configured).toBe(true); expect(JSON.stringify(secret.body)).not.toContain('fixture-write-only-secret');
  expect((await admin(`/providers/${created.body.data.id}`, 'PATCH', { expected_revision: 2, clear_secret: true })).body.data.credential_configured).toBe(false);
  expect((await admin('/lanes', 'POST', { id: 'exa.admin', provider_id: created.body.data.id, operation_id: 'search', latency: 'fast', cost: 'cheap' })).status).toBe(201);
  const queued: any = await f.client.search({ action: 'run', execution: 'async', query: 'quota-admin', idempotency_key: 'quota-admin' });
  const blocked = await admin(`/keys/${f.key}/reset-quota`, 'POST', { expected_revision: 1 }); expect(blocked.status).toBe(409); expect(blocked.body.error.code).toBe('ACTIVE_RESERVATIONS');
  await startWorker(); await terminal(f.client, queued.job.job_id); await stopWorker();
  const usage = await admin('/usage'); expect(usage.status).toBe(200); expect(usage.body.data.items).toEqual([expect.objectContaining({ job_id: queued.job.job_id, charged_units: 1, reserved_units: 0 })]); expect(usage.body.data.totals).toEqual({ reserved: 0, charged: 1, released: 0 });
  expect((await admin(`/keys/${f.key}/usage`)).status).toBe(200); expect((await admin('/me/quotas')).status).toBe(200);
  expect((await admin(`/keys/${f.key}/reset-quota`, 'POST', { expected_revision: 1 })).status).toBe(200);
  expect((await db.pool.query('SELECT used_units FROM group_usage_buckets WHERE tenant_id=$1', [f.tenant])).rows[0].used_units).toBe('1');
  expect((await db.pool.query('SELECT quota_epoch FROM api_keys WHERE id=$1', [f.key])).rows[0].quota_epoch).toBe(2);
  const badCursor = Buffer.from(JSON.stringify({ v: 1, job_id: queued.job.job_id, sha256: '0'.repeat(64), next_index: 0 })).toString('base64url');
  expect((await raw(f.issued.accessKey, 'search', { action: 'read', job_id: queued.job.job_id, cursor: badCursor })).status).toBe(400);
  const manifest = (await db.pool.query('SELECT sha256,byte_length FROM artifacts WHERE job_id=$1', [queued.job.job_id])).rows[0];
  for (const next_index of [2147483648, Number.MAX_SAFE_INTEGER + 1, Math.ceil(manifest.byte_length / 12288)]) {
    const cursor = Buffer.from(JSON.stringify({ v: 1, job_id: queued.job.job_id, sha256: manifest.sha256, next_index })).toString('base64url');
    const remote = await raw(f.issued.accessKey, 'search', { action: 'read', job_id: queued.job.job_id, cursor });
    expect(remote.status, 'B-EXEC-CURSOR01').toBe(400); expect(remote.body.error).toMatchObject({ code: 'INVALID_REQUEST', retryable: false });
    const browser = await admin(`/jobs/${queued.job.job_id}/read`, 'POST', { cursor });
    expect(browser.status, 'B-EXEC-CURSOR01 admin').toBe(422); expect(browser.body.error.code).toBe('VALIDATION_FAILED');
  }
  await expect(db.pool.query("UPDATE jobs SET expires_at=now()-interval '1 second' WHERE id=$1", [queued.job.job_id])).rejects.toMatchObject({ code: 'P0001' });
  const historical = randomUUID();
  await db.pool.query("INSERT INTO jobs(id,tenant_id,user_id,group_id,admitting_key_id,kind,delivery,state,first_plan,selection,request_id,created_at,completed_at,expires_at) SELECT $2,tenant_id,user_id,group_id,admitting_key_id,kind,delivery,'succeeded',first_plan,selection,'historical',now()-interval '5 days',now()-interval '4 days',now()-interval '1 day' FROM jobs WHERE id=$1", [queued.job.job_id, historical]);
  await db.pool.query("INSERT INTO artifacts(job_id,tenant_id,byte_length,sha256,expires_at) SELECT $2,tenant_id,byte_length,sha256,now()-interval '1 day' FROM artifacts WHERE job_id=$1", [queued.job.job_id, historical]);
  await db.pool.query('INSERT INTO artifact_chunks(tenant_id,job_id,index,"offset",byte_length,data) SELECT tenant_id,$2,index,"offset",byte_length,data FROM artifact_chunks WHERE job_id=$1', [queued.job.job_id, historical]);
  expect((await raw(f.issued.accessKey, 'search', { action: 'read', job_id: historical })).status).toBe(404);
  const beyondRetention = randomUUID();
  await db.pool.query("INSERT INTO jobs(id,tenant_id,user_id,group_id,admitting_key_id,kind,delivery,state,first_plan,selection,request_id,created_at,completed_at,expires_at) SELECT $2,tenant_id,user_id,group_id,admitting_key_id,kind,delivery,'succeeded',first_plan,selection,'historical-91-days',now()-interval '95 days',now()-interval '94 days',now()-interval '91 days' FROM jobs WHERE id=$1", [queued.job.job_id, beyondRetention]);
  for (const id of [historical, beyondRetention]) await db.pool.query('INSERT INTO job_config_refs(tenant_id,job_id,config_id) SELECT tenant_id,$2,config_id FROM job_config_refs WHERE job_id=$1', [queued.job.job_id, id]);
  await service.store.cleanup(); expect((await db.pool.query('SELECT count(*)::int AS n FROM artifact_chunks WHERE job_id=$1', [historical])).rows[0].n).toBe(0);
  expect((await db.pool.query('SELECT first_plan,purged_at FROM jobs WHERE id=$1', [historical])).rows[0]).toEqual({ first_plan: null, purged_at: expect.any(Date) });
  expect((await db.pool.query('SELECT count(*)::int AS n FROM jobs WHERE id=$1', [beyondRetention])).rows[0].n).toBe(0);
  expect((await db.pool.query('SELECT used_units FROM key_usage_buckets WHERE tenant_id=$1 AND key_id=$2 AND epoch=1', [f.tenant, f.key])).rows[0].used_units).toBe('1');
});
it('checks canonical HTTP vectors and principal namespace, strict JSON/media/size, and unsupported operations without dispatch', async () => {
  const f = await seed(); await stopWorker(); const before = tls.seen.length;
  const wire = { action: 'run', execution: 'async', query: 'canonical', idempotency_key: 'canonical' };
  const first = await raw(f.issued.accessKey, 'search', wire); expect(first.status).toBe(200);
  const equivalent = await raw(f.issued.accessKey, 'search', { ...wire, query: ['canonical'] }); expect(equivalent.body.job.job_id).toBe(first.body.job.job_id); expect(equivalent.body.reused).toBe(true);
  for (const change of [{ query: ['canonical', 'canonical'] }, { max_results: 8 }, { timeout_ms: 30000 }, { lane: 'exa.search' }, { lanes: ['exa.search'] }]) expect((await raw(f.issued.accessKey, 'search', { ...wire, ...change })).status).toBe(409);
  const sibling = randomUUID(), key = issueAccessKey();
  await db.pool.query("INSERT INTO users(id,tenant_id,username,display_name,password_hash) VALUES($1,$2,'sibling','Sibling','unused')", [sibling, f.tenant]);
  await db.pool.query("INSERT INTO api_keys(id,tenant_id,user_id,group_id,name,token_hash,prefix) VALUES($1,$2,$3,$4,'sibling',$5,$6)", [randomUUID(), f.tenant, sibling, f.group, key.hash, key.prefix]);
  const distinct = await raw(key.accessKey, 'search', wire); expect(distinct.body.job.job_id).not.toBe(first.body.job.job_id);
  expect((await raw(key.accessKey, 'search', { action: 'get', job_id: first.body.job.job_id })).status).toBe(404);
  const headers = { authorization: `Bearer ${f.issued.accessKey}`, 'x-nb-search-protocol': '1', 'content-type': 'application/json' };
  for (let round = 0; round < 3; round++) for (const [body, contentType, status] of [['{', 'application/json', 400], ['{}', 'text/plain', 415], [JSON.stringify({ query: 'x'.repeat(1_048_576) }), 'application/json', 413]] as const) {
    const response = await fetch(base + '/v1/search', { method: 'POST', headers: { ...headers, 'content-type': contentType }, body }); expect(response.status).toBe(status);
    expect((await response.json() as any).error.code).toBe(status === 400 ? 'INVALID_REQUEST' : status === 415 ? 'UNSUPPORTED_MEDIA_TYPE' : 'REQUEST_TOO_LARGE');
    if (status === 413) expect(response.headers.get('connection')).toBe('close');
  }
  expect((await raw(f.issued.accessKey, 'fetch', { action: 'run', source: { kind: 'inline_text', text: 'not allowed' } })).status).toBe(400);
  const browser = await raw(f.issued.accessKey, 'fetch', { action: 'run', source: { kind: 'url', url: 'https://source.example/document' }, pipeline: 'browser.render' }); expect(browser.status).toBe(403);
  const asyncFetch = await raw(f.issued.accessKey, 'fetch', { action: 'run', execution: 'async', idempotency_key: 'fetch-unsupported', source: { kind: 'url', url: 'https://source.example/document' } }); expect(asyncFetch.body.error.code).toBe('LANE_EXECUTION_UNSUPPORTED');
  expect(tls.seen.length).toBe(before);
  await raw(f.issued.accessKey, 'search', { action: 'cancel', job_id: first.body.job.job_id }); await raw(key.accessKey, 'search', { action: 'cancel', job_id: distinct.body.job.job_id });
});
it('does not implicitly retry provider failure and settles in-flight cancellation once', async () => {
  const f = await seed(); await startWorker(); const before = tls.seen.length;
  const failure: any = await f.client.search({ action: 'run', execution: 'async', query: 'reject-once', idempotency_key: 'reject-once' });
  expect((await terminal(f.client, failure.job.job_id)).state).toBe('failed'); expect(tls.seen.length - before).toBe(1);
  const run: any = await f.client.search({ action: 'run', execution: 'async', query: 'hang-worker-cancel', idempotency_key: 'running-cancel' });
  await until(() => tls.seen.some((request) => request.body.query === 'hang-worker-cancel'));
  await f.client.search({ action: 'cancel', job_id: run.job.job_id }); expect((await terminal(f.client, run.job.job_id)).state).toBe('cancelled');
  await f.client.search({ action: 'cancel', job_id: run.job.job_id });
  expect((await db.pool.query('SELECT state FROM usage_reservations WHERE job_id=$1', [run.job.job_id])).rows[0].state).toBe('settled');
  expect((await db.pool.query("SELECT count(*)::int AS n FROM usage_events WHERE job_id=$1 AND event='settle'", [run.job.job_id])).rows[0].n).toBe(1);
  const syncResponse = f.client.search({ action: 'run', query: 'hang-worker-sync-cancel' });
  await until(() => tls.seen.some((request) => request.body.query === 'hang-worker-sync-cancel'));
  const syncJob = (await db.pool.query("SELECT id FROM jobs WHERE tenant_id=$1 AND delivery='sync'", [f.tenant])).rows[0];
  await f.client.search({ action: 'cancel', job_id: syncJob.id });
  const cancelled: any = await syncResponse; expect(cancelled.status).toBe('cancelled'); expect(cancelled.error.code).toBe('CANCELLED');
});
it('starts the normal compiled API and worker entry points as owned independent processes', async () => {
  const f = await seed(); await stopWorker();
  const socket = (await import('node:net')).createServer(); await new Promise<void>((ok) => socket.listen(0, '127.0.0.1', ok)); const port = (socket.address() as { port: number }).port; await new Promise<void>((ok) => socket.close(() => ok()));
  const env = { ...workerEnv, PUBLIC_ORIGIN: `http://127.0.0.1:${port}`, COOKIE_MODE: 'loopback', HOST: '127.0.0.1', PORT: String(port) };
  const api = spawn(process.execPath, ['dist/server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const normalWorker = spawn(process.execPath, ['dist/server.js', 'worker'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = ''; api.stderr.on('data', (data) => { errors += data; }); normalWorker.stderr.on('data', (data) => { errors += data; });
  try {
    await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/health/ready`)).status === 200; } catch { return false; } });
    const remote = createNbSearchRemoteClient({ base_url: `http://127.0.0.1:${port}`, access_key: f.issued.accessKey, allow_loopback_http: true });
    const caps: any = await remote.capabilities({}); expect(caps.search.lanes).toHaveLength(3); expect(caps.fetch.pipelines[0].execution_modes).toEqual(['sync']);
    expect(caps.search.lanes.every((lane: any) => lane.availability === 'ready')).toBe(true); expect(caps.fetch.inputs.filter((input: any) => input.enabled).map((input: any) => input.kind)).toEqual(['url']);
    expect(normalWorker.exitCode).toBeNull(); expect(errors).toBe('');
  } finally {
    await Promise.all([api, normalWorker].map(async (child) => { if (child.exitCode !== null || child.signalCode !== null) return; const ended = new Promise<void>((ok) => child.once('exit', () => ok())); child.kill('SIGKILL'); await ended; }));
  }
});
async function acrossExpiry(tenant: string, expiry: Date, start: () => Promise<any>) {
  const holder = await db.pool.connect(); let pending: Promise<any> | undefined;
  try {
    await holder.query('BEGIN'); await holder.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [tenant]);
    const pid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    pending = start().then((value) => ({ value }), (error) => ({ error }));
    await until(async () => { await holder.query('SELECT pg_stat_clear_snapshot()'); return (await holder.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked', [pid])).rows[0].blocked; });
    expect((await holder.query('SELECT clock_timestamp()<$1::timestamptz AS valid', [expiry])).rows[0].valid).toBe(true);
    // PG stores microseconds; JS Date round-trips milliseconds. Wait past that precision gap too.
    await until(async () => (await holder.query("SELECT clock_timestamp()>$1::timestamptz+interval '50 milliseconds' AS expired", [expiry])).rows[0].expired);
    expect((await holder.query("SELECT coalesce(bool_and(lease_expires_at>clock_timestamp()),true) AS valid FROM jobs WHERE tenant_id=$1 AND state='running'", [tenant])).rows[0].valid).toBe(true);
    await holder.query('COMMIT'); return await pending;
  } finally { await holder.query('ROLLBACK').catch(() => undefined); holder.release(); if (pending) await pending; }
}
it('B-EXEC-AUTH01 expires naturally while admission waits: no job or idempotency association', async () => {
  const f = await seed(); await stopWorker();
  const expiry = (await db.pool.query("UPDATE api_keys SET expires_at=clock_timestamp()+interval '2 seconds' WHERE id=$1 RETURNING expires_at", [f.key])).rows[0].expires_at;
  const result = await acrossExpiry(f.tenant, expiry, () => service.store.admit(f.principal, 'search', { action: 'run', execution: 'async', query: 'natural expiry', idempotency_key: 'natural-expiry' }, randomUUID()));
  try {
    expect(result.error?.code).toBe('UNAUTHENTICATED');
    expect((await db.pool.query('SELECT count(*)::int AS n FROM jobs WHERE tenant_id=$1', [f.tenant])).rows[0].n).toBe(0);
    expect((await db.pool.query('SELECT count(*)::int AS n FROM idempotency_admissions WHERE tenant_id=$1', [f.tenant])).rows[0].n).toBe(0);
  } finally { await db.pool.query('UPDATE api_keys SET expires_at=NULL WHERE id=$1', [f.key]); }
});
it('B-EXEC-AUTH01 naturally expired key cannot cross dispatch marker despite a valid lease', async () => {
  const f = await seed(); await startWorker('prepared'); const before = tls.seen.length;
  const admitted: any = await f.client.search({ action: 'run', execution: 'async', query: 'expiry dispatch', idempotency_key: 'expiry-dispatch' });
  await until(() => messages.some((message) => message.stage === 'prepared' && message.id === admitted.job.job_id));
  const expiry = (await db.pool.query("UPDATE api_keys SET expires_at=clock_timestamp()+interval '2 seconds' WHERE id=$1 RETURNING expires_at", [f.key])).rows[0].expires_at;
  await acrossExpiry(f.tenant, expiry, async () => {
    worker!.send({ command: 'resume' });
    return until(async () => { const job = (await db.pool.query('SELECT * FROM jobs WHERE id=$1', [admitted.job.job_id])).rows[0]; return ['failed','succeeded'].includes(job.state) ? job : false; });
  });
  try {
    const job = (await db.pool.query('SELECT * FROM jobs WHERE id=$1', [admitted.job.job_id])).rows[0];
    expect(job.dispatch_started_at).toBeNull(); expect(job.state).toBe('failed'); expect(tls.seen.length).toBe(before);
    const reservation = (await db.pool.query('SELECT state FROM usage_reservations WHERE job_id=$1', [job.id])).rows[0]; expect(reservation.state).toBe('released');
    await service.store.reconcile(); expect((await db.pool.query("SELECT count(*)::int AS n FROM usage_events WHERE job_id=$1 AND event='release'", [job.id])).rows[0].n).toBe(1);
  } finally { await db.pool.query('UPDATE api_keys SET expires_at=NULL WHERE id=$1', [f.key]); }
});
for (const credential of ['key','session'] as const) it(`B-EXEC-AUTH01 naturally expired ${credential} cannot get/read/cancel after waiting for lock`, async () => {
  const f = await seed(); await startWorker(); const receipt: any = await f.client.search({ action: 'run', execution: 'async', query: 'access expiry', idempotency_key: 'access-expiry' }); await terminal(f.client, receipt.job.job_id); await stopWorker();
  const session = randomUUID();
  if (credential === 'session') await db.pool.query('INSERT INTO sessions(id,tenant_id,user_id,token_hash,csrf_hash,password_version,expires_at) VALUES($1,$2,$3,$4,$5,1,clock_timestamp()+interval \'1 hour\')', [session, f.tenant, f.user, randomBytes(32), randomBytes(32)]);
  const principal = credential === 'key' ? f.principal : { tenantId: f.tenant, userId: f.user, sessionId: session, sessionAuthenticated: true as const };
  for (const action of ['get','read','cancel'] as const) {
    const expiry = (await db.pool.query(`UPDATE ${credential === 'key' ? 'api_keys' : 'sessions'} SET expires_at=clock_timestamp()+interval '2 seconds' WHERE id=$1 RETURNING expires_at`, [credential === 'key' ? f.key : session])).rows[0].expires_at;
    const result = await acrossExpiry(f.tenant, expiry, () => service.store[action](principal, 'search', receipt.job.job_id));
    expect(result.error?.code).toBe('UNAUTHENTICATED');
  }
});
for (const mode of ['chat_completions','messages'] as const) it(`review evidence: GMA ${mode} PG async artifact without SDK filesystem jobs or launchers`, async () => {
  const f = await seed(); await startWorker();
  const receipt: any = await f.client.search({ action: 'run', execution: 'async', query: 'typed async evidence', lane: `gma.${mode}`, idempotency_key: `typed-${mode}` });
  expect(receipt.execution).toBe('async'); expect(receipt.status).toBe('queued');
  const job = await terminal(f.client, receipt.job.job_id); expect(job.state).toBe('succeeded');
  const chunks: Buffer[] = []; let cursor: string | undefined;
  do { const page: any = await f.client.search({ action: 'read', job_id: receipt.job.job_id, ...(cursor ? { cursor } : {}), page_size: 1 });
    for (const chunk of page.chunks) chunks.push(Buffer.from(chunk.data_base64, 'base64')); cursor = page.next_cursor;
  } while (cursor);
  const bytes = Buffer.concat(chunks), artifact = JSON.parse(bytes.toString());
  expect(artifact.channel).toBe('typed'); expect(artifact.schema_id).toBe('nb-search.multi-agent-research@1'); expect(artifact.data.api_mode).toBe(mode);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(job.artifact.sha256);
  await until(() => messages.some((message) => message.stage === 'completed' && message.id === receipt.job.job_id));
  expect(messages.some((message) => message.stage === 'sdk-launch-monitor-ready')).toBe(true);
  expect(messages.some((message) => message.stage === 'sdk-child-attempt')).toBe(false);
  const homes = await readdir(resolve(home, 'worker')); expect(homes.length).toBeGreaterThan(0);
  for (const directory of homes) {
    await expect(stat(resolve(home, 'worker', directory, 'unused-jobs'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(resolve(home, 'worker', directory))).toEqual([]);
  }
});
