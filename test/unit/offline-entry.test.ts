import { spawn } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
let port: number, connections = 0, statements = 0;
// A loopback PostgreSQL wire sink: authenticate, observe the first SQL message, then
// disconnect. No real database, credentials, provisioning, or shared resources.
const server = createServer((socket) => {
  connections++;
  let pending = Buffer.alloc(0), started = false;
  socket.on('error', () => undefined);
  socket.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    if (!started) {
      if (pending.length < 4 || pending.length < pending.readInt32BE(0)) return;
      pending = pending.subarray(pending.readInt32BE(0)); started = true;
      socket.write(Buffer.from([82,0,0,0,8,0,0,0,0,90,0,0,0,5,73])); // AuthenticationOk + ReadyForQuery
    }
    if (pending.length && [81,80].includes(pending[0]!)) { statements++; socket.destroy(); }
  });
});
beforeAll(async () => { await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok)); port = (server.address() as AddressInfo).port; });
afterAll(async () => { await new Promise<void>((ok) => server.close(() => ok())); });
const tools = [
  ['dist/server.js', 'migrate'],
  ['dist/cli/bootstrap-admin.js', '--tenant', 'offline-fixture', '--username', 'admin', '--password-stdin'],
  ['dist/cli/reset-password.js', '--tenant', 'offline-fixture', '--username', 'admin', '--password-stdin'],
];
function database(user = 'runtime') { return `postgresql://${user}:fixture-db-canary@127.0.0.1:${port}/nbcloud_test_offline`; }
async function invoke(args: string[], values: NodeJS.ProcessEnv) {
  connections = 0; statements = 0;
  const child = spawn(process.execPath, args, { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...values }, stdio: ['pipe','pipe','pipe'] });
  let output = ''; child.stdout.on('data', c => { output += c; }); child.stderr.on('data', c => { output += c; });
  child.stdin.on('error', () => undefined); child.stdin.end('Offline-password-canary-123\n');
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  const code = await new Promise<number | null>((ok, reject) => { child.once('error', reject); child.once('close', ok); }).finally(() => clearTimeout(timer));
  expect(output).not.toContain('fixture-db-canary'); expect(output).not.toContain('Offline-password-canary-123');
  return { code, output, connections, statements };
}
it.each(tools)('compiled offline entry %s reaches SQL with only database configuration', async (...args) => {
  const result = await invoke(args, { DATABASE_URL: database(), MIGRATION_DATABASE_URL: database('owner') });
  expect(result.connections).toBe(1); expect(result.statements).toBe(1);
  expect(result.code).toBe(1); // Expected wire-sink disconnect, not a successful migration/password operation.
  expect(result.output).not.toMatch(/PUBLIC_ORIGIN|COOKIE_MODE|HOST/);
});
for (const args of tools) for (const invalid of [undefined, 'not-a-dsn', 'override']) {
  it(`${args[0]} ${args[1]} rejects ${invalid ?? 'missing DB'} before connecting`, async () => {
    const result = await invoke(args, { ...(invalid === undefined ? {} : { DATABASE_URL: invalid === 'override' ? database() + '?user=owner&password=fixture-db-canary' : invalid }), MIGRATION_DATABASE_URL: database('owner') });
    expect(result.code).toBe(1); expect(result.connections).toBe(0); expect(result.statements).toBe(0);
    expect(result.output).toContain('DATABASE_URL');
  });
}
it.each(['missing', 'same-role', 'other-target', 'query-override'])('offline migrate rejects %s owner before connecting', async (mode) => {
  const owner = mode === 'missing' ? undefined : mode === 'same-role' ? database() : mode === 'other-target' ? database('owner') + '_other' : database('owner') + '?host=elsewhere.example';
  const result = await invoke(['dist/server.js', 'migrate'], { DATABASE_URL: database(), ...(owner === undefined ? {} : { MIGRATION_DATABASE_URL: owner }) });
  expect(result.code).toBe(1); expect(result.connections).toBe(0); expect(result.statements).toBe(0);
});
for (const args of [['dist/server.js'], ['dist/server.js', 'worker']]) {
  it(`${args.join(' ')} still requires real HTTP runtime configuration`, async () => {
    let result = await invoke(args, { DATABASE_URL: database() });
    expect(result.code).toBe(1); expect(result.output).toContain('PUBLIC_ORIGIN'); expect(result.connections).toBe(0);
    result = await invoke(args, { DATABASE_URL: database(), PUBLIC_ORIGIN: 'http://127.0.0.1:3000' });
    expect(result.code).toBe(1); expect(result.output).toContain('COOKIE_MODE'); expect(result.connections).toBe(0);
  });
}
