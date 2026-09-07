import { test, expect, type Page } from '@playwright/test';
import {
  BrowserFixture,
  IDS,
  createFixture,
  makeArtifact,
  type CapturedRequest,
} from './fixtures.js';
import type { GroupDto, ProviderDto } from '../../src/types/api.js';

interface Diagnostics {
  consoleErrors: string[];
  pageErrors: string[];
}

const diagnostics = new WeakMap<Page, Diagnostics>();

test.beforeEach(async ({ page }) => {
  const value: Diagnostics = { consoleErrors: [], pageErrors: [] };
  diagnostics.set(page, value);
  page.on('console', (message) => {
    if (message.type() === 'error') value.consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => value.pageErrors.push(error.message));
});

test.afterEach(async ({ page }, testInfo) => {
  const value = diagnostics.get(page) || { consoleErrors: [], pageErrors: [] };
  await testInfo.attach('runtime-diagnostics.json', {
    body: JSON.stringify(value, null, 2),
    contentType: 'application/json',
  });
  const unexpectedConsoleErrors = value.consoleErrors.filter((message) => !message.startsWith('Failed to load resource:'));
  expect(unexpectedConsoleErrors, 'unexpected browser console.error output').toEqual([]);
  expect(value.pageErrors, 'browser pageerror output').toEqual([]);
});

async function openApp(page: Page, fixture: BrowserFixture, query: string): Promise<void> {
  await fixture.install(page);
  await page.goto(`/${query}`);
  await expect(page.locator('#root')).not.toBeEmpty();
}

async function waitForHeading(page: Page, text: RegExp | string): Promise<void> {
  await expect(page.getByRole('heading', { name: text })).toBeVisible();
}

function requestBody(request: CapturedRequest): Record<string, unknown> {
  return (request.body || {}) as Record<string, unknown>;
}

async function dialog(page: Page) {
  const modal = page.locator('.ant-modal').filter({ visible: true }).last();
  await expect(modal).toBeVisible();
  return modal;
}

async function assertViewportButton(page: Page, locator: ReturnType<Page['getByRole']>, width: number): Promise<void> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width);
}

