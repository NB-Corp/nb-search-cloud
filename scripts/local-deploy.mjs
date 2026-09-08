// Persistent local deployment. Never reads or changes the user's SDK config/secret files.
// init creates private deployment material; start provisions this dedicated cluster and leaves it running.
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), local = resolve(root, '.local');
const project = 'nb-search-cloud-local';
function docker(args, input) {
  try { return execFileSync('docker', args, { cwd: root, input, encoding: 'utf8', stdio: ['pipe','pipe','pipe'], timeout: 180000 }).trim(); }
  catch { throw Error(`LOCAL_DOCKER_${args[0].toUpperCase()}_FAILED`); }
}
const compose = args => docker(['compose', '--env-file', '.local/compose.env', '-f', 'compose.local.yaml', '-p', project, ...args]);
async function saved() { return JSON.parse(await readFile(resolve(local, 'deployment.json'), 'utf8')); }
async function save(state) { await writeFile(resolve(local, 'deployment.json'), JSON.stringify(state, null, 2), { mode: 0o600 }); }
function containers() { return docker(['ps','-aq','--filter', `label=com.docker.compose.project=${project}`]).split(/\s+/).filter(Boolean); }
function inspect(id) { return JSON.parse(docker(['inspect', '--format', '{"Id":{{json .Id}},"Image":{{json .Image}},"Config":{"Labels":{{json .Config.Labels}}}}', id])); }
function owned(state, item) {
  if (item.Config.Labels['nbcloud.local.owner'] !== state.owner) throw Error('LOCAL_CONTAINER_OWNERSHIP_MISMATCH');
}
async function record(state) {
  const records = containers().map(id => {
    const item = inspect(id); owned(state, item);
    return { id: item.Id, service: item.Config.Labels['com.docker.compose.service'], image: item.Image };
  });
  state.containers = records; await save(state);
}
async function validate(state) {
  for (const id of containers()) {
    const item = inspect(id); owned(state, item);
    if (!state.containers.some(record => record.id === item.Id)) throw Error('UNRECORDED_LOCAL_CONTAINER');
  }
  const volumes = docker(['volume','ls','-q','--filter', `label=com.docker.compose.project=${project}`]).split(/\s+/).filter(Boolean);
  for (const name of volumes) {
    const volume = JSON.parse(docker(['volume','inspect', name]))[0];
    if (volume.Labels['nbcloud.local.owner'] !== state.owner) throw Error('LOCAL_VOLUME_OWNERSHIP_MISMATCH');
  }
}
async function waitReady(base) {
  const end = Date.now() + 60000;
  while (Date.now() < end) { try { if ((await fetch(base + '/health/ready')).status === 200) return; } catch {} await new Promise(ok => setTimeout(ok, 500)); }
  throw Error('LOCAL_API_NOT_READY');
}
try {
  if (process.argv[2] === 'init') {
    try { await access(resolve(local, 'deployment.json')); throw Error('LOCAL_DEPLOYMENT_ALREADY_INITIALIZED'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (containers().length || docker(['volume','ls','-q','--filter', `label=com.docker.compose.project=${project}`])) throw Error('EXISTING_LOCAL_PROJECT_REFUSED');
    const port = Number(process.argv[3] ?? 18380);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('INVALID_LOCAL_PORT');
    const socket = createServer(); await new Promise((ok, fail) => { socket.once('error', fail); socket.listen(port, '127.0.0.1', ok); }); await new Promise(ok => socket.close(ok));
    await mkdir(resolve(local, 'channels'), { recursive: true });
    const secret = () => randomBytes(32).toString('base64url');
    const adminDb = secret(), ownerDb = secret(), runtimeDb = secret(), master = randomBytes(32).toString('base64');
    const base = `http://127.0.0.1:${port}`, owner = secret();
    const database = `postgresql://nbcloud_runtime:${runtimeDb}@db:5432/nbcloud_local`;
    const migration = `postgresql://nbcloud_owner:${ownerDb}@db:5432/nbcloud_local`;
    const put = (name, text) => writeFile(resolve(local, name), text, { mode: 0o600, flag: 'wx' });
    await put('postgres.env', `POSTGRES_DB=nbcloud_local\nPOSTGRES_PASSWORD=${adminDb}\n`);
    await put('runtime.env', `DATABASE_URL=${database}\nPUBLIC_ORIGIN=${base}\nCOOKIE_MODE=loopback\nHOST=0.0.0.0\nPORT=3000\nCLOUD_SECRET_MASTER_KEY=${master}\nCLOUD_SECRET_KEY_ID=local-v1\nCLOUD_SCRIPT_CHANNELS=/app/channels/manifest.json\n`);
    await put('migration.env', `DATABASE_URL=${database}\nMIGRATION_DATABASE_URL=${migration}\n`);
    await put('provision.env', `DATABASE_ADMIN_URL=postgresql://postgres:${adminDb}@db:5432/nbcloud_local\nDATABASE_URL=${database}\nMIGRATION_DATABASE_URL=${migration}\n`);
    await put('compose.env', `NBCLOUD_LOCAL_OWNER=${owner}\nNBCLOUD_LOCAL_PORT=${port}\nNBCLOUD_LOCAL_IMAGE=nb-search-cloud:local\n`);
    await put('admin.json', JSON.stringify({ tenant: 'local', username: 'admin', password: secret() }, null, 2));
    await put('channels/manifest.json', JSON.stringify({ channels: [] }, null, 2));
    await save({ project, owner, base, port, containers: [], bootstrapped: false });
    console.log(JSON.stringify({ event: 'local_initialized', base, administrator: 'local/admin', credentials_path: resolve(local, 'admin.json') }));
  } else if (process.argv[2] === 'start') {
    const state = await saved(); await validate(state);
    try {
      compose(['up','-d','--wait','db']); await record(state);
      compose(['run','--rm','--no-deps','provision']); compose(['run','--rm','--no-deps','migrate']);
      if (!state.bootstrapped) {
        const credentials = JSON.parse(await readFile(resolve(local, 'admin.json'), 'utf8'));
        docker(['compose','--env-file','.local/compose.env','-f','compose.local.yaml','-p',project,'run','--rm','--no-deps','-T','api','node','dist/cli/bootstrap-admin.js','--tenant',credentials.tenant,'--username',credentials.username,'--password-stdin'], credentials.password + '\n');
        state.bootstrapped = true; await save(state);
      }
      compose(['up','-d','api','worker']); await record(state); await waitReady(state.base);
      console.log(JSON.stringify({ event: 'local_running', base: state.base, administrator: 'local/admin', credentials_path: resolve(local, 'admin.json') }));
    } finally { await record(state); }
  } else if (process.argv[2] === 'status') {
    const state = await saved(); await validate(state);
    console.log(JSON.stringify({ base: state.base, containers: state.containers.map(r => ({ service: r.service, id: r.id })), administrator: 'local/admin', credentials_path: resolve(local, 'admin.json') }));
  } else throw Error('Use local-deploy.mjs init [port], start, or status. Build the image before start.');
} catch (error) {
  console.error(error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'LOCAL_DEPLOY_FAILED'); process.exitCode = 1;
}
