// Exactly one paid run per named check. Follow-up get/read are non-dispatch operations.
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), local = resolve(root, '.local');
const kind = process.argv[2];
if (!['exa','gma'].includes(kind)) throw Error('Use local-real-check.mjs exa or gma');
const statePath = resolve(local, `real-${kind}.json`);
async function cli(input) {
  const child = spawn(process.execPath, ['scripts/local-client.mjs','search','--stdin'], { cwd: root, stdio: ['pipe','pipe','pipe'] });
  let output = ''; child.stdout.on('data', c => { output += c; }); child.stderr.on('data', () => undefined);
  child.stdin.on('error', () => undefined); child.stdin.end(JSON.stringify(input));
  const timer = setTimeout(() => child.kill('SIGKILL'), 680000);
  const code = await new Promise((ok, reject) => { child.once('error', reject); child.once('close', ok); }).finally(() => clearTimeout(timer));
  try { return { code, body: JSON.parse(output) }; } catch { throw Error('CLI_NON_JSON_RESULT'); }
}
let report;
try {
  const imported = JSON.parse(await readFile(resolve(local, 'import-report.json'), 'utf8'));
  const provider = imported.imported.find(p => p.provider_id === (kind === 'exa' ? 'exa' : 'grok-multi-agent'));
  const lane = provider?.lanes.find(l => l.kind === 'search')?.id;
  if (!lane) throw Error('REQUESTED_PROVIDER_NOT_IMPORTED');
  report = { kind, lane, started_at: new Date().toISOString(), status: 'attempting', dispatch_budget: 1 };
  await writeFile(statePath, JSON.stringify(report, null, 2), { mode: 0o600, flag: 'wx' });
  const input = { action: 'run', lane, query: kind === 'exa' ? 'PostgreSQL 17 release date official PostgreSQL announcement' : 'Briefly explain PostgreSQL 17 major improvements using official PostgreSQL sources. Keep the answer under 300 words.', max_results: 3, execution: kind === 'exa' ? 'sync' : 'async', timeout_ms: kind === 'exa' ? 60000 : 600000, ...(kind === 'gma' ? { idempotency_key: 'local-initial-gma-check' } : {}) };
  const result = await cli(input);
  await mkdir(resolve(local, 'results'), { recursive: true });
  await writeFile(resolve(local, 'results', `${kind}-run.json`), JSON.stringify(result.body, null, 2), { mode: 0o600 });
  if (kind === 'exa') {
    report.status = result.body.status;
    report.error_code = result.body.error?.code;
    if (report.status !== 'succeeded') throw Error('EXA_RUN_FAILED');
    report.result_path = resolve(local, 'results/exa-run.json');
  } else {
    if (result.body.status !== 'queued' || !result.body.job?.job_id) { report.error_code = result.body.error?.code; throw Error('GMA_NOT_QUEUED'); }
    report.job_id = result.body.job.job_id; await writeFile(statePath, JSON.stringify(report, null, 2));
    let job; const until = Date.now() + 650000;
    do {
      await new Promise(ok => setTimeout(ok, 2000));
      const get = await cli({ action: 'get', job_id: report.job_id }); job = get.body;
      if (['succeeded','failed','cancelled'].includes(job.state)) break;
    } while (Date.now() < until);
    report.status = job.state; report.error_code = job.error?.code;
    await writeFile(resolve(local, 'results/gma-job.json'), JSON.stringify(job, null, 2));
    if (job.state !== 'succeeded') throw Error('GMA_JOB_FAILED');
    let cursor; const chunks = []; let pages = 0;
    do {
      const read = await cli({ action: 'read', job_id: report.job_id, page_size: 10, ...(cursor ? { cursor } : {}) });
      if (read.code !== 0 || ++pages > 2000) throw Error('GMA_READ_FAILED');
      for (const chunk of read.body.chunks) chunks.push(Buffer.from(chunk.data_base64, 'base64'));
      cursor = read.body.next_cursor;
    } while (cursor);
    const bytes = Buffer.concat(chunks); if (bytes.length !== job.artifact.byte_length) throw Error('GMA_INCOMPLETE_RESULT');
    report.artifact_bytes = bytes.length; report.result_path = resolve(local, 'results/gma-result.txt');
    await writeFile(report.result_path, bytes, { mode: 0o600 });
  }
  report.completed_at = new Date().toISOString(); await writeFile(statePath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  if (error.code === 'EEXIST') { console.error('CHECK_ALREADY_ATTEMPTED: no automatic paid retry.'); }
  else {
    if (report) { report.status = report.status === 'attempting' ? 'failed' : report.status; report.failure = /^[A-Z_]+$/.test(error.message) ? error.message : 'LOCAL_CHECK_FAILED'; await writeFile(statePath, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); }
    else console.error('LOCAL_CHECK_FAILED');
  }
  process.exitCode = 1;
}