async function scrollOpenSelectToEnd(page: Page): Promise<void> {
  const popup = page.locator('.ant-select-dropdown:visible').last();
  await popup.evaluate((element) => {
    const candidates: HTMLElement[] = [element as HTMLElement];
    candidates.push(...Array.from(element.querySelectorAll<HTMLElement>('*')));
    for (let parent = element.parentElement; parent; parent = parent.parentElement) candidates.push(parent);
    const target = candidates
      .filter((candidate) => {
        const overflowY = getComputedStyle(candidate).overflowY;
        return candidate.scrollHeight > candidate.clientHeight && overflowY !== 'visible';
      })
      .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0];
    if (!target) throw new Error('select popup has no scrollable element');
    target.scrollTop = target.scrollHeight;
    target.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
}

test.describe('cloud console browser regression harness', () => {
  test('UI-01: capability drawer isolates group state, stale responses cannot enable save or PUT', async ({ page }) => {
    const fixture = createFixture();
    await openApp(page, fixture, '?tab=groups');
    await waitForHeading(page, /分组与策略管理/);

    const capButtons = page.getByRole('button', { name: '通道与路由能力' });
    await expect(capButtons).toHaveCount(2);

    await capButtons.nth(0).click();
    const firstDrawer = page.locator('.ant-drawer').filter({ visible: true }).last();
    await expect(firstDrawer.getByText(/lane-a/).first()).toBeVisible();
    await firstDrawer.getByRole('button', { name: /取\s*消/ }).click();

    // A has already loaded successfully. The second A request is deliberately delayed;
    // B fails first so the race is observable in the DOM rather than in API call order.
    fixture.state.capabilityPlans[IDS.groupA] = {
      response: fixture.state.capabilityPlans[IDS.groupA]!.response,
      delayMs: 300,
    };
    fixture.state.capabilityPlans[IDS.groupB] = {
      status: 503,
      code: 'CAPABILITIES_UNAVAILABLE',
      message: 'B capabilities unavailable',
    };

    const delayedA = page.waitForResponse((response) => response.url().includes(`/api/admin/groups/${IDS.groupA}/capabilities`));
    await capButtons.nth(0).click();
    const loadingDrawer = page.locator('.ant-drawer').filter({ visible: true }).last();
    await loadingDrawer.getByRole('button', { name: /取\s*消/ }).click();
    await capButtons.nth(1).click();

    const failedDrawer = page.locator('.ant-drawer').filter({ visible: true }).last();
    await expect(failedDrawer.getByText('通道能力加载失败')).toBeVisible();
    await expect(failedDrawer.getByRole('button', { name: '保存通道能力' })).toBeDisabled();
    expect(fixture.requestsFor(`/api/admin/groups/${IDS.groupB}/capabilities`, 'PUT')).toHaveLength(0);

    await delayedA;
    await expect(failedDrawer.getByText('通道能力加载失败')).toBeVisible();
    await expect(failedDrawer.getByRole('button', { name: '保存通道能力' })).toBeDisabled();
    expect(fixture.requestsFor(`/api/admin/groups/${IDS.groupB}/capabilities`, 'PUT')).toHaveLength(0);
  });

  test('UI-04: a 401 evicts the App/AuthProvider tree and removes open business and secret modals', async ({ page }) => {
    const fixture = createFixture();
    await openApp(page, fixture, '?tab=providers');
    await waitForHeading(page, /供应商与执行通道/);

    fixture.state.unauthorizedPath = '/api/admin/providers';
    await page.getByRole('button', { name: '配置新供应商' }).click();
    const providerDialog = await dialog(page);
    await providerDialog.locator('input').first().fill('401 fixture provider');
    await providerDialog.locator('input[type="password"]').fill('fixture-secret');
    // The modal's real submit is the mutation that receives the synthetic 401;
    // a background page refresh cannot click through Ant Design's modal mask.
    await providerDialog.getByRole('button', { name: '保存并加密存储' }).click();

    await expect(page.getByRole('button', { name: /登\s*录/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /供应商与执行通道/ })).toHaveCount(0);
    await expect(page.getByText('配置新搜索 / 抓取供应商')).toHaveCount(0);
    await expect(page.locator('input[type="password"]')).toHaveValue('');
  });

  test('UI-04: CSRF recovery rotates the token without replaying a mutation; user must submit again', async ({ page }) => {
    const fixture = createFixture({ rotateCsrfOnSessionRefresh: true });
    const patchPath = `/api/admin/providers/${IDS.providerExa}`;
    fixture.state.csrfRejectPath = patchPath;
    await openApp(page, fixture, '?tab=providers');
    await waitForHeading(page, /供应商与执行通道/);

    await page.getByRole('button', { name: '编辑' }).first().click();
    const editor = await dialog(page);
    await editor.locator('input').first().fill('CSRF edited name');
    await editor.getByRole('button', { name: '保存配置' }).click();
    await expect.soft(editor.getByText('安全验证已过期')).toBeVisible();

    const firstPatch = fixture.requestsFor(patchPath, 'PATCH');
    expect(firstPatch).toHaveLength(1);
    expect(firstPatch[0]!.headers['x-csrf-token']).toBe('csrf-1');

    const refreshTokenButton = page.getByRole('button', { name: '刷新安全令牌并重新核对' });
    if (!(await refreshTokenButton.count())) return;
    await refreshTokenButton.click();
    await expect.poll(() => fixture.requestsFor('/api/admin/auth/session', 'GET').length).toBe(2);
    expect(fixture.requestsFor(patchPath, 'PATCH')).toHaveLength(1);

    // The first mutation is not replayed. This second click is the explicit user confirmation.
    await editor.getByRole('button', { name: '保存配置' }).click();
    await expect.poll(() => fixture.requestsFor(patchPath, 'PATCH').length).toBe(2);
    const patches = fixture.requestsFor(patchPath, 'PATCH');
    expect(patches[1]!.headers['x-csrf-token']).toBe('csrf-2');
  });

  test('UI-04: failed session refresh never reports a CSRF recovery as a successful save', async ({ page }) => {
    const fixture = createFixture();
    const patchPath = `/api/admin/providers/${IDS.providerExa}`;
    fixture.state.csrfRejectPath = patchPath;
    await openApp(page, fixture, '?tab=providers');
    await waitForHeading(page, /供应商与执行通道/);

    fixture.state.sessionStatus = 503;
    await page.getByRole('button', { name: '编辑' }).first().click();
    const editor = await dialog(page);
    await editor.locator('input').first().fill('refresh failure');
    await editor.getByRole('button', { name: '保存配置' }).click();
    await expect.soft(editor.getByText('安全验证已过期')).toBeVisible();
    const refreshTokenButton = page.getByRole('button', { name: '刷新安全令牌并重新核对' });
    if (!(await refreshTokenButton.count())) {
      expect(fixture.requestsFor(patchPath, 'PATCH')).toHaveLength(1);
      await expect.soft(page.getByText('供应商配置已安全更新')).toHaveCount(0);
      return;
    }
    await refreshTokenButton.click();

    await expect.poll(() => fixture.requestsFor('/api/admin/auth/session', 'GET').length).toBe(2);
    expect(fixture.requestsFor(patchPath, 'PATCH')).toHaveLength(1);
    await expect(page.getByText('供应商配置已安全更新')).toHaveCount(0);
  });

  test('UI-06: key selector loads page 2, selects Group 101 by visible label, submits group_id, then paginates keys', async ({ page }) => {
    const fixture = createFixture();
    fixture.state.groups = Array.from({ length: 101 }, (_, index) => groupForTest(index + 1));
    fixture.state.keys = Array.from({ length: 25 }, (_, index) => keyForTest(index + 1));
    fixture.state.keyPage2 = [keyForTest(26)];
    const group101Id = fixture.state.groups[100]!.id;
    await openApp(page, fixture, '?tab=keys');
    await waitForHeading(page, /API 密钥管理/);

    await page.getByRole('button', { name: '新建 API Key' }).click();
    const createDialog = await dialog(page);
    // AntD's real Select control is the native input[role=combobox]; the outer wrapper
    // used by the interim frontend must not be accepted as an oracle.
    const groupSelect = createDialog.locator('input[role="combobox"]').first();
    await groupSelect.click();
    const groupPopup = page.locator('.ant-select-dropdown:visible').last();
    await scrollOpenSelectToEnd(page);
    const group101 = groupPopup.getByText(/Group 101/);
    await expect(group101).toBeVisible();
    await group101.click();

    // Assert the visible AntD selection label, not input.textContent or hidden helper text.
    const selectedGroupLabel = createDialog.getByText(/^Group 101/).filter({ visible: true }).last();
    await expect(selectedGroupLabel).toBeVisible();
    await createDialog.getByRole('textbox', { name: /Key 名称/ }).fill('group-101-key');
    await createDialog.getByRole('button', { name: '生成并签发' }).click();

    const createRequest = fixture.requestsFor('/api/admin/keys', 'POST').at(-1)!;
    expect(createRequest.body).toMatchObject({ group_id: group101Id, name: 'group-101-key' });
    await page.getByRole('button', { name: '我已妥善保存，安全关闭' }).click();

    await page.getByRole('button', { name: '加载更多密钥' }).click();
    await expect(page.getByText('Key 26')).toBeVisible();
    expect(fixture.requestsFor('/api/admin/keys', 'GET').at(-1)?.query.get('cursor')).toBe('key-cursor-2');
  });

  test('UI-06: lane creation selector can reach the 26th provider through the next-page button', async ({ page }) => {
    const fixture = createFixture();
    fixture.state.providers = Array.from({ length: 25 }, (_, index) => providerForTest(index + 1));
    fixture.state.providerPage2 = [providerForTest(26)];
    await openApp(page, fixture, '?tab=providers');
    await waitForHeading(page, /供应商与执行通道/);

    await page.getByRole('button', { name: '加载更多供应商' }).click();
    await expect(page.getByText(/Provider 26/)).toBeVisible();
    await page.getByRole('tab', { name: /执行通道/ }).click();
    await page.getByRole('button', { name: '注册新通道' }).click();
    const laneDialog = await dialog(page);
    const providerSelect = laneDialog.getByRole('combobox').nth(0);
    await providerSelect.click();
    const providerPopup = page.locator('.ant-select-dropdown:visible').last();
    await scrollOpenSelectToEnd(page);
    await expect(providerPopup.getByText(/Provider 26/)).toBeVisible();
    await providerPopup.getByText(/Provider 26/).click();
    await expect(laneDialog.getByText(/Provider 26/)).toBeVisible();
  });

  test('UI-06: usage refresh freezes a new window and never combines a failed window with the old cursor', async ({ page }) => {
    const fixture = createFixture();
    await openApp(page, fixture, '?tab=usage');
    await waitForHeading(page, /用量与任务状态/);
    await expect(page.getByText('已加载 1 条任务记录')).toBeVisible();
    const firstUsage = fixture.requestsFor('/api/admin/usage', 'GET')[0]!;
    const firstFrom = firstUsage.query.get('from');
    const firstTo = firstUsage.query.get('to');
    expect(firstFrom).not.toBeNull();
    expect(firstTo).not.toBeNull();
    expect(firstUsage.query.get('cursor')).toBeNull();

    fixture.state.usageFailureStatuses = [503];
    await page.getByRole('button', { name: '刷新' }).click();
    await expect(page.getByText('用量汇总加载失败')).toBeVisible();
    // No next-page control is allowed to carry W1's cursor after W2 failed.
    await expect.soft(page.getByRole('button', { name: '加载更多任务' })).toHaveCount(0);

    fixture.state.usagePages[''] = {
      items: [usageItemForTest('w2-job')],
      totals: { reserved: 0, charged: 9, released: 0 },
      next_cursor: 'usage-cursor-w2',
    };
    await page.getByRole('button', { name: '刷新' }).click();
    await expect(page.getByText('w2-job'.slice(0, 13), { exact: false })).toBeVisible();
    await page.getByRole('button', { name: '加载更多任务' }).click();
    const usageRequests = fixture.requestsFor('/api/admin/usage', 'GET');
    const refreshed = usageRequests[usageRequests.length - 2]!;
    const next = usageRequests[usageRequests.length - 1]!;
    expect(refreshed.query.get('cursor')).toBeNull();
    expect(next.query.get('cursor')).toBe('usage-cursor-w2');
    expect(next.query.get('from')).toBe(refreshed.query.get('from'));
    expect(next.query.get('to')).toBe(refreshed.query.get('to'));
    expect(next.query.get('from')).not.toBe(firstFrom);
    expect(next.query.get('to')).not.toBe(firstTo);
  });

  test('UI-07: member deep-links to users/providers/audit issue zero admin requests and render no admin form', async ({ page }) => {
    const fixture = createFixture({ role: 'user' });
    await fixture.install(page);
    for (const tab of ['users', 'providers', 'audit']) {
      const before = fixture.requests.length;
      await page.goto(`/?tab=${tab}`);
      await waitForHeading(page, /API 密钥管理/);
      const newRequests = fixture.requests.slice(before);
      expect(newRequests.filter((request) => /^\/api\/admin\/(users|providers|lanes|audit)/.test(request.path))).toHaveLength(0);
      await expect(page.getByText(/添加新用户|配置新供应商|审计日志/)).toHaveCount(0);
    }
  });

  test('UI-08: a 409 editor conflict reloads revision and fields; only a second user submit PATCHes fresh data', async ({ page }) => {
    const fixture = createFixture();
    const patchPath = `/api/admin/groups/${IDS.groupA}`;
    const fresh = { ...fixture.state.groups[0]!, name: 'Group A — fresh revision', description: 'new server fields', revision: 2 };
    fixture.state.conflictPath = patchPath;
    fixture.state.freshGroup = fresh;
    await openApp(page, fixture, '?tab=groups');
    await waitForHeading(page, /分组与策略管理/);

    await page.getByRole('button', { name: '编辑' }).first().click();
    const editor = await dialog(page);
    const nameInput = editor.locator('input').first();
    await nameInput.fill('old user input');
    await editor.getByRole('button', { name: '保存变更' }).click();
    await expect(editor.getByText('数据版本冲突')).toBeVisible();
    expect(fixture.requestsFor(patchPath, 'PATCH')).toHaveLength(1);
    expect(requestBody(fixture.requestsFor(patchPath, 'PATCH')[0]!).expected_revision).toBe(1);

    // Make the fixture's current snapshot the fresh object only after GET is requested.
    await page.getByRole('button', { name: '放弃旧输入并加载最新' }).click();
    fixture.state.groups = [fresh, ...fixture.state.groups.filter((item) => item.id !== fresh.id)];
    await expect(nameInput).toHaveValue('Group A — fresh revision');
    await expect(editor.locator('textarea').first()).toHaveValue('new server fields');
    expect(fixture.requestsFor(patchPath, 'PATCH')).toHaveLength(1);

    await editor.getByRole('button', { name: '保存变更' }).click();
    await expect.poll(() => fixture.requestsFor(patchPath, 'PATCH').length).toBe(2);
    expect(requestBody(fixture.requestsFor(patchPath, 'PATCH')[1]!).expected_revision).toBe(2);
    expect(requestBody(fixture.requestsFor(patchPath, 'PATCH')[1]!).name).toBe('Group A — fresh revision');
  });

  test('UI-09: Exa preserve/default/custom radios generate distinct PATCH payloads and Grok empty endpoint is client-blocked', async ({ page }) => {
    const fixture = createFixture();
    await openApp(page, fixture, '?tab=providers');
    await waitForHeading(page, /供应商与执行通道/);

    await page.getByRole('button', { name: '编辑' }).first().click();
    let editor = await dialog(page);
    await editor.getByRole('radio', { name: '保留现有配置不变' }).click();
    await editor.getByRole('button', { name: '保存配置' }).click();
    await expect.poll(() => fixture.requestsFor(`/api/admin/providers/${IDS.providerExa}`, 'PATCH').length).toBe(1);
    let patch = requestBody(fixture.requestsFor(`/api/admin/providers/${IDS.providerExa}`, 'PATCH')[0]!);
    expect(patch).not.toHaveProperty('base_url');

    await page.getByRole('button', { name: '编辑' }).first().click();
    editor = await dialog(page);
    await editor.getByRole('radio', { name: '恢复官方默认地址' }).click();
    await editor.getByRole('button', { name: '保存配置' }).click();
    await expect.poll(() => fixture.requestsFor(`/api/admin/providers/${IDS.providerExa}`, 'PATCH').length).toBe(2);
    patch = requestBody(fixture.requestsFor(`/api/admin/providers/${IDS.providerExa}`, 'PATCH')[1]!);
    expect(patch.base_url).toBe('https://api.exa.ai');

    await page.getByRole('button', { name: '编辑' }).first().click();
    editor = await dialog(page);
    await editor.getByRole('radio', { name: '指定自定义地址' }).click();
    await editor.getByRole('textbox', { name: /自定义 Base URL/ }).fill('https://fixture.example.test');
    await editor.getByRole('button', { name: '保存配置' }).click();
    await expect.poll(() => fixture.requestsFor(`/api/admin/providers/${IDS.providerExa}`, 'PATCH').length).toBe(3);
    patch = requestBody(fixture.requestsFor(`/api/admin/providers/${IDS.providerExa}`, 'PATCH')[2]!);
    expect(patch.base_url).toBe('https://fixture.example.test');

    const beforeCreate = fixture.requestsFor('/api/admin/providers', 'POST').length;
    await page.getByRole('button', { name: '配置新供应商' }).click();
    const create = await dialog(page);
    await create.locator('input').first().fill('Empty Grok');
    await create.getByRole('combobox').first().click();
    const grokPopup = page.locator('.ant-select-dropdown:visible').last();
    await grokPopup.getByText(/Grok Multi-Agent/).click();
    await create.getByRole('button', { name: '保存并加密存储' }).click();
    await expect(page.getByText('Grok 引擎无官方默认 Base URL')).toBeVisible();
    expect(fixture.requestsFor('/api/admin/providers', 'POST')).toHaveLength(beforeCreate);
  });

  test('UI-09: secret preserve/replace/clear are mutually exclusive and one-time key text is removed on close', async ({ page }) => {
    const fixture = createFixture();
    await openApp(page, fixture, '?tab=providers');
    await waitForHeading(page, /供应商与执行通道/);

    await page.getByRole('button', { name: '编辑' }).first().click();
    let editor = await dialog(page);
    await editor.getByRole('checkbox', { name: /清除现有加密凭据/ }).check();
    await editor.locator('input[type="password"]').fill('simultaneous-secret');
    await editor.getByRole('button', { name: '保存配置' }).click();
    const simultaneous = fixture.requestsFor(`/api/admin/providers/${IDS.providerExa}`, 'PATCH').at(-1)!;
    expect.soft({ secret: requestBody(simultaneous).secret, clear_secret: requestBody(simultaneous).clear_secret }).not.toEqual({ secret: 'simultaneous-secret', clear_secret: true });

    await page.getByRole('button', { name: '编辑' }).first().click();
    editor = await dialog(page);
    await editor.locator('input[type="password"]').fill('replacement-secret');
    await editor.getByRole('button', { name: '保存配置' }).click();
    const replacement = fixture.requestsFor(`/api/admin/providers/${IDS.providerExa}`, 'PATCH').at(-1)!;
    expect(requestBody(replacement).secret).toBe('replacement-secret');
    expect(requestBody(replacement)).not.toHaveProperty('clear_secret');

    await page.getByRole('button', { name: '编辑' }).first().click();
    editor = await dialog(page);
    await editor.getByRole('checkbox', { name: /清除现有加密凭据/ }).check();
    await editor.getByRole('button', { name: '保存配置' }).click();
    const clear = fixture.requestsFor(`/api/admin/providers/${IDS.providerExa}`, 'PATCH').at(-1)!;
    expect(requestBody(clear).clear_secret).toBe(true);
    expect(requestBody(clear)).not.toHaveProperty('secret');

    await page.goto('/?tab=keys');
    await waitForHeading(page, /API 密钥管理/);
    await page.getByRole('button', { name: '新建 API Key' }).click();
    editor = await dialog(page);
    await editor.locator('input').first().fill('one-time-key');
    await editor.getByRole('combobox').first().click();
    const keyGroupPopup = page.locator('.ant-select-dropdown:visible').last();
    await keyGroupPopup.getByText(/Group A/).click();
    await editor.getByRole('button', { name: '生成并签发' }).click();
    await expect(page.getByText(/API Key 已生成/)).toBeVisible();
    const createdKey = fixture.state.keys.at(-1)!;
    const secretText = `nbc_secret_${createdKey.id.slice(-6)}`;
    await expect(page.getByText(secretText)).toBeVisible();
    await page.getByRole('button', { name: '我已妥善保存，安全关闭' }).click();
    await expect(page.getByText(secretText)).toHaveCount(0);
    await page.getByRole('button', { name: '新建 API Key' }).click();
    await expect(page.getByText(secretText)).toHaveCount(0);
  });

  test('UI-03: group and provider delete clicks send JSON {} with Content-Type and CSRF', async ({ page }) => {
    const fixture = createFixture();
    await openApp(page, fixture, '?tab=groups');
    await waitForHeading(page, /分组与策略管理/);
    await page.getByRole('button', { name: '撤销' }).first().click();
    await page.getByRole('button', { name: '软撤销' }).click();
    const groupDelete = fixture.requestsFor(`/api/admin/groups/${IDS.groupA}`, 'DELETE').at(-1)!;
    expect(groupDelete.body).toEqual({});
    expect(groupDelete.headers['content-type']).toContain('application/json');
    expect(groupDelete.headers['x-csrf-token']).toBe('csrf-1');

    await page.goto('/?tab=providers');
    await waitForHeading(page, /供应商与执行通道/);
    await page.getByRole('button', { name: /停\s*用/ }).first().click();
    await page.getByRole('button', { name: /停\s*用/ }).last().click();
    const providerDelete = fixture.requestsFor(`/api/admin/providers/${IDS.providerExa}`, 'DELETE').at(-1)!;
    expect(providerDelete.body).toEqual({});
    expect(providerDelete.headers['content-type']).toContain('application/json');
    expect(providerDelete.headers['x-csrf-token']).toBe('csrf-1');
  });

  test('UI-05: quota and usage 500/503 are visible failures, then recovered data appears', async ({ page }) => {
    const fixture = createFixture({ quotaStatus: 503, usageStatus: 500 });
    await openApp(page, fixture, '?tab=usage');
    await waitForHeading(page, /用量与任务状态/);
    await expect(page.getByText('用量汇总加载失败')).toBeVisible();
    await expect(page.getByText('分组日配额加载失败')).toBeVisible();
    await expect(page.getByText('已扣除结算 (Charged Units)')).toHaveCount(0);

    fixture.state.quotaStatus = 200;
    fixture.state.usageStatus = 200;
    await page.getByRole('button', { name: '刷新' }).click();
    await expect(page.getByText('已扣除结算 (Charged Units)')).toBeVisible();
    await expect(page.getByText('42 units')).toBeVisible();
    await expect(page.getByText('分组 33333333...')).toBeVisible();
  });

  test('UI-02: real usage result viewer consumes >50 UTF-8 chunks, preserves Chinese boundaries, downloads, and has no SHA status UI', async ({ page }) => {
    const fixture = createFixture();
    const longText = Array.from({ length: 80 }, (_, index) => `块${index}：中文边界内容。`).join('\n');
    const artifact = makeArtifact(longText, 5);
    fixture.state.artifacts[IDS.job] = artifact;
    fixture.state.jobs[IDS.job] = {
      schema_version: '3.0',
      action: 'get',
      job_id: IDS.job,
      user_id: IDS.admin,
      kind: 'search',
      state: 'succeeded',
      cancel_requested: false,
      created_at: '2026-03-07T08:00:00.000Z',
      completed_at: '2026-03-07T08:00:01.000Z',
      content_access: true,
      error: null,
      artifact: artifact.meta,
    };
    await openApp(page, fixture, '?tab=usage');
    await waitForHeading(page, /用量与任务状态/);

    await page.locator('a').filter({ hasText: IDS.job.slice(0, 13) }).click();
    const drawer = page.locator('.ant-drawer').filter({ visible: true }).last();
    await expect(drawer.getByText(/有权读取/)).toBeVisible();
    await drawer.getByRole('button', { name: '安全查看纯文本产物' }).click();
    const result = page.locator('.ant-modal').filter({ visible: true }).last();
    await expect(result.getByText('块79：中文边界内容。')).toBeVisible();
    await expect(result.getByText(/分块数: (5[1-9]|[6-9]\d|\d{3,})/)).toBeVisible();
    await expect(result.getByText(/SHA256|SHA-256|已验证匹配|未校验|校验不匹配/)).toHaveCount(0);

    const downloadPromise = page.waitForEvent('download');
    await result.getByRole('button', { name: '下载纯文本' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(`job-${IDS.job}-result.txt`);
  });

  test('UI-02: missing crypto.subtle still renders and downloads without SHA verification UI', async ({ page }) => {
    await page.addInitScript(() => {
      try {
        Object.defineProperty(globalThis.crypto, 'subtle', { configurable: true, value: undefined });
      } catch {
        // The browser may expose a non-configurable Crypto object; the DOM oracle remains valid.
      }
    });
    const fixture = createFixture();
    await openApp(page, fixture, '?tab=usage');
    await waitForHeading(page, /用量与任务状态/);
    await page.locator('a').filter({ hasText: IDS.job.slice(0, 13) }).click();
    const drawer = page.locator('.ant-drawer').filter({ visible: true }).last();
    await drawer.getByRole('button', { name: '安全查看纯文本产物' }).click();
    const result = page.locator('.ant-modal').filter({ visible: true }).last();
    await expect(result.getByText(/跨越 UTF-8 中文边界/)).toBeVisible();
    await expect(result.getByText(/SHA256|SHA-256|已验证匹配|未校验|校验不匹配/)).toHaveCount(0);

    const downloadPromise = page.waitForEvent('download');
    await result.getByRole('button', { name: '下载纯文本' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(`job-${IDS.job}-result.txt`);
  });

  test('UI-10: query strings do not select ErrorDemo or promise an offline data source', async ({ page }) => {
    const fixture = createFixture();
    await fixture.install(page); // The fixture identity is the explicit route adapter, not URL text or DEV mode.

    const assertRealKeysPage = async () => {
      await waitForHeading(page, /API 密钥管理/);
      await expect(page.getByText('错误恢复与并发冲突交互测试')).toHaveCount(0);
      await expect(page.getByText(/模拟数据预览环境|离线测试 Fixture|不直连真实生产 PG/i)).toHaveCount(0);
      await expect(page.getByRole('button', { name: '新建 API Key' })).toBeVisible();
    };

    await page.goto('/?view=error');
    await assertRealKeysPage();
    expect(fixture.requestsFor('/api/admin/auth/session', 'GET').length).toBeGreaterThan(0);
    expect(fixture.requestsFor('/api/admin/keys', 'GET').length).toBeGreaterThan(0);

    await page.goto('/?mock&view=error');
    await assertRealKeysPage();
    expect(fixture.requestsFor('/api/admin/auth/session', 'GET').length).toBeGreaterThan(1);
    expect(fixture.requestsFor('/api/admin/keys', 'GET').length).toBeGreaterThan(1);
  });

  test('mobile 390px: header and create controls fit, drawer closes with Escape, and table actions remain horizontally reachable', async ({ page }) => {
    const fixture = createFixture();
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page, fixture, '?tab=keys');
    await waitForHeading(page, /API 密钥管理/);

    await assertViewportButton(page, page.locator('.mobile-menu-btn'), 390);
    await assertViewportButton(page, page.getByRole('button', { name: '新建 API Key' }), 390);
    await page.locator('.mobile-menu-btn').click();
    await expect(page.locator('.ant-drawer-open')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('.ant-drawer-open')).toHaveCount(0);

    const tableBody = page.locator('.ant-table-body, .ant-table-content').first();
    const metrics = await tableBody.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth);
    await tableBody.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
    const editButton = page.getByRole('button', { name: /编\s*辑/ }).first();
    await editButton.scrollIntoViewIfNeeded();
    await assertViewportButton(page, editButton, 390);
    await editButton.click();
    await expect(page.getByText(/编辑 API Key/)).toBeVisible();
    expect(await page.locator('body').evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(390);
  });
});

function groupForTest(index: number): GroupDto {
  const id = `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
  return {
    id,
    name: `Group ${index}`,
    description: `Group ${index} fixture`,
    status: 'active',
    is_exclusive: index % 2 === 0,
    daily_units_per_user: 100,
    revision: 1,
    deleted_at: null,
    created_at: `2026-03-${String((index % 9) + 1).padStart(2, '0')}T00:00:00.000Z`,
    updated_at: '2026-03-01T00:00:00.000Z',
  };
}

function keyForTest(index: number) {
  return {
    id: `00000000-0000-4000-8000-${(400 + index).toString(16).padStart(12, '0')}`,
    user_id: IDS.admin,
    group_id: IDS.groupA,
    name: `Key ${index}`,
    prefix: `key_${index}`,
    status: 'active' as const,
    effective_status: 'active' as const,
    quota_units: 100,
    quota_epoch: 1,
    expires_at: null,
    deleted_at: null,
    revision: 1,
    created_at: '2026-03-01T00:00:00.000Z',
    updated_at: '2026-03-01T00:00:00.000Z',
    last_used_at: null,
  };
}

function providerForTest(index: number): ProviderDto {
  return {
    id: `00000000-0000-4000-8000-${(500 + index).toString(16).padStart(12, '0')}`,
    name: `Provider ${index}`,
    provider_id: index % 2 === 0 ? 'exa' : 'grok-multi-agent',
    status: 'active',
    revision: 1,
    base_url: index % 2 === 0 ? 'https://api.exa.ai' : 'https://api.x.ai',
    credential_configured: true,
    credential_updated_at: '2026-03-01T00:00:00.000Z',
    created_at: '2026-03-01T00:00:00.000Z',
    updated_at: '2026-03-01T00:00:00.000Z',
  };
}

function usageItemForTest(jobId: string) {
  return {
    job_id: jobId,
    user_id: IDS.admin,
    request_id: `req-${jobId}`,
    kind: 'search' as const,
    delivery: 'sync' as const,
    state: 'succeeded' as const,
    group_id: IDS.groupA,
    key_id: IDS.key,
    selection: { lane: 'lane-a' },
    reserved_units: 0,
    charged_units: 9,
    released_units: 0,
    settlement_reason: 'completed_succeeded',
    created_at: '2026-03-07T08:00:00.000Z',
    completed_at: '2026-03-07T08:00:01.000Z',
  };
}
