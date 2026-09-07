import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createDb, closeDb } from '../../src/db/client.js';
import { executionService } from '../../src/execution/service.js';
import { registerConsole } from '../../src/console.js';

it('serves only built console files, without shadowing JSON API/protocol errors or exposing private paths', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'nbcloud-static-'));
  const root = resolve(directory, 'dist'); await mkdir(resolve(root, 'assets'), { recursive: true });
  const html = '<!doctype html><title>Static fixture</title><script src="/assets/index-test.js"></script>';
  await writeFile(resolve(root, 'index.html'), html); await writeFile(resolve(root, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFile(resolve(root, 'assets/index-test.js'), 'console.log("public asset")'); await writeFile(resolve(root, 'assets/index-test.css'), 'body { color: black }');
  for (const file of ['.env', 'assets/.env', 'assets/leak.js.map', 'assets/source.ts', 'secret.txt']) await writeFile(resolve(root, file), 'must-not-be-served');
  await writeFile(resolve(directory, 'outside.txt'), 'must-not-be-served');
  const db = createDb('postgres://fixture:fixture-password@127.0.0.1:1/fixture');
  const query = vi.spyOn(db.pool, 'query').mockRejectedValue(new Error('UNEXPECTED_SQL'));
  const connect = vi.spyOn(db.pool, 'connect').mockRejectedValue(new Error('UNEXPECTED_CONNECTION'));
  const app = buildApp({ db, env: { DATABASE_URL: 'postgres://fixture:fixture-password@127.0.0.1:1/fixture', PUBLIC_ORIGIN: 'http://localhost:3000', COOKIE_MODE: 'loopback' }, registerAdditionalRoutes: executionService(db, {}).register });
  try {
    expect(await registerConsole(app, root)).toBe(true); await app.ready();
    for (const url of ['/', '/?tab=providers', '/?fixture=1']) {
      const response = await app.inject(url); expect(response.statusCode).toBe(200); expect(response.body).toBe(html);
      expect(response.headers['content-type']).toContain('text/html'); expect(response.headers['cache-control']).toBe('no-store'); expect(response.headers['set-cookie']).toBeUndefined();
    }
    for (const [url, mime] of [['/assets/index-test.js', 'javascript'], ['/assets/index-test.css', 'text/css'], ['/favicon.svg', 'image/svg+xml']]) {
      const response = await app.inject(url!); expect(response.statusCode).toBe(200); expect(response.headers['content-type']).toContain(mime); expect(response.headers['cache-control']).toBe('no-store');
    }
    for (const url of ['/index.html', '/.env', '/assets/.env', '/assets/leak.js.map', '/assets/source.ts', '/secret.txt', '/src/main.tsx', '/test/fixture', '/node_modules/package.json', '/assets/%2e%2e/outside.txt', '/assets/..%2foutside.txt', '/not-a-history-route', '/api', '/api/missing', '/health/missing']) {
      const response = await app.inject(url); expect(response.statusCode, url).toBe(404); expect(response.headers['content-type']).toContain('application/json'); expect(response.body).not.toContain('must-not-be-served');
    }
    const unknown = await app.inject({ method: 'POST', url: '/v1/missing', headers: { 'x-nb-search-protocol': '1' }, payload: {} });
    expect(unknown.statusCode).toBe(404); expect(unknown.headers['x-nb-search-protocol']).toBe('1'); expect(unknown.json().error.code).toBe('NOT_FOUND');
    const invalid = await app.inject({ method: 'POST', url: '/v1/search', headers: { 'x-nb-search-protocol': '1' }, payload: {} });
    expect(invalid.statusCode).toBe(400); expect(invalid.headers['content-type']).toContain('application/json'); expect(invalid.headers['x-nb-search-protocol']).toBe('1');
    expect(query).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled();
  } finally { await app.close(); await closeDb(db); await rm(directory, { recursive: true, force: true }); }
});
it('allows an explicit API-only boot when the console build is absent', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'nbcloud-static-absent-'));
  const app = buildApp({ env: { DATABASE_URL: 'postgres://fixture:fixture-password@127.0.0.1:1/fixture', PUBLIC_ORIGIN: 'http://localhost:3000', COOKIE_MODE: 'loopback' } });
  try { expect(await registerConsole(app, resolve(directory, 'missing'))).toBe(false); expect((await app.inject('/')).statusCode).toBe(404); expect((await app.inject('/health/live')).statusCode).toBe(200); }
  finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
