import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { createDb, closeDb, type DbHandle } from '../../src/db/client.js';
import { withTransaction } from '../../src/db/transaction.js';
import { ProviderService } from '../../src/execution/providers.js';
import { SecretVault } from '../../src/execution/crypto.js';
import { compatibleSdkVersion, CLOUD_SDK_VERSION } from '../../src/execution/sdk-version.js';
import { integrationDatabaseUrl, prepareIntegrationDatabase } from '../helpers/identity.js';
let db: DbHandle, service: ProviderService;
const master = randomBytes(32).toString('base64'), tenant = randomUUID(), other = randomUUID();
beforeAll(async () => {
  await prepareIntegrationDatabase(); db = createDb(integrationDatabaseUrl());
  await db.pool.query('INSERT INTO tenants(id,slug,name) VALUES($1::uuid,$1::text,$1::text),($2::uuid,$2::text,$2::text)', [tenant, other]);
  service = new ProviderService(CLOUD_SDK_VERSION, new SecretVault('pool-test', master), () => undefined);
});
afterAll(async () => { if (db) await closeDb(db); });
async function workerSelections(config: string) {
  const source = `import{createDb,closeDb}from'./dist/db/client.js';import{ProviderService}from'./dist/execution/providers.js';import{SecretVault}from'./dist/execution/crypto.js';const db=createDb(process.env.DATABASE_URL);try{const s=new ProviderService('0.3.1',new SecretVault('pool-test',process.env.POOL_MASTER),()=>{});const c=await s.config(db.pool,process.env.POOL_TENANT,process.env.POOL_CONFIG);const values=[];for(let i=0;i<6;i++)values.push(await s.selectSecret(db.pool,c));console.log(JSON.stringify(values));}finally{await closeDb(db)}`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, DATABASE_URL: integrationDatabaseUrl(), POOL_MASTER: master, POOL_TENANT: tenant, POOL_CONFIG: config }, stdio: ['ignore','pipe','pipe'] });
  let output = ''; child.stdout.on('data', c => { output += c; }); child.stderr.on('data', () => undefined);
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
  const code = await new Promise((ok, reject) => { child.once('error', reject); child.once('close', ok); }).finally(() => clearTimeout(timeout));
  expect(code).toBe(0); return JSON.parse(output) as string[];
}
it('coordinates two process pools, rotates immutable membership, disables keys, isolates tenant, and retains legacy secret', async () => {
  const created: any = await withTransaction(db, tx => service.create(tx, tenant, { name: 'pooled', provider_id: 'exa', key_pool: [{ label: 'A', secret: 'fake-upstream-A' }, { label: 'B', secret: 'fake-upstream-B' }] }));
  expect(JSON.stringify(created)).not.toContain('fake-upstream'); expect(created.key_pool).toHaveLength(2);
  const row = await service.row(db.pool, tenant, created.id), old = await service.config(db.pool, tenant, row.current_config_id!);
  expect(await service.selectSecret(db.pool, old)).toBe('fake-upstream-A'); expect(await service.selectSecret(db.pool, old)).toBe('fake-upstream-B');
  const values = (await Promise.all([workerSelections(old.id), workerSelections(old.id)])).flat();
  expect(values.filter(v => v === 'fake-upstream-A')).toHaveLength(6); expect(values.filter(v => v === 'fake-upstream-B')).toHaveLength(6);
  expect((await service.get(db.pool, tenant, created.id)).key_pool_selections).toBe('14');
  await expect(service.config(db.pool, other, old.id)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  await expect(withTransaction(db, tx => tx.query('UPDATE provider_config_keys SET enabled=false WHERE config_id=$1', [old.id]))).rejects.toMatchObject({ code: 'P0001' });
  const updated: any = await withTransaction(db, tx => service.patch(tx, tenant, created.id, { expected_revision: 1, key_pool: [{ id: created.key_pool[0].id, enabled: false }, { id: created.key_pool[1].id }] }));
  expect(updated.key_pool_selections).toBe('0');
  const currentRow = await service.row(db.pool, tenant, created.id), current = await service.config(db.pool, tenant, currentRow.current_config_id!);
  expect(await service.selectSecret(db.pool, current)).toBe('fake-upstream-B'); expect(await service.selectSecret(db.pool, current)).toBe('fake-upstream-B');
  expect(await service.selectSecret(db.pool, old)).toBe('fake-upstream-A'); // old job's immutable config is intentionally retained
  const disabled: any = await withTransaction(db, tx => service.patch(tx, tenant, created.id, { expected_revision: 2, key_pool: updated.key_pool.map((k: any) => ({ id: k.id, enabled: false })) }));
  expect(disabled.credential_configured).toBe(false);
  const cleared: any = await withTransaction(db, tx => service.patch(tx, tenant, created.id, { expected_revision: 3, secret: 'fake-legacy' }));
  expect(cleared.key_pool).toEqual([]);
  const legacy = await service.row(db.pool, tenant, created.id);
  expect(await service.selectSecret(db.pool, await service.config(db.pool, tenant, legacy.current_config_id!))).toBe('fake-legacy');
  const bytes = await db.pool.query("SELECT encode(ciphertext,'escape') AS ciphertext FROM provider_config_keys WHERE tenant_id=$1", [tenant]);
  expect(JSON.stringify(bytes.rows)).not.toContain('fake-upstream');
});
it('compatibility is limited to the admitted patch family, not arbitrary SDK releases', () => {
  expect(compatibleSdkVersion('0.3.0', '0.3.1')).toBe(true);
  expect(compatibleSdkVersion('0.3.1', '0.4.0')).toBe(true);
  expect(compatibleSdkVersion('0.3.0', '0.4.0')).toBe(true);
  expect(compatibleSdkVersion('0.4.0', '0.5.0')).toBe(false);
  expect(compatibleSdkVersion('unknown', CLOUD_SDK_VERSION)).toBe(false);
});
