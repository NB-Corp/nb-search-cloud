import { randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export function assertOwned(state, container, options) {
  if (!container) return;
  const labels = container.Config?.Labels ?? {};
  if (!state || state.version !== 1 || state.project !== options.project || container.Id !== state.container_id || !/^[a-f0-9]{64}$/.test(state.container_id) || !/^[a-f0-9]{32}$/.test(state.nonce) || labels['nbcloud.test.owner'] !== state.nonce || labels['nbcloud.test.project'] !== options.project) throw new Error('TEST_CONTAINER_OWNERSHIP_MISMATCH');
}
function docker(args, root, env = process.env) { return execFileSync('docker', args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
export function inspectContainer(name, root) { try { return JSON.parse(docker(['inspect', name], root))[0]; } catch (error) { if (/no such (?:object|container):/i.test(String(error.stderr ?? ''))) return undefined; throw new Error('DOCKER_INSPECT_FAILED'); } }
async function stateAt(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return undefined; throw new Error('TEST_STATE_INVALID'); } }
async function save(path, value) { const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`; await writeFile(temp, JSON.stringify(value), { mode: 0o600 }); await rename(temp, path); }
function paths(options) { return { state: resolve(options.root, '.tmp', `${options.project}.state.json`), secret: resolve(options.root, '.tmp', `${options.project}.private.json`), lock: resolve(options.root, '.tmp', `${options.project}.lock`) }; }
export async function withControlLock(options, fn) {
  const p = paths(options); await mkdir(dirname(p.lock), { recursive: true });
  let handle;
  try { handle = await open(p.lock, 'wx', 0o600); } catch { throw new Error('TEST_DATABASE_CONTROL_BUSY'); }
  try { return await fn(); } finally { await handle.close(); await unlink(p.lock); }
}
function environment(options, passwords) {
  if (!passwords || ['admin', 'owner', 'runtime'].some((name) => typeof passwords[name] !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(passwords[name]))) throw new Error('TEST_CREDENTIAL_STATE_INVALID');
  const base = `@127.0.0.1:${options.port}/${options.database}`;
  return { DATABASE_ADMIN_URL: `postgres://postgres:${passwords.admin}${base}`, MIGRATION_DATABASE_URL: `postgres://nbcloud_owner:${passwords.owner}${base}`, DATABASE_URL: `postgres://nbcloud_runtime:${passwords.runtime}${base}`, PUBLIC_ORIGIN: 'http://127.0.0.1:3000', COOKIE_MODE: 'loopback', HOST: '127.0.0.1', PORT: '3000', NODE_ENV: 'test' };
}
export function runPnpm(root, args, environmentValues) {
  const executable = process.platform === 'win32' ? process.execPath : 'pnpm';
  const childArgs = process.platform === 'win32' ? [resolve(dirname(process.execPath), 'node_modules/corepack/dist/pnpm.js'), ...args] : args;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, childArgs, { cwd: root, env: { ...process.env, ...environmentValues }, shell: false, stdio: 'inherit' });
    child.once('error', () => reject(new Error('TEST_COMMAND_START_FAILED'))); child.once('exit', (code) => resolvePromise(code ?? 1));
  });
}
export async function startTestDatabase(options) {
  const p = paths(options); await mkdir(dirname(p.state), { recursive: true });
  let state = await stateAt(p.state);
  const existing = inspectContainer(options.name, options.root);
  let passwords;
  if (existing) {
    assertOwned(state, existing, options); // Validate exact ID BEFORE reading credential state.
    passwords = await stateAt(p.secret);
  } else {
    if (state && inspectContainer(state.container_id, options.root)) throw new Error('RECORDED_TEST_CONTAINER_EXISTS_ELSEWHERE');
    passwords = { admin: randomBytes(24).toString('base64url'), owner: randomBytes(24).toString('base64url'), runtime: randomBytes(24).toString('base64url') };
    const nonce = randomBytes(16).toString('hex');
    const id = docker(['run', '--rm', '-d', '--name', options.name, '--label', `nbcloud.test.project=${options.project}`, '--label', `nbcloud.test.owner=${nonce}`, '-e', 'POSTGRES_PASSWORD', '-e', `POSTGRES_DB=${options.database}`, '-p', `127.0.0.1:${options.port}:5432`, '--health-cmd', `pg_isready -U postgres -d ${options.database}`, '--health-interval', '1s', '--health-timeout', '3s', '--health-retries', '30', 'postgres:17.6-bookworm'], options.root, { ...process.env, POSTGRES_PASSWORD: passwords.admin });
    state = { version: 1, container_id: id, nonce, project: options.project };
    assertOwned(state, inspectContainer(options.name, options.root), options);
    await save(p.secret, passwords); await save(p.state, state);
  }
  const env = environment(options, passwords);
  let healthy = false;
  for (let i = 0; i < 60; i++) {
    const current = inspectContainer(options.name, options.root); assertOwned(state, current, options);
    if (!current) throw new Error('TEST_CONTAINER_DISAPPEARED');
    if (current.State?.Health?.Status === 'healthy') { healthy = true; break; }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  if (!healthy) throw new Error('TEST_DATABASE_NOT_HEALTHY');
  // Bootstrap administrator provisions two non-superuser roles; owner alone migrates/grants.
  if (await runPnpm(options.root, ['exec', 'tsx', 'src/cli/provision-database.ts'], env)) throw new Error('TEST_ROLE_PROVISION_FAILED');
  if (await runPnpm(options.root, ['exec', 'tsx', 'src/server.ts', 'migrate'], env)) throw new Error('TEST_MIGRATION_FAILED');
  process.stdout.write(`test_database_ready project=${options.project} id=${state.container_id} port=${options.port} roles=owner+restricted-runtime\n`);
  return { env, state };
}
export async function stopTestDatabase(options, io = { inspect: (name) => inspectContainer(name, options.root), remove: (id) => docker(['rm', '-f', id], options.root) }) {
  const p = paths(options), state = await stateAt(p.state), current = await io.inspect(options.name);
  if (!current) {
    if (state && await io.inspect(state.container_id)) throw new Error('RECORDED_TEST_CONTAINER_EXISTS_ELSEWHERE');
    return;
  }
  assertOwned(state, current, options);
  // Remove exactly the recorded container, never compose down a whole name/label-selected project.
  await io.remove(state.container_id);
  process.stdout.write(`test_database_removed project=${options.project} id=${state.container_id}\n`);
  await unlink(p.state); await unlink(p.secret).catch((error) => { if (error.code !== 'ENOENT') throw error; });
}
export async function testDatabaseStatus(options) {
  const state = await stateAt(paths(options).state), current = inspectContainer(options.name, options.root);
  assertOwned(state, current, options);
  process.stdout.write(current ? `test_database_status id=${current.Id} status=${current.State?.Status}\n` : 'test_database_absent\n');
}
