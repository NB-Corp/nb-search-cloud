// Test-only browser driver. No page.route, injected API mutations, or production switches.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const webRequire = createRequire(resolve('web/package.json'));
const { chromium, expect } = webRequire('@playwright/test');
export async function openBrowser(base: string, tenant: string, password: string, stage: (value: string) => void) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    stage('browser-login'); await page.goto(base);
    await page.locator('#loginForm_tenant').fill(tenant);
    await page.locator('#loginForm_username').fill('admin');
    await page.locator('#loginForm_password').fill(password);
    await response(page, '/api/admin/auth/login', 'POST', 200, () => page.getByRole('button', { name: /登\s*录/ }).click());
    return { browser, page };
  } catch (error) { await browser.close(); throw error; }
}
async function response(page: any, path: string, method: string, status: number, action: () => Promise<unknown>) {
  const result = page.waitForResponse((r: any) => new URL(r.url()).pathname === path && r.request().method() === method);
  const [r] = await Promise.all([result, action()]); expect(r.status()).toBe(status); return (await r.json()).data;
}
async function choose(page: any, dialog: any, id: string, text: string) {
  await dialog.locator('#' + id).click();
  const target = page.locator('.ant-select-dropdown:visible').getByText(text, { exact: false }).first();
  await expect(target).toHaveCount(1);
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
}
export async function configureThroughUi(page: any, base: string, providerBase: string, providerSecret: string, stage: (value: string) => void) {
  stage('ui-provider'); await page.goto(base + '/?tab=providers');
  await page.getByRole('button', { name: /配置新供应商/ }).click();
  let dialog = page.getByRole('dialog', { name: '配置新搜索 / 抓取供应商', exact: true });
  await dialog.locator('#name').fill('Vertical fixture provider');
  await dialog.locator('#base_url').fill(providerBase); await dialog.locator('#secret').fill(providerSecret);
  const provider = await response(page, '/api/admin/providers', 'POST', 201, () => dialog.getByRole('button', { name: '保存并加密存储' }).click());
  stage('ui-lane'); await page.getByRole('tab', { name: /执行通道/ }).click();
  await page.getByRole('button', { name: /注册新通道/ }).click();
  dialog = page.getByRole('dialog', { name: '注册新执行通道 (Lane)', exact: true });
  await dialog.locator('#id').fill('exa.search');
  await choose(page, dialog, 'provider_id', 'Vertical fixture provider');
  await choose(page, dialog, 'operation_id', 'search (网络搜索查询)');
  await choose(page, dialog, 'latency', 'fast (低时延)');
  // The create form initializes cost to cheap; retain that real UI default.
  await response(page, '/api/admin/lanes', 'POST', 201, () => dialog.getByRole('button', { name: '注册通道', exact: true }).click());
  stage('ui-group'); await page.goto(base + '/?tab=groups');
  await page.getByRole('button', { name: /新建分组/ }).click();
  dialog = page.getByRole('dialog', { name: '新建分组', exact: true });
  await dialog.locator('#name').fill('Vertical fixture group');
  await expect(dialog.locator('#is_exclusive')).toHaveAttribute('aria-checked', 'false');
  await dialog.locator('#daily_units_per_user').fill('10');
  const group = await response(page, '/api/admin/groups', 'POST', 201, () => dialog.getByRole('button', { name: '创建分组', exact: true }).click());
  await page.getByRole('row').filter({ hasText: 'Vertical fixture group' }).getByRole('button', { name: '通道与路由能力' }).click();
  dialog = page.getByRole('dialog', { name: /分组通道与路由能力/ });
  await expect(dialog.getByRole('button', { name: '保存通道能力' })).toBeEnabled();
  await page.waitForTimeout(350);
  await choose(page, dialog, 'default_search_lane', 'exa.search');
  await dialog.getByRole('button', { name: '添加通道映射' }).click();
  await choose(page, dialog, 'lanes_0_lane_id', 'exa.search');
  await dialog.locator('#lanes_0_units_per_query').fill('2');
  await response(page, `/api/admin/groups/${group.id}/capabilities`, 'PUT', 200, () => dialog.getByRole('button', { name: '保存通道能力' }).click());
  stage('ui-key'); await page.goto(base + '/?tab=keys');
  await page.getByRole('button', { name: /新建 API Key/ }).click();
  dialog = page.getByRole('dialog', { name: '新建 API Key', exact: true });
  await dialog.locator('#name').fill('Vertical fixture key');
  await choose(page, dialog, 'group_id', 'Vertical fixture group'); await dialog.locator('#quota_units').fill('10');
  const issued = await response(page, '/api/admin/keys', 'POST', 201, () => dialog.getByRole('button', { name: '生成并签发' }).click());
  dialog = page.getByRole('dialog', { name: /API Key 已生成/ });
  // Observe both the real response and the actual one-time UI display. Never screenshot this dialog.
  await expect(dialog).toContainText(issued.access_key);
  await dialog.getByRole('button', { name: '我已妥善保存，安全关闭' }).click();
  return { provider, group, key: issued.key, token: issued.access_key };
}
export async function inspectUsage(page: any, base: string, job: string, artifact: string, screenshot: string) {
  await page.goto(base + '/?tab=usage');
  const row = page.getByRole('row').filter({ hasText: job.slice(0, 12) }).first();
  await row.getByRole('button', { name: '查看详情' }).click();
  await page.getByRole('button', { name: '安全查看纯文本产物' }).click();
  const modal = page.getByRole('dialog', { name: '任务纯文本产物 (安全只读预览)', exact: true });
  await expect(modal.getByText(artifact, { exact: true })).toBeVisible({ timeout: 20000 });
  await page.screenshot({ path: screenshot, fullPage: true });
}
export async function revokeThroughUi(page: any, base: string, keyId: string) {
  const keysResponse = page.waitForResponse((r: any) => new URL(r.url()).pathname === '/api/admin/keys' && r.request().method() === 'GET');
  await page.goto(base + '/?tab=keys');
  await keysResponse;
  await expect(page.getByText('Vertical fixture key', { exact: true })).toBeVisible({ timeout: 20000 });
  const keyRow = page.getByRole('row').filter({ hasText: 'Vertical fixture key' });
  await expect(keyRow).toBeVisible({ timeout: 20000 });
  await keyRow.getByRole('button', { name: /撤\s*销/ }).click();
  await response(page, `/api/admin/keys/${keyId}`, 'DELETE', 200, () => page.getByRole('button', { name: '永久撤销', exact: true }).click());
}
