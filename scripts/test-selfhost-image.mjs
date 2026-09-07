import { execFileSync } from 'node:child_process';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createServer, isIP } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestDatabase, stopTestDatabase, withControlLock, inspectContainer, assertOwned } from './test-database-control.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const image = (process.argv[2] ?? await readFile(resolve(root, '.tmp/selfhost-image.id'), 'utf8')).trim();
if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('EXACT_IMAGE_ID_REQUIRED');
const nonce = randomBytes(16).toString('hex'), project = `nbcloud-task18-selfhost-${nonce.slice(0,8)}`;
const records = [], statePath = resolve(root, `.tmp/${project}.runtime-state.json`);
function check(value, message) { if (!value) throw new Error(message); }
function docker(args, env = process.env, input) { try { return execFileSync('docker', args, { cwd: root, env, input, encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }).trim(); } catch { throw new Error(`DOCKER_${args[0].toUpperCase()}_FAILED`); } }
const socket = createServer(); await new Promise(ok => socket.listen(0, '127.0.0.1', ok)); const port = socket.address().port; await new Promise(ok => socket.close(ok));
const database = { root, project, name: `${project}-db`, database: 'nbcloud_test_selfhost', port };
async function create(name, values, command, publish = false) {
  const args = ['create', '--name', name, '--label', `nbcloud.test.project=${project}`, '--label', `nbcloud.test.owner=${nonce}`];
  if (publish) args.push('-p', '127.0.0.1::3000');
  for (const key of Object.keys(values)) args.push('-e', key);
  args.push(image, ...command);
  const id = docker(args, { ...process.env, ...values });
  const state = { version: 1, project, nonce, container_id: id, name }; records.push(state); await writeFile(statePath, JSON.stringify(records), { mode: 0o600 });
  const actual = inspectContainer(name, root); assertOwned(state, actual, database); check(actual.Image === image, 'IMAGE_ID_CHANGED');
  docker(['start', id]); console.log(`selfhost_container_started name=${name} id=${id}`); return state;
}
async function stopOwned() {
  for (const record of records.reverse()) {
    const actual = inspectContainer(record.name, root);
    if (!actual) { check(!inspectContainer(record.container_id, root), 'OWNED_CONTAINER_RENAMED'); continue; }
    assertOwned(record, actual, database); docker(['rm', '-f', record.container_id]); console.log(`selfhost_container_removed id=${record.container_id}`);
  }
  await unlink(statePath).catch(error => { if (error.code !== 'ENOENT') throw error; });
}
await withControlLock(database, async () => {
  try {
    const { env, state } = await startTestDatabase(database);
    const pg = inspectContainer(database.name, root); assertOwned(state, pg, database);
    const ip = pg.NetworkSettings.Networks.bridge.IPAddress; check(isIP(ip) === 4, 'TASK_BRIDGE_IPV4_REQUIRED');
    const url = new URL(env.DATABASE_URL); url.hostname = ip; url.port = '5432';
    const values = { DATABASE_URL: url.toString(), PUBLIC_ORIGIN: 'https://selfhost-fixture.example', COOKIE_MODE: 'production', HOST: '0.0.0.0', PORT: '3000' };
    const api = await create(`${project}-api`, values, [], true);
    const worker = await create(`${project}-worker`, values, ['node','dist/server.js','worker']);
    const actual = inspectContainer(api.name, root); assertOwned(api, actual, database);
    const binding = actual.NetworkSettings.Ports['3000/tcp'][0]; check(binding.HostIp === '127.0.0.1', 'LOOPBACK_PUBLICATION_REQUIRED');
    const base = `http://127.0.0.1:${binding.HostPort}`;
    let ready = false;
    for (let attempt=0; attempt<80; attempt++) { try { if ((await fetch(base+'/health/ready')).status === 200) { ready=true; break; } } catch {} await new Promise(ok=>setTimeout(ok,250)); }
    check(ready, 'API_NOT_READY'); check((await fetch(base+'/health/live')).status===200, 'LIVE_FAILED');
    const html = await fetch(base+'/'); check(html.status===200 && html.headers.get('content-type')?.includes('text/html') && html.headers.get('cache-control')==='no-store', 'HTML_FAILED');
    const body = await html.text(); const assets = [...body.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map(match=>match[1]); check(assets.length>0, 'BUILT_ASSETS_MISSING');
    for (const path of assets) { const response=await fetch(base+path); check(response.status===200 && response.headers.get('cache-control')==='no-store', 'ASSET_FAILED'); await response.arrayBuffer(); }
    for (const path of ['/api/missing','/health/missing','/.env','/src/server.ts','/assets/..%2fpackage.json']) { const response=await fetch(base+path); check(response.status===404 && response.headers.get('content-type')?.includes('application/json'), 'STATIC_FALLBACK_LEAK'); await response.arrayBuffer(); }
    const unknown=await fetch(base+'/v1/missing',{method:'POST',headers:{'content-type':'application/json','x-nb-search-protocol':'1'},body:'{}'}); check(unknown.status===404 && unknown.headers.get('x-nb-search-protocol')==='1' && (await unknown.json()).error.code==='NOT_FOUND','WIRE_404_CHANGED');
    const password='Task-image-only-password';
    docker(['exec','-i',api.container_id,'node','dist/cli/bootstrap-admin.js','--tenant','image-fixture','--username','admin','--password-stdin'],process.env,password+'\n');
    const login=await fetch(base+'/api/admin/auth/login',{method:'POST',headers:{origin:values.PUBLIC_ORIGIN,'content-type':'application/json'},body:JSON.stringify({tenant:'image-fixture',username:'admin',password})});
    check(login.status===200,'LOGIN_FAILED'); const cookie=login.headers.get('set-cookie'); check(cookie.includes('Secure') && cookie.includes('HttpOnly') && cookie.includes('SameSite=Strict'),'COOKIE_CHANGED'); const session=(await login.json()).data;
    async function admin(path, method='GET', payload) { const response=await fetch(base+'/api/admin'+path,{method,headers:{origin:values.PUBLIC_ORIGIN,cookie:cookie.split(';')[0],'x-csrf-token':session.csrf_token,'content-type':'application/json'},...(payload===undefined?{}:{body:JSON.stringify(payload)})}); return {status:response.status,body:await response.json()}; }
    check((await admin('/providers')).status===200,'MANAGEMENT_FAILED');
    check((await admin('/providers','POST',{name:'secret-rejected',provider_id:'exa',secret:'fake-provider-secret'})).status===503,'MISSING_MASTER_KEY_NOT_CLOSED');
    const provider=await admin('/providers','POST',{name:'unconfigured',provider_id:'exa'}); check(provider.status===201,'METADATA_CREATE_FAILED');
    const group=await admin('/groups','POST',{name:'image-group'}); check(group.status===201,'GROUP_FAILED');
    check((await admin('/lanes','POST',{id:'exa.search',provider_id:provider.body.data.id,operation_id:'search',latency:'fast',cost:'cheap'})).status===201,'LANE_FAILED');
    const caps=await admin(`/groups/${group.body.data.id}/capabilities`,'PUT',{expected_revision:group.body.data.revision,lanes:[{lane_id:'exa.search',units_per_query:1}],default_search_lane:'exa.search',default_fetch_pipeline:null,presets:{}}); check(caps.status===200 && caps.body.data.lanes[0].configured===false,'UNCONFIGURED_READY');
    const key=await admin('/keys','POST',{name:'image-key',group_id:group.body.data.id}); check(key.status===201,'KEY_FAILED');
    const failed=await fetch(base+'/v1/search',{method:'POST',headers:{authorization:`Bearer ${key.body.data.access_key}`,'content-type':'application/json','x-nb-search-protocol':'1'},body:JSON.stringify({action:'run',query:'must never dispatch'})}); const failure=await failed.json(); check(failed.status===200 && failure.status==='failed' && failure.error.code==='LANE_NOT_CONFIGURED','EXECUTION_NOT_CLOSED');
    const probe = `import {createDb,closeDb} from './dist/db/client.js'; import fs from 'node:fs'; const db=createDb(process.env.DATABASE_URL); const row=(await db.pool.query("SELECT current_user AS role,rolsuper,current_setting('server_version') AS postgres,(SELECT count(*)::int FROM pg_tables WHERE schemaname='public' AND tableowner=current_user) AS owned FROM pg_roles WHERE rolname=current_user")).rows[0]; if(process.getuid()===0||row.role!=='nbcloud_runtime'||row.rolsuper||row.owned!==0)throw Error('ROLE_INVALID'); console.log(JSON.stringify({uid:process.getuid(),node:process.version,...row})); await closeDb(db);`;
    for (const record of [api, worker]) console.log(JSON.stringify({container:record.name, ...JSON.parse(docker(['exec',record.container_id,'node','--input-type=module','-e',probe]))}));
    const writable=`const fs=require('node:fs'),p=require('node:path'); if(process.getuid()!==10001)throw Error('UID'); const root=process.env.CLOUD_EXECUTION_HOME; fs.accessSync(root,fs.constants.W_OK); const file=p.join(root,'task-${nonce}'); fs.writeFileSync(file,'fixture'); fs.unlinkSync(file); if(!fs.readdirSync(root).some(n=>n.startsWith('sdk-')))throw Error('WORKER_NOT_INITIALIZED'); console.log(JSON.stringify({uid:process.getuid(),execution_home:root,writable:true}));`;
    console.log(docker(['exec',worker.container_id,'node','-e',writable]));
    for (const record of [api,worker]) { const inspected=inspectContainer(record.name,root); assertOwned(record,inspected,database); check(inspected.State.Running && inspected.Config.User==='10001:10001','NONROOT_PROCESS_FAILED'); const names=inspected.Config.Env.map(value=>value.split('=')[0]); check(!names.includes('DATABASE_ADMIN_URL')&&!names.includes('MIGRATION_DATABASE_URL')&&!names.includes('CLOUD_SECRET_MASTER_KEY'),'PRIVILEGED_ENV_PRESENT'); }
    const layout=`const fs=require('node:fs'); for(const p of ['src','test','scripts','../nb-search/src'])if(fs.existsSync(p))throw Error('BUILD_INPUT_IN_RUNTIME'); console.log('runtime_layout=production-only');`;
    console.log(docker(['exec',api.container_id,'node','-e',layout]));
    // npm ls misclassifies pnpm's materialized file: directory dependency as an invalid npm link.
    // Check installed metadata and the actual supported SDK root import instead.
    const versions=`import fs from 'node:fs'; const manifest=JSON.parse(fs.readFileSync('package.json')); const dependencies=Object.fromEntries(Object.keys(manifest.dependencies).map(name=>[name,JSON.parse(fs.readFileSync('node_modules/'+name+'/package.json')).version])); for(const name of ['typescript','tsx','vitest'])if(fs.existsSync('node_modules/'+name))throw Error('DEV_DEPENDENCY_IN_RUNTIME'); const sdk=await import('@nb-corp/nb-search'); if(typeof sdk.createNbSearchRuntime!=='function')throw Error('SDK_ROOT_UNAVAILABLE'); console.log(JSON.stringify({node:process.version,dependencies,sdk_root_loadable:true}));`;
    console.log(docker(['exec',api.container_id,'node','--input-type=module','-e',versions]));
    console.log(`selfhost_image_verified id=${image} api_port=${binding.HostPort}`);
  } finally { await stopOwned(); await stopTestDatabase(database); }
}).catch(error=>{ console.error(error.message); process.exitCode=1; });
