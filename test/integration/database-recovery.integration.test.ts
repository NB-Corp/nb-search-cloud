import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { createDb, closeDb } from '../../src/db/client.js';
import { integrationDatabaseUrl, prepareIntegrationDatabase } from '../helpers/identity.js';

async function until(fn: () => boolean | Promise<boolean>, maximum = 10_000): Promise<void> {
  const end = Date.now() + maximum;
  while (Date.now() < end) { if (await fn()) return; await delay(20); }
  throw new Error('FAULT_RECOVERY_BARRIER_NOT_REACHED');
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.send('close');
  try { await until(() => child.exitCode !== null || child.signalCode !== null, 5000); }
  catch { child.kill(); await until(() => child.exitCode !== null || child.signalCode !== null, 5000); }
}
it('A-DB02 survives a real idle PG connection termination, serves live200/ready503, and recovers ready200', async () => {
  await prepareIntegrationDatabase(false);
  const runtimeUrl = integrationDatabaseUrl(), adminUrl = process.env['DATABASE_ADMIN_URL'];
  if (!adminUrl || new URL(adminUrl).host !== new URL(runtimeUrl).host || new URL(adminUrl).pathname !== new URL(runtimeUrl).pathname) throw new Error('TASK_DATABASE_ADMIN_REQUIRED');
  expect(decodeURIComponent(new URL(runtimeUrl).username)).toBe('nbcloud_runtime');
  const admin = createDb(adminUrl);
  const application = `A-DB02-${randomUUID()}`;
  const child = fork(fileURLToPath(new URL('../helpers/idle-server.mjs', import.meta.url)), [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: {
    PATH: process.env['PATH'] ?? '', SystemRoot: process.env['SystemRoot'] ?? '',
    DATABASE_URL: runtimeUrl, PUBLIC_ORIGIN: 'http://127.0.0.1:3000', COOKIE_MODE: 'loopback', HOST: '127.0.0.1', NODE_ENV: 'test', TEST_APPLICATION_NAME: application,
  } });
  let output = '', errors = '', address = '';
  child.stdout!.on('data', (chunk) => { output += chunk.toString(); }); child.stderr!.on('data', (chunk) => { errors += chunk.toString(); });
  child.on('message', (message: { ready?: boolean; address?: string }) => { if (message.ready && message.address) address = message.address; });
  let suspended = false;
  try {
    await until(() => !!address);
    let response = await fetch(`${address}/health/ready`); expect(response.status).toBe(200); expect(await response.json()).toEqual({ status: 'ready' });
    let backend = 0;
    await until(async () => {
      const rows = await admin.pool.query<{ pid: number }>("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND state='idle'", [application]);
      backend = rows.rows[0]?.pid ?? 0; return backend > 0;
    });
    // Hold new connections unavailable while killing the ALREADY IDLE real connection.
    // This exercises pool.emit('error'), not an injected Error or merely a failed first connect.
    await admin.pool.query('ALTER ROLE nbcloud_runtime NOLOGIN'); suspended = true;
    expect((await admin.pool.query<{ terminated: boolean }>('SELECT pg_terminate_backend($1) AS terminated', [backend])).rows[0]!.terminated).toBe(true);
    await until(() => errors.includes('DB_IDLE_CONNECTION_LOST'));
    expect(child.exitCode).toBeNull(); expect(child.signalCode).toBeNull();
    response = await fetch(`${address}/health/live`); expect(response.status).toBe(200); expect(await response.json()).toEqual({ status: 'ok' });
    response = await fetch(`${address}/health/ready`); expect(response.status).toBe(503); expect(await response.json()).toEqual({ status: 'not_ready' });
    await admin.pool.query('ALTER ROLE nbcloud_runtime LOGIN'); suspended = false;
    await until(async () => { const ready = await fetch(`${address}/health/ready`); return ready.status === 200 && (await ready.json()).status === 'ready'; });
    expect(child.exitCode).toBeNull();
    for (const url of [runtimeUrl, adminUrl]) {
      expect(output + errors).not.toContain(url); expect(output + errors).not.toContain(decodeURIComponent(new URL(url).password));
    }
    expect(errors.trim()).toBe('{"level":"warn","code":"DB_IDLE_CONNECTION_LOST"}');
  } finally {
    if (suspended) await admin.pool.query('ALTER ROLE nbcloud_runtime LOGIN');
    await stop(child); await closeDb(admin);
  }
}, 30_000);
