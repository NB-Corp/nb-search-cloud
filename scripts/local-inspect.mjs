import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), local = resolve(root, '.local');
let browser;
try {
  const { base } = JSON.parse(await readFile(resolve(local, 'deployment.json'), 'utf8'));
  const admin = JSON.parse(await readFile(resolve(local, 'admin.json'), 'utf8'));
  const r = await fetch(base + '/api/admin/auth/login', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify(admin) });
  if (r.status !== 200) throw Error('LOGIN');
  const cookie = r.headers.get('set-cookie').split(';')[0];
  async function get(path) { const response = await fetch(base + '/api/admin' + path, { headers: { origin: base, cookie } }); if (!response.ok) throw Error('API'); return (await response.json()).data; }
  const usage = await get('/usage?limit=25'), quotas = await get('/me/quotas'), providers = await get('/providers?limit=100');
  const report = { base, usage: usage.items.map(j => ({ job_id: j.job_id, state: j.state, delivery: j.delivery, units: j.units, selection: j.selection })), quotas: quotas.items, providers: providers.items.map(p => ({ name: p.name, provider_id: p.provider_id, credential_configured: p.credential_configured, pool_size: p.key_pool.length, pool_selections: p.key_pool_selections })) };
  await writeFile(resolve(local, 'usage-report.json'), JSON.stringify(report, null, 2));
  if (process.argv.includes('--screenshot')) {
    const require = createRequire(resolve(root, 'web/package.json')); const { chromium } = require('@playwright/test');
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(base); await page.locator('#loginForm_tenant').fill(admin.tenant); await page.locator('#loginForm_username').fill(admin.username); await page.locator('#loginForm_password').fill(admin.password);
    const logged = page.waitForResponse(r => new URL(r.url()).pathname === '/api/admin/auth/login' && r.request().method() === 'POST');
    await page.getByRole('button', { name: /登\s*录/ }).click(); if ((await logged).status() !== 200) throw Error('UI_LOGIN');
    const loaded = page.waitForResponse(r => new URL(r.url()).pathname === '/api/admin/usage');
    await page.goto(base + '/?tab=usage'); if ((await loaded).status() !== 200) throw Error('UI_USAGE');
    await page.getByRole('table').first().waitFor();
    await page.screenshot({ path: resolve(local, 'usage.png'), fullPage: true });
  }
  console.log(JSON.stringify(report));
} catch { console.error('LOCAL_INSPECTION_FAILED'); process.exitCode = 1; }
finally { await browser?.close(); }
