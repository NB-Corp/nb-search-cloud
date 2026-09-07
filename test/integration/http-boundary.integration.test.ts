import { request as httpRequest } from 'node:http';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createDb, closeDb, type DbHandle } from '../../src/db/client.js';
import { executionService } from '../../src/execution/service.js';
import { integrationDatabaseUrl, prepareIntegrationDatabase } from '../helpers/identity.js';
let app: ReturnType<typeof buildApp>, db: DbHandle, base: string;
beforeAll(async () => {
  await prepareIntegrationDatabase(); db = createDb(integrationDatabaseUrl());
  app = buildApp({ db, env: { DATABASE_URL: integrationDatabaseUrl(), PUBLIC_ORIGIN: 'http://127.0.0.1:3000', COOKIE_MODE: 'loopback' }, registerAdditionalRoutes: executionService(db, {}).register });
  base = await app.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => { if (app) await app.close(); if (db) await closeDb(db); });
it('bounds rejected-upload draining and survives a real client abort without accepting or buffering the oversized body', async () => {
  const headers = { 'x-nb-search-protocol': '1', 'content-type': 'application/json', 'content-length': '2000000' };
  const start = Date.now();
  const result = await new Promise<{ status: number | undefined; body: string; connection: string | undefined }>((resolve, reject) => {
    const req = httpRequest(base + '/v1/search', { method: 'POST', headers, agent: false }, (res) => {
      let body = ''; res.on('data', (chunk) => { body += chunk.toString(); });
      res.on('end', () => { resolve({ status: res.statusCode, body, connection: res.headers.connection }); req.destroy(); });
      res.on('error', reject);
    });
    req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('REJECTED_UPLOAD_NOT_BOUNDED')));
    req.write('{'); // Deliberately never finish the claimed 2MB body.
  });
  expect(result.status).toBe(413); expect(result.connection).toBe('close'); expect(JSON.parse(result.body).error.code).toBe('REQUEST_TOO_LARGE');
  expect(Date.now() - start).toBeGreaterThanOrEqual(750); expect(Date.now() - start).toBeLessThan(5000);
  await new Promise<void>((resolve) => {
    const req = httpRequest(base + '/v1/search', { method: 'POST', headers, agent: false });
    req.on('error', () => undefined); req.once('close', resolve); req.write('{'); setTimeout(() => req.destroy(), 30);
  });
  expect((await fetch(base + '/health/live')).status).toBe(200);
});
