// Operator-installed, deterministic, no-network script example. No paid provider calls.
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), local = resolve(root, '.local');
async function cli(input) {
  const child = spawn(process.execPath, ['scripts/local-client.mjs', 'search', '--stdin'], { cwd: root, stdio: ['pipe','pipe','pipe'] });
  let output = ''; child.stdout.on('data', c => { output += c; }); child.stderr.on('data', () => undefined); child.stdin.end(JSON.stringify(input));
  const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
  const code = await new Promise((ok, fail) => { child.once('error', fail); child.once('close', ok); }).finally(() => clearTimeout(timer));
  if (![0,7].includes(code)) throw Error('DEMO_CLI_FAILED'); return JSON.parse(output);
}
try {
  if (process.argv[2] === 'install') {
    const path = resolve(local, 'channels/manifest.json'), manifest = JSON.parse(await readFile(path, 'utf8'));
    if (!manifest.channels.some(c => c.id === 'local-demo')) {
      await writeFile(resolve(local, 'channels/local-demo.mjs'), "export function search(query, context) { return [{title:'Local script demo (no network)',url:'https://example.com/local-script-demo',snippet:context.options.prefix+': '+query}]; }\n", { flag: 'wx', mode: 0o600 });
      manifest.channels.push({ id: 'local-demo', label: '本机脚本示例（无网络）', module: './local-demo.mjs', params: { prefix: 'Trusted local module' } });
      await writeFile(path, JSON.stringify(manifest, null, 2));
    }
    console.log('LOCAL_SCRIPT_INSTALLED: restart API/worker with the SDK 0.4.0 image before check.');
  } else if (process.argv[2] === 'check') {
    const { base } = JSON.parse(await readFile(resolve(local, 'deployment.json'), 'utf8'));
    const admin = JSON.parse(await readFile(resolve(local, 'admin.json'), 'utf8'));
    const login = await fetch(base+'/api/admin/auth/login', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify(admin) });
    if (login.status !== 200) throw Error('DEMO_LOGIN_FAILED');
    const cookie = login.headers.get('set-cookie').split(';')[0], session = (await login.json()).data;
    async function api(path, method='GET', body) {
      const r = await fetch(base+'/api/admin'+path, { method, headers: { origin: base, cookie, 'x-csrf-token':session.csrf_token, ...(body ? { 'content-type':'application/json' } : {}) }, ...(body ? { body:JSON.stringify(body) } : {}) });
      if (!r.ok) throw Error('DEMO_API_FAILED'); return (await r.json()).data;
    }
    const catalog = await api('/providers/catalog'); if (!catalog.script_channels.some(c => c.id==='local-demo')) throw Error('DEMO_NOT_REGISTERED');
    let provider = (await api('/providers?limit=100')).items.find(p => p.name==='Local script demo');
    provider ??= await api('/providers','POST',{ name:'Local script demo',provider_id:'script', options:{channel_id:'local-demo',params:{prefix:'Cloud SDK 0.4.0'}} });
    const lane='script.local-demo';
    if (!(await api('/lanes')).items.some(l => l.id===lane)) await api('/lanes','POST',{id:lane,provider_id:provider.id,operation_id:'search',latency:'fast',cost:'free'});
    const imported = JSON.parse(await readFile(resolve(local,'import-report.json'),'utf8'));
    const cap=await api(`/groups/${imported.group_id}/capabilities`);
    const lanes=cap.lanes.map(l => ({lane_id:l.lane_id,units_per_query:l.units_per_query}));
    if (!lanes.some(l => l.lane_id===lane)) {
      lanes.push({lane_id:lane,units_per_query:1});
      await api(`/groups/${imported.group_id}/capabilities`,'PUT',{expected_revision:cap.revision,lanes,default_search_lane:cap.default_search_lane,default_fetch_pipeline:cap.default_fetch_pipeline,presets:cap.presets??{}});
    }
    const sync=await cli({action:'run',lane,query:'Hello from the local Cloud script'});
    if(sync.status!=='succeeded' || !JSON.stringify(sync).includes('Cloud SDK 0.4.0')) throw Error('DEMO_SYNC_FAILED');
    const receipt=await cli({action:'run',lane,query:'Hello from the async Cloud script',execution:'async',idempotency_key:'local-script-demo-async'});
    if(receipt.status!=='queued') throw Error('DEMO_ASYNC_NOT_QUEUED');
    const id=receipt.job.job_id; let job; const end=Date.now()+20000;
    do { await new Promise(ok=>setTimeout(ok,200)); job=await cli({action:'get',job_id:id}); if(['succeeded','failed','cancelled'].includes(job.state))break; }while(Date.now()<end);
    if(job.state!=='succeeded')throw Error('DEMO_ASYNC_FAILED');
    const chunks=[];let cursor;
    do { const page=await cli({action:'read',job_id:id,...(cursor?{cursor}:{})}); for(const c of page.chunks)chunks.push(Buffer.from(c.data_base64,'base64'));cursor=page.next_cursor;}while(cursor);
    const bytes=Buffer.concat(chunks);if(bytes.length!==job.artifact.byte_length || !bytes.toString().includes('Hello from the async Cloud script'))throw Error('DEMO_ARTIFACT_FAILED');
    const report={lane,sync:'succeeded',async:'succeeded',job_id:id,artifact_bytes:bytes.length,network_calls:0,paid_runs:0};
    await writeFile(resolve(local,'script-demo-report.json'),JSON.stringify(report,null,2));
    await api('/auth/logout','POST');console.log(JSON.stringify(report));
  } else throw Error('Use local-script-demo.mjs install or check');
} catch(error) { console.error(/^[A-Z_]+$/.test(error.message)?error.message:'LOCAL_SCRIPT_DEMO_FAILED');process.exitCode=1; }
