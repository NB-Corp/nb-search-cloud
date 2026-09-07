// Run from cloud root: pnpm exec tsx test/real/vertical.ts --setup-check | --browser
// --browser uses the already-built web/dist; it never rebuilds or substitutes UI/API behavior.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { buildApp } from '../../src/app.js';
import { registerConsole } from '../../src/console.js';
import { createDb, closeDb } from '../../src/db/client.js';
import { issueAccessKey } from '../../src/auth/api-key.js';
import { executionService } from '../../src/execution/service.js';
import { tlsProvider } from '../fixtures/tls-provider.js';
import { startTestDatabase, stopTestDatabase, withControlLock } from '../../scripts/test-database-control.mjs';
const mode = process.argv[2];
if (!['--setup-check', '--browser'].includes(mode ?? '')) throw Error('Use --setup-check or --browser');
const root = process.cwd(), nonce = randomUUID().slice(0, 8), project = `nbcloud-task18-vertical-${nonce}`;
const report: any = { project, mode, status: 'running', steps: [] };
await mkdir(resolve('.tmp'), { recursive: true });
const reportPath = resolve('.tmp', `${project}.report.json`);
function check(value: unknown, code: string): asserts value { if (!value) throw Error(code); }
function stage(value: string) { report.stage = value; report.steps.push(value); console.log(JSON.stringify({ event: 'vertical_stage', stage: value })); }
async function freePort() { const s = createServer(); await new Promise<void>(ok => s.listen(0, '127.0.0.1', ok)); const port = (s.address() as any).port; await new Promise<void>(ok => s.close(() => ok())); return port; }
async function until<T>(read: () => Promise<T> | T, timeout = 20000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (value) return value; await new Promise(ok => setTimeout(ok, 50)); }
  throw Error('VERTICAL_WAIT_TIMEOUT');
}
async function child(args: string[], env: NodeJS.ProcessEnv, input = '') {
  const p = spawn(process.execPath, args, { cwd: root, env, stdio: ['pipe','pipe','pipe'] });
  let stdout = '', stderr = '';
  p.stdout.on('data', c => { stdout += c; }); p.stderr.on('data', c => { stderr += c; });
  p.stdin.on('error', () => undefined); p.stdin.end(input);
  const timeout = setTimeout(() => p.kill('SIGKILL'), 30000);
  const code = await new Promise<number | null>((ok, reject) => { p.once('error', reject); p.once('close', ok); }).finally(() => clearTimeout(timeout));
  // Never print child output: CLI output may contain credentials or a full result.
  return { code, stdout, stderr };
}
async function stopWorker(p: ChildProcess | undefined) {
  if (!p || p.exitCode !== null || p.signalCode !== null) return;
  const exited = new Promise<void>(ok => p.once('close', () => ok()));
  p.kill('SIGTERM'); const timer = setTimeout(() => p.kill('SIGKILL'), 5000);
  await exited.finally(() => clearTimeout(timer));
}
const options = { root, project, name: project, database: 'nbcloud_test_vertical', port: await freePort() };
try {
  await withControlLock(options, async () => {
    let db: ReturnType<typeof createDb> | undefined, tls: Awaited<ReturnType<typeof tlsProvider>> | undefined;
    let app: ReturnType<typeof buildApp> | undefined, worker: ChildProcess | undefined, browser: any, scratch: string | undefined;
    try {
      stage('owned-pg-setup'); const { env, state } = await startTestDatabase(options); report.database_id = state.container_id;
      scratch = await mkdtemp(resolve(tmpdir(), 'nbcloud-vertical-'));
      const baseEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP };
      const tenant = `vertical-${nonce}`, password = randomBytes(24).toString('base64url');
      const bootstrap = await child(['dist/cli/bootstrap-admin.js', '--tenant', tenant, '--username', 'admin', '--password-stdin'], { ...baseEnv, DATABASE_URL: env.DATABASE_URL }, password + '\n');
      check(bootstrap.code === 0, 'BOOTSTRAP_FAILED');
      db = createDb(env.DATABASE_URL); tls = await tlsProvider();
      const port = await freePort(), base = `http://127.0.0.1:${port}`;
      const workerEnv = { ...baseEnv, DATABASE_URL: env.DATABASE_URL, CLOUD_SECRET_MASTER_KEY: randomBytes(32).toString('base64'), CLOUD_SECRET_KEY_ID: 'vertical-fixture', CLOUD_EXECUTION_HOME: resolve(scratch, 'worker'), TASK_PROVIDER_PORT: String(tls.port), TASK_CA_CERT: tls.cert.toString() };
      const service = executionService(db, workerEnv);
      const statuses: number[] = [];
      app = buildApp({ db, env: { DATABASE_URL: env.DATABASE_URL, PUBLIC_ORIGIN: base, COOKIE_MODE: 'loopback', HOST: '127.0.0.1', PORT: String(port) }, registerAdditionalRoutes: service.register });
      app.addHook('onResponse', async (request, reply) => { if (request.url.startsWith('/v1/')) statuses.push(reply.statusCode); });
      report.console_enabled = await registerConsole(app);
      if (mode === '--browser') {
        check(report.console_enabled, 'BUILD_WEB_DIST_BEFORE_BROWSER_RUN');
        const files = ['index.html', ...(await readdir('web/dist/assets')).map(f => 'assets/' + f)];
        report.web_input = Object.fromEntries(await Promise.all(files.map(async f => [f, createHash('sha256').update(await readFile(resolve('web/dist', f))).digest('hex')])));
      }
      await app.listen({ host: '127.0.0.1', port });
      check((await fetch(base + '/health/live')).status === 200 && (await fetch(base + '/health/ready')).status === 200, 'HEALTH_FAILED');
      stage('independent-worker'); let ready = false; const faults: string[] = [];
      worker = spawn(process.execPath, ['--import', './test/fixtures/no-sdk-launchers.mjs', 'test/fixtures/execution-worker.mjs'], { cwd: root, env: workerEnv, stdio: ['ignore','pipe','pipe','ipc'] });
      report.worker_pid = worker.pid; worker.on('error', () => faults.push('WORKER_SPAWN_FAILED'));
      worker.stdout!.on('data', () => undefined); worker.stderr!.on('data', () => faults.push('WORKER_STDERR'));
      worker.on('message', (message: any) => { if (message?.stage === 'ready') ready = true; });
      await until(() => { check(!faults.length && worker!.exitCode === null, 'WORKER_START_FAILED'); return ready; });
      const cliHome = resolve(scratch, 'cli'); await mkdir(cliHome, { recursive: true });
      const sdkPackage = resolve('node_modules/@nb-corp/nb-search');
      const manifest = JSON.parse(await readFile(resolve(sdkPackage, 'package.json'), 'utf8'));
      const cliPath = await realpath(resolve(sdkPackage, manifest.bin['nb-search']));
      report.sdk_cli_sha256 = createHash('sha256').update(await readFile(cliPath)).digest('hex');
      await writeFile(resolve(cliHome, 'profiles.json'), JSON.stringify({ schema_version: '1', profiles: { cloud: { kind: 'remote', base_url: base, allow_loopback_http: true, token_env: 'VERTICAL_TOKEN' } } }));
      async function cli(token: string, input?: object) {
        return child([cliPath, '--profile', 'cloud', input ? 'search' : 'capabilities', ...(input ? ['--stdin'] : [])], { ...baseEnv, NB_SEARCH_HOME: cliHome, VERTICAL_TOKEN: token }, input ? JSON.stringify(input) : '');
      }
      if (mode === '--setup-check') {
        stage('cli-remote-auth-negative'); statuses.length = 0;
        const invalid = await cli(issueAccessKey().accessKey);
        check(invalid.code !== 0 && statuses.at(-1) === 401, 'CLI_DID_NOT_REACH_REMOTE_AUTH');
        check(tls.seen.length === 0 && !faults.length, 'SETUP_DISPATCHED_OR_WORKER_FAILED');
        report.provider_hits = 0; report.status = 'setup-verified-not-browser-tested';
      } else {
        const ui = await import('./vertical-browser.js');
        const opened = await ui.openBrowser(base, tenant, password, stage); browser = opened.browser;
        const configured = await ui.configureThroughUi(opened.page, base, tls.base, 'vertical-fake-provider-secret', stage);
        stage('cli-async-run'); const run = await cli(configured.token, { action: 'run', query: 'large-output vertical evidence', execution: 'async', lane: 'exa.search', idempotency_key: 'vertical-once' });
        check(run.code === 7, 'CLI_ASYNC_EXIT'); const receipt = JSON.parse(run.stdout); check(receipt.status === 'queued', 'CLI_NOT_QUEUED');
        const jobId = receipt.job.job_id; report.job_id = jobId;
        const job: any = await until(async () => {
          const r = await cli(configured.token, { action: 'get', job_id: jobId }); const job = JSON.parse(r.stdout);
          if (['failed','cancelled'].includes(job.state)) throw Error('ASYNC_JOB_FAILED');
          return job.state === 'succeeded' ? job : undefined;
        }, 30000);
        stage('cli-artifact-read'); const chunks: Buffer[] = []; let cursor: string | undefined, pages = 0;
        do {
          const r = await cli(configured.token, { action: 'read', job_id: jobId, page_size: 2, ...(cursor ? { cursor } : {}) });
          check(r.code === 0 && ++pages <= 100, 'CLI_READ_FAILED'); const page = JSON.parse(r.stdout);
          for (const c of page.chunks) chunks.push(Buffer.from(c.data_base64, 'base64'));
          cursor = page.next_cursor;
        } while (cursor);
        const bytes = Buffer.concat(chunks); check(bytes.length === job.artifact.byte_length && bytes.length > 70000, 'ARTIFACT_INCOMPLETE');
        check(tls.seen.length === 1 && tls.seen[0].path.endsWith('/search'), 'PROVIDER_CALL_COUNT');
        const reservation = (await db.pool.query('SELECT state,units FROM usage_reservations WHERE job_id=$1', [jobId])).rows[0];
        check(reservation?.state === 'settled' && Number(reservation.units) === 2, 'USAGE_NOT_SETTLED');
        const ledger = (await db.pool.query('SELECT event,units FROM usage_events WHERE job_id=$1 ORDER BY created_at', [jobId])).rows;
        check(ledger.some(r => r.event === 'reserve' && Number(r.units) === 2) && ledger.some(r => r.event === 'settle' && Number(r.units) === 2), 'USAGE_LEDGER_MISSING');
        stage('ui-full-result'); await ui.inspectUsage(opened.page, base, jobId, bytes.toString('utf8'), resolve('.tmp', `${project}.usage.png`));
        stage('ui-revoke-key'); await ui.revokeThroughUi(opened.page, base, configured.key.id);
        const key = (await db.pool.query('SELECT status,deleted_at FROM api_keys WHERE id=$1', [configured.key.id])).rows[0];
        check(key?.status === 'disabled' && key.deleted_at, 'KEY_NOT_REVOKED');
        statuses.length = 0; const denied = await cli(configured.token, { action: 'run', query: 'must not dispatch', execution: 'async', idempotency_key: 'vertical-revoked' });
        check(denied.code !== 0 && statuses.at(-1) === 401 && tls.seen.length === 1, 'REVOKED_KEY_DISPATCHED');
        check(!faults.length, 'WORKER_REPORTED_FAULT'); report.provider_hits = tls.seen.length; report.artifact_bytes = bytes.length; report.usage_units = 2; report.status = 'vertical-verified';
      }
    } finally {
      report.last_work_stage = report.stage;
      stage('cleanup'); const cleanup = await Promise.allSettled([browser?.close(), stopWorker(worker)]);
      const rest = await Promise.allSettled([app?.close(), tls?.close()]);
      const local = await Promise.allSettled([db ? closeDb(db) : undefined, scratch ? rm(scratch, { recursive: true, force: true }) : undefined]);
      await stopTestDatabase(options);
      report.resources_removed = [...cleanup, ...rest, ...local].every(r => r.status === 'fulfilled');
      check(report.resources_removed, 'CLEANUP_FAILED');
    }
  });
} catch {
  // Do not serialize Playwright errors: they may quote filled password/key values.
  report.status = 'failed'; console.error('Vertical harness failed; see the sanitized stage report.'); process.exitCode = 1;
} finally {
  await writeFile(reportPath, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ event: 'vertical_report', path: reportPath, status: report.status }));
}
