import { spawn } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
let connections = 0, port: number;
const trap = createServer((socket) => { connections++; socket.destroy(); });
beforeAll(async () => { await new Promise<void>((ok) => trap.listen(0, '127.0.0.1', ok)); port = (trap.address() as AddressInfo).port; });
afterAll(async () => { await new Promise<void>((ok) => trap.close(() => ok())); });
const positions = ['DATABASE_ADMIN_URL', 'MIGRATION_DATABASE_URL', 'DATABASE_URL'] as const;
const cases = positions.flatMap((position) => ['host', 'port', 'user', 'password', '%68ost', 'user=owner&user'].map((key) => ({ position, key })));
async function invoke(entry: string[], changed: string, query: string) {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PUBLIC_ORIGIN: 'http://127.0.0.1:3000', COOKIE_MODE: 'loopback', HOST: '127.0.0.1', PORT: String(port) };
  for (const [index, name] of positions.entries()) env[name] = `postgresql://${['admin', 'owner', 'runtime'][index]}:fixture-password-only@127.0.0.1:${port}/nbcloud_test_url`;
  env[changed] += '?' + query;
  const child = spawn(process.execPath, entry, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }).finally(() => clearTimeout(timer));
  expect(code).toBe(1); expect(output).not.toContain('fixture-password-only'); expect(connections).toBe(0);
  if (entry[0] === 'dist/server.js' && changed === 'DATABASE_URL') expect(output).toContain('DATABASE_URL requires explicit PostgreSQL credentials and target');
  else expect(output).toContain(entry[0] === 'dist/cli/provision-database.js' ? 'Database role provisioning failed' : 'Service startup failed');
}
it.each(cases)('A-DB01 provision $position rejects $key before any connection or SQL', async ({ position, key }) => {
  const value = key.includes('ost') ? '127.0.0.1' : key === 'port' ? String(port) : 'owner';
  await invoke(['dist/cli/provision-database.js'], position, `${key}=${value}`);
});
it.each(cases.filter(({ position }) => position !== 'DATABASE_ADMIN_URL'))('A-DB01 migrate $position rejects $key before any connection or SQL', async ({ position, key }) => {
  const value = key.includes('ost') ? '127.0.0.1' : key === 'port' ? String(port) : 'owner';
  await invoke(['dist/server.js', 'migrate'], position, `${key}=${value}`);
});
it('A-DB01 normal server rejects runtime identity overrides before any connection', async () => {
  await invoke(['dist/server.js'], 'DATABASE_URL', 'user=owner&password=fixture-password-only');
});
