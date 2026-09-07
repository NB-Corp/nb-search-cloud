import { createHash } from 'node:crypto';
import type { Page, Route } from '@playwright/test';
import type {
  ArtifactChunkDto,
  AuditEventDto,
  GroupCapabilitiesDto,
  GroupDto,
  JobDetailDto,
  JobReadResponseDto,
  KeyDto,
  LaneDto,
  ProviderCatalogDto,
  ProviderDto,
  SessionDto,
  UsageReportDto,
  UserDto,
  UserQuotaDto,
} from '../../src/types/api.js';

export const IDS = {
  admin: '11111111-1111-4111-8111-111111111111',
  member: '22222222-2222-4222-8222-222222222222',
  groupA: '33333333-3333-4333-8333-333333333333',
  groupB: '44444444-4444-4444-8444-444444444444',
  key: '55555555-5555-4555-8555-555555555555',
  providerExa: '77777777-7777-4777-8777-777777777777',
  providerGrok: '88888888-8888-4888-8888-888888888888',
  job: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  job2: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
};

const stamp = (day: number, hour = 0) => `2026-03-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`;
const idFor = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

export type BrowserRole = 'admin' | 'user';

export interface CapturedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  headers: Record<string, string>;
}

export interface CapabilityPlan {
  response?: GroupCapabilitiesDto;
  status?: number;
  code?: string;
  message?: string;
  delayMs?: number;
}

export interface BrowserFixtureState {
  role: BrowserRole;
  csrfToken: string;
  rotateCsrfOnSessionRefresh: boolean;
  sessionStatus: number;
  unauthorizedPath?: string;
  unauthorizedUsed: boolean;
  capabilityPlans: Record<string, CapabilityPlan>;
  groups: GroupDto[];
  groupPage2: GroupDto[];
  providers: ProviderDto[];
  providerPage2: ProviderDto[];
  lanes: LaneDto[];
  keys: KeyDto[];
  keyPage2: KeyDto[];
  users: UserDto[];
  audit: AuditEventDto[];
  quotas: UserQuotaDto[];
  usagePages: Record<string, UsageReportDto>;
  usageStatus: number;
  quotaStatus: number;
  usageCallCount: number;
  usageFailureStatuses: number[];
  jobs: Record<string, JobDetailDto>;
  artifacts: Record<string, { chunks: ArtifactChunkDto[]; meta: NonNullable<JobReadResponseDto['artifact']> }>;
  artifactHashMode: 'good' | 'bad';
  artifactSubtleMode: boolean;
  csrfRejectPath?: string;
  csrfRejectUsed: boolean;
  conflictPath?: string;
  conflictUsed: boolean;
  freshGroup?: GroupDto;
  freshProvider?: ProviderDto;
  freshKey?: KeyDto;
}

function group(id: string, name: string, revision = 1, exclusive = false): GroupDto {
  return {
    id,
    name,
    description: `${name} description`,
    status: 'active',
    is_exclusive: exclusive,
    daily_units_per_user: exclusive ? 2_000 : 500,
    revision,
    deleted_at: null,
    created_at: stamp(1, revision),
    updated_at: stamp(1, revision),
  };
}

function provider(id: string, name: string, providerId: ProviderDto['provider_id'], revision = 1): ProviderDto {
  return {
    id,
    name,
    provider_id: providerId,
    status: 'active',
    revision,
    base_url: providerId === 'exa' ? 'https://api.exa.ai' : 'https://api.x.ai',
    credential_configured: true,
    credential_updated_at: stamp(1, 5),
    created_at: stamp(1, 5),
    updated_at: stamp(1, 5),
  };
}

function key(id: string, name: string, revision = 1, groupId = IDS.groupA): KeyDto {
  return {
    id,
    user_id: IDS.admin,
    group_id: groupId,
    name,
    prefix: `nbc_${id.slice(0, 8)}`,
    status: 'active',
    effective_status: 'active',
    quota_units: 100,
    quota_epoch: 1,
    expires_at: null,
    deleted_at: null,
    revision,
    created_at: stamp(2, 8),
    updated_at: stamp(2, 8),
    last_used_at: null,
  };
}

function lane(id: string, providerId: string, operationId: LaneDto['operation_id'], kind: LaneDto['kind']): LaneDto {
  return {
    id,
    kind,
    provider_id: providerId,
    operation_id: operationId,
    status: 'active',
    latency: 'fast',
    cost: 'cheap',
    evidence_groups: ['web'],
    created_at: stamp(1, 6),
    updated_at: stamp(1, 6),
  };
}

function user(id: string, username: string, role: BrowserRole): UserDto {
  return {
    id,
    username,
    display_name: role === 'admin' ? '系统管理员' : '研发成员 Alice',
    role,
    status: 'active',
    restrict_public_groups: false,
    allowed_group_ids: [IDS.groupA],
    created_at: stamp(1),
    updated_at: stamp(1),
  };
}

function usageItem(jobId: string, createdAt: string, keyId = IDS.key): UsageReportDto['items'][number] {
  return {
    job_id: jobId,
    user_id: IDS.admin,
    request_id: `req-${jobId.slice(0, 8)}`,
    kind: 'search',
    delivery: 'sync',
    state: 'succeeded',
    group_id: IDS.groupA,
    key_id: keyId,
    selection: { lane: 'lane-a', query: 'fixture query' },
    reserved_units: 0,
    charged_units: 1,
    released_units: 0,
    settlement_reason: 'completed_succeeded',
    created_at: createdAt,
    completed_at: createdAt,
  };
}

function makeSession(role: BrowserRole, csrfToken: string): SessionDto {
  const currentUser = role === 'admin' ? user(IDS.admin, 'admin', 'admin') : user(IDS.member, 'alice', 'user');
  return {
    tenant: { id: idFor(900), slug: 'default', name: '默认组织' },
    user: currentUser,
    csrf_token: csrfToken,
    expires_at: '2030-01-01T00:00:00.000Z',
  };
}

function defaultCapabilities(groupId: string, revision = 1, laneId = 'lane-a'): GroupCapabilitiesDto {
  return {
    group_id: groupId,
    revision,
    default_search_lane: laneId,
    default_fetch_pipeline: null,
    presets: {},
    lanes: [
      {
        lane_id: laneId,
        kind: 'search',
        units_per_query: 1,
        output: { channel: 'results' },
        configured: true,
        effective_execution_modes: ['sync', 'async'],
      },
    ],
  };
}

function jobDetail(jobId: string, artifact: NonNullable<JobReadResponseDto['artifact']>): JobDetailDto {
  return {
    schema_version: '3.0',
    action: 'get',
    job_id: jobId,
    user_id: IDS.admin,
    kind: 'search',
    state: 'succeeded',
    cancel_requested: false,
    created_at: stamp(7, 8),
    updated_at: stamp(7, 8),
    completed_at: stamp(7, 8),
    content_access: true,
    error: null,
    artifact,
  };
}

export function makeArtifact(text: string, chunkSize = 7) {
  const bytes = Buffer.from(text, 'utf8');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const chunks: ArtifactChunkDto[] = [];
  for (let offset = 0, index = 0; offset < bytes.length; offset += chunkSize, index += 1) {
    const data = bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize));
    chunks.push({ index, offset, byte_length: data.byteLength, data_base64: data.toString('base64') });
  }
  return {
    chunks,
    meta: {
      media_type: 'text/plain',
      byte_length: bytes.byteLength,
      sha256: hash,
      expires_at: '2030-01-01T00:00:00.000Z',
    },
  };
}

export function createFixture(overrides: Partial<BrowserFixtureState> = {}): BrowserFixture {
  const groupA = group(IDS.groupA, 'Group A');
  const groupB = group(IDS.groupB, 'Group B', 1, true);
  const exa = provider(IDS.providerExa, 'Exa Fixture', 'exa');
  const grok = provider(IDS.providerGrok, 'Grok Fixture', 'grok-multi-agent');
  const artifact = makeArtifact('【云端搜索报告】跨越 UTF-8 中文边界的真实 fixture 内容。\n第二行数据。', 7);
  const base: BrowserFixtureState = {
    role: 'admin',
    csrfToken: 'csrf-1',
    rotateCsrfOnSessionRefresh: false,
    sessionStatus: 200,
    unauthorizedUsed: false,
    capabilityPlans: {
      [IDS.groupA]: { response: defaultCapabilities(IDS.groupA, 1, 'lane-a') },
      [IDS.groupB]: { response: defaultCapabilities(IDS.groupB, 1, 'lane-b') },
    },
    groups: [groupA, groupB],
    groupPage2: [],
    providers: [exa, grok],
    providerPage2: [],
    lanes: [lane('lane-a', exa.id, 'search', 'search'), lane('lane-b', grok.id, 'research', 'search')],
    keys: [key(IDS.key, 'Fixture Key')],
    keyPage2: [],
    users: [user(IDS.admin, 'admin', 'admin'), user(IDS.member, 'alice', 'user')],
    audit: [{
      id: idFor(700),
      actor_user_id: IDS.admin,
      action: 'fixture.read',
      target_type: 'fixture',
      target_id: IDS.groupA,
      request_id: 'req-audit',
      created_at: stamp(7, 9),
      metadata: { source: 'browser-fixture' },
    }],
    quotas: [{
      group_id: IDS.groupA,
      daily_units_per_user: 500,
      utc_day: '2026-03-07',
      used_units: 42,
      reserved_units: 1,
      remaining_units: 457,
      reset_at: stamp(8),
      unit: 'execution_unit',
    }],
    usagePages: {
      '': {
        items: [usageItem(IDS.job, stamp(7, 8))],
        totals: { reserved: 0, charged: 1, released: 0 },
        next_cursor: 'usage-cursor-w1',
      },
      'usage-cursor-w1': {
        items: [usageItem(IDS.job2, stamp(6, 8))],
        totals: { reserved: 0, charged: 2, released: 0 },
      },
    },
    usageStatus: 200,
    quotaStatus: 200,
    usageCallCount: 0,
    usageFailureStatuses: [],
    jobs: {},
    artifacts: { [IDS.job]: artifact },
    artifactHashMode: 'good',
    artifactSubtleMode: true,
    csrfRejectUsed: false,
    conflictUsed: false,
  };
  const artifactForJob = artifact.meta;
  base.jobs[IDS.job] = jobDetail(IDS.job, artifactForJob);
  return new BrowserFixture({ ...base, ...overrides });
}

export class BrowserFixture {
  readonly state: BrowserFixtureState;
  readonly requests: CapturedRequest[] = [];

  constructor(state: BrowserFixtureState) {
    this.state = state;
  }

  async install(page: Page): Promise<void> {
    await page.route('**/api/**', async (route) => {
      await this.handle(route);
    });
  }

  requestsFor(path: string, method?: string): CapturedRequest[] {
    return this.requests.filter((item) => item.path === path && (!method || item.method === method));
  }

  private async capture(route: Route): Promise<CapturedRequest> {
    const request = route.request();
    let body: unknown = undefined;
    const postData = request.postData();
    if (postData) {
      try {
        body = JSON.parse(postData);
      } catch {
        body = postData;
      }
    }
    const url = new URL(request.url());
    const captured: CapturedRequest = {
      method: request.method(),
      path: url.pathname,
      query: url.searchParams,
      body,
      headers: await request.allHeaders(),
    };
    this.requests.push(captured);
    return captured;
  }

  private async json(route: Route, data: unknown, status = 200): Promise<void> {
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify({ data, request_id: `fixture-${this.requests.length}` }),
    });
  }

  private async error(route: Route, code: string, message: string, status: number): Promise<void> {
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code, message }, request_id: `fixture-error-${this.requests.length}` }),
    });
  }

  private async handle(route: Route): Promise<void> {
    const captured = await this.capture(route);
    const { path, method, query } = captured;
    const state = this.state;

    if (state.unauthorizedPath === path && !state.unauthorizedUsed) {
      state.unauthorizedUsed = true;
      await this.error(route, 'AUTH_REQUIRED', '会话已过期', 401);
      return;
    }

    if (path === '/api/admin/auth/session' && method === 'GET') {
      if (state.sessionStatus !== 200) {
        await this.error(route, 'AUTH_REQUIRED', '会话不存在', state.sessionStatus);
        return;
      }
      if (state.rotateCsrfOnSessionRefresh && this.requestsFor(path, method).length > 1) {
        state.csrfToken = 'csrf-2';
      }
      await this.json(route, makeSession(state.role, state.csrfToken));
      return;
    }

    if (path === '/api/admin/auth/login' && method === 'POST') {
      state.role = ((captured.body as Record<string, unknown> | undefined)?.['username'] === 'alice' ? 'user' : 'admin');
      state.csrfToken = 'csrf-login';
      await this.json(route, makeSession(state.role, state.csrfToken));
      return;
    }

    if (path === '/api/admin/auth/logout' && method === 'POST') {
      await this.json(route, { logged_out: true });
      return;
    }

    if (path === '/api/admin/groups' && method === 'GET') {
      if (query.get('cursor') === 'group-cursor-2') {
        await this.json(route, { items: state.groupPage2.length ? state.groupPage2 : state.groups.slice(100), next_cursor: null });
      } else {
        const limit = Number(query.get('limit') || 25);
        const page = state.groups.slice(0, limit);
        const hasMore = state.groupPage2.length > 0 || state.groups.length > limit;
        await this.json(route, { items: page, next_cursor: hasMore ? 'group-cursor-2' : null });
      }
      return;
    }

    if (path === '/api/admin/me/available-groups' && method === 'GET') {
      await this.json(route, state.groups.filter((item) => item.status === 'active' && !item.deleted_at));
      return;
    }

    const groupMatch = path.match(/^\/api\/admin\/groups\/([^/]+)$/);
    if (groupMatch && method === 'GET') {
      const found = state.freshGroup?.id === groupMatch[1] ? state.freshGroup : state.groups.find((item) => item.id === groupMatch[1]);
      if (found) await this.json(route, found); else await this.error(route, 'NOT_FOUND', '分组不存在', 404);
      return;
    }

    const capabilityMatch = path.match(/^\/api\/admin\/groups\/([^/]+)\/capabilities$/);
    if (capabilityMatch && method === 'GET') {
      const plan = state.capabilityPlans[capabilityMatch[1]] || { response: defaultCapabilities(capabilityMatch[1]) };
      if (plan.delayMs) await new Promise((resolve) => setTimeout(resolve, plan.delayMs));
      if (plan.status && plan.status !== 200) {
        await this.error(route, plan.code || 'CAPABILITIES_FAILED', plan.message || '通道能力加载失败', plan.status);
      } else {
        await this.json(route, plan.response || defaultCapabilities(capabilityMatch[1]));
      }
      return;
    }

    if (capabilityMatch && method === 'PUT') {
      if (await this.rejectCsrfIfNeeded(route, captured, state)) return;
      if (state.conflictPath === path && !state.conflictUsed) {
        state.conflictUsed = true;
        await this.error(route, 'STALE_VERSION', '资源版本已变化', 409);
        return;
      }
      await this.json(route, state.capabilityPlans[capabilityMatch[1]]?.response || defaultCapabilities(capabilityMatch[1]));
      return;
    }

    if (groupMatch && method === 'PATCH') {
      if (await this.rejectCsrfIfNeeded(route, captured, state)) return;
      if (state.conflictPath === path && !state.conflictUsed) {
        state.conflictUsed = true;
        await this.error(route, 'STALE_VERSION', '资源版本已变化', 409);
        return;
      }
      const current = state.groups.find((item) => item.id === groupMatch[1]) || state.freshGroup;
      if (!current) {
        await this.error(route, 'NOT_FOUND', '分组不存在', 404);
        return;
      }
      const next = { ...current, ...(captured.body as Record<string, unknown>), revision: current.revision + 1 } as GroupDto;
      delete (next as unknown as Record<string, unknown>)['expected_revision'];
      state.groups = state.groups.map((item) => item.id === next.id ? next : item);
      await this.json(route, next);
      return;
    }

    if (groupMatch && method === 'DELETE') {
      if (await this.rejectCsrfIfNeeded(route, captured, state)) return;
      const current = state.groups.find((item) => item.id === groupMatch[1]);
      if (!current) {
        await this.error(route, 'NOT_FOUND', '分组不存在', 404);
        return;
      }
      const deleted = { ...current, status: 'disabled' as const, deleted_at: stamp(8), revision: current.revision + 1 };
      state.groups = state.groups.map((item) => item.id === deleted.id ? deleted : item);
      await this.json(route, deleted);
      return;
    }

    if (path === '/api/admin/providers' && method === 'GET') {
      if (query.get('cursor') === 'provider-cursor-2') {
        await this.json(route, { items: state.providerPage2, next_cursor: null });
      } else {
        await this.json(route, { items: state.providers, next_cursor: state.providerPage2.length ? 'provider-cursor-2' : null });
      }
      return;
    }

    if (path === '/api/admin/providers/catalog' && method === 'GET') {
      const catalog: ProviderCatalogDto = {
        operations: [
          { provider_id: 'exa', operation_id: 'search', kind: 'search' },
          { provider_id: 'exa', operation_id: 'contents', kind: 'fetch' },
          { provider_id: 'grok-multi-agent', operation_id: 'research', kind: 'search' },
        ],
        provider_options: {},
        credential_write_only: true,
      };
      await this.json(route, catalog);
      return;
    }

    const providerMatch = path.match(/^\/api\/admin\/providers\/([^/]+)$/);
    if (providerMatch && method === 'GET') {
      const found = state.freshProvider?.id === providerMatch[1] ? state.freshProvider : state.providers.find((item) => item.id === providerMatch[1]);
      if (found) await this.json(route, found); else await this.error(route, 'NOT_FOUND', '供应商不存在', 404);
      return;
    }

    if (path === '/api/admin/providers' && method === 'POST') {
      const body = captured.body as Record<string, unknown>;
      if (body['provider_id'] === 'grok-multi-agent' && !body['base_url']) {
        await this.error(route, 'VALIDATION_FAILED', 'Grok 必须指定 Base URL', 422);
        return;
      }
      const created = provider(idFor(850), String(body['name'] || 'Created Provider'), body['provider_id'] as ProviderDto['provider_id']);
      state.providers = [created, ...state.providers];
      await this.json(route, created, 201);
      return;
    }

    if (providerMatch && method === 'PATCH') {
      if (await this.rejectCsrfIfNeeded(route, captured, state)) return;
      if (state.conflictPath === path && !state.conflictUsed) {
        state.conflictUsed = true;
        await this.error(route, 'STALE_VERSION', '资源版本已变化', 409);
        return;
      }
      const current = state.providers.find((item) => item.id === providerMatch[1]) || state.freshProvider;
      if (!current) {
        await this.error(route, 'NOT_FOUND', '供应商不存在', 404);
        return;
      }
      const body = captured.body as Record<string, unknown>;
      const next: ProviderDto = {
        ...current,
        name: typeof body['name'] === 'string' ? body['name'] : current.name,
        status: body['status'] === 'disabled' ? 'disabled' : body['status'] === 'active' ? 'active' : current.status,
        base_url: typeof body['base_url'] === 'string' ? body['base_url'] : body['base_url'] === null ? null : current.base_url,
        revision: current.revision + 1,
        credential_configured: body['clear_secret'] === true ? false : body['secret'] ? true : current.credential_configured,
      };
      state.providers = state.providers.map((item) => item.id === next.id ? next : item);
      await this.json(route, next);
      return;
    }

    if (providerMatch && method === 'DELETE') {
      if (await this.rejectCsrfIfNeeded(route, captured, state)) return;
      const current = state.providers.find((item) => item.id === providerMatch[1]);
      if (!current) {
        await this.error(route, 'NOT_FOUND', '供应商不存在', 404);
        return;
      }
      const deleted = { ...current, status: 'disabled' as const, deleted_at: stamp(8), revision: current.revision + 1 };
      state.providers = state.providers.map((item) => item.id === deleted.id ? deleted : item);
      await this.json(route, deleted);
      return;
    }

    if (path === '/api/admin/lanes' && method === 'GET') {
      await this.json(route, { items: state.lanes });
      return;
    }

    if (path === '/api/admin/lanes' && method === 'POST') {
      const body = captured.body as Record<string, unknown>;
      const created = lane(String(body['id']), String(body['provider_id']), body['operation_id'] as LaneDto['operation_id'], 'search');
      state.lanes = [...state.lanes, created];
      await this.json(route, created, 201);
      return;
    }

    const laneMatch = path.match(/^\/api\/admin\/lanes\/([^/]+)$/);
    if (laneMatch && method === 'PATCH') {
      const body = captured.body as Record<string, unknown>;
      state.lanes = state.lanes.map((item) => item.id === laneMatch[1] ? { ...item, status: body['status'] as LaneDto['status'] } : item);
      await this.json(route, state.lanes.find((item) => item.id === laneMatch[1]));
      return;
    }

    if (path === '/api/admin/keys' && method === 'GET') {
      if (query.get('cursor') === 'key-cursor-2') {
        await this.json(route, { items: state.keyPage2, next_cursor: null });
      } else {
        await this.json(route, { items: state.keys, next_cursor: state.keyPage2.length ? 'key-cursor-2' : null });
      }
      return;
    }

    if (path === '/api/admin/keys' && method === 'POST') {
      if (await this.rejectCsrfIfNeeded(route, captured, state)) return;
      const body = captured.body as Record<string, unknown>;
      const created = key(idFor(860 + state.keys.length), String(body['name'] || 'New Key'), 1, String(body['group_id'] || IDS.groupA));
      state.keys = [...state.keys, created];
      await this.json(route, { key: created, access_key: `nbc_secret_${created.id.slice(-6)}` }, 201);
      return;
    }

    const keyMatch = path.match(/^\/api\/admin\/keys\/([^/]+)$/);
    if (keyMatch && method === 'GET') {
      const found = state.freshKey?.id === keyMatch[1] ? state.freshKey : state.keys.find((item) => item.id === keyMatch[1]);
      if (found) await this.json(route, found); else await this.error(route, 'NOT_FOUND', 'Key 不存在', 404);
      return;
    }

    if (keyMatch && method === 'PATCH') {
      if (await this.rejectCsrfIfNeeded(route, captured, state)) return;
      if (state.conflictPath === path && !state.conflictUsed) {
        state.conflictUsed = true;
        await this.error(route, 'STALE_VERSION', '资源版本已变化', 409);
        return;
      }
      const current = state.keys.find((item) => item.id === keyMatch[1]) || state.freshKey;
      if (!current) {
        await this.error(route, 'NOT_FOUND', 'Key 不存在', 404);
        return;
      }
      const body = captured.body as Record<string, unknown>;
      const next: KeyDto = {
        ...current,
        name: typeof body['name'] === 'string' ? body['name'] : current.name,
        group_id: typeof body['group_id'] === 'string' ? body['group_id'] : current.group_id,
        revision: current.revision + 1,
      };
      state.keys = state.keys.map((item) => item.id === next.id ? next : item);
      await this.json(route, next);
      return;
    }

    if (keyMatch && method === 'DELETE') {
      if (await this.rejectCsrfIfNeeded(route, captured, state)) return;
      const current = state.keys.find((item) => item.id === keyMatch[1]);
      if (!current) {
        await this.error(route, 'NOT_FOUND', 'Key 不存在', 404);
        return;
      }
      await this.json(route, { ...current, status: 'disabled' });
      return;
    }

    if (path === '/api/admin/users' && method === 'GET') {
      await this.json(route, { items: state.users, next_cursor: null });
      return;
    }

    const userMatch = path.match(/^\/api\/admin\/users\/([^/]+)(?:\/(allowed-groups|quotas|password))?$/);
    if (userMatch && method === 'GET') {
      const found = state.users.find((item) => item.id === userMatch[1]);
      if (userMatch[2] === 'quotas') {
        await this.json(route, { items: state.quotas });
      } else if (found) {
        await this.json(route, found);
      } else {
        await this.error(route, 'NOT_FOUND', '用户不存在', 404);
      }
      return;
    }

    if (path === '/api/admin/me/quotas' && method === 'GET') {
      if (state.quotaStatus !== 200) {
        await this.error(route, 'UPSTREAM_UNAVAILABLE', '配额服务不可用', state.quotaStatus);
      } else {
        await this.json(route, { items: state.quotas });
      }
      return;
    }

    if (path === '/api/admin/usage' && method === 'GET') {
      state.usageCallCount += 1;
      if (state.usageFailureStatuses.length > 0) {
        const status = state.usageFailureStatuses.shift()!;
        await this.error(route, 'UPSTREAM_UNAVAILABLE', '用量服务不可用', status);
      } else if (state.usageStatus !== 200) {
        await this.error(route, 'UPSTREAM_UNAVAILABLE', '用量服务不可用', state.usageStatus);
      } else {
        await this.json(route, state.usagePages[query.get('cursor') || ''] || state.usagePages['']);
      }
      return;
    }

    if (path === '/api/admin/audit' && method === 'GET') {
      await this.json(route, { items: state.audit, next_cursor: null });
      return;
    }

    const jobMatch = path.match(/^\/api\/admin\/jobs\/([^/]+)(?:\/(read|cancel))?$/);
    if (jobMatch && method === 'GET') {
      const found = state.jobs[jobMatch[1]];
      if (found) await this.json(route, found); else await this.error(route, 'NOT_FOUND', '任务不存在', 404);
      return;
    }

    if (jobMatch && method === 'POST' && jobMatch[2] === 'read') {
      const artifact = state.artifacts[jobMatch[1]];
      if (!artifact) {
        await this.json(route, { schema_version: '3.0', action: 'read', job_id: jobMatch[1], state: 'succeeded', chunks: [] });
        return;
      }
      const cursor = (captured.body as Record<string, unknown> | undefined)?.['cursor'];
      const pageSize = Number((captured.body as Record<string, unknown> | undefined)?.['page_size'] || 50);
      const start = typeof cursor === 'string' && cursor.startsWith('artifact-cursor-')
        ? Number(cursor.slice('artifact-cursor-'.length))
        : 0;
      const shown = artifact.chunks.slice(start, start + pageSize);
      const hash = state.artifactHashMode === 'bad' ? '0'.repeat(64) : artifact.meta.sha256;
      const response: JobReadResponseDto = {
        schema_version: '3.0',
        action: 'read',
        job_id: jobMatch[1],
        state: 'succeeded',
        artifact: { ...artifact.meta, sha256: hash },
        chunks: shown,
        ...(start + pageSize < artifact.chunks.length ? { next_cursor: `artifact-cursor-${start + pageSize}` } : {}),
      };
      await this.json(route, response);
      return;
    }

    if (jobMatch && method === 'POST' && jobMatch[2] === 'cancel') {
      await this.json(route, { schema_version: '3.0', action: 'cancel', job_id: jobMatch[1], state: 'cancelled', cancel_requested: true });
      return;
    }

    await this.error(route, 'NOT_FOUND', `Fixture route not found: ${method} ${path}`, 404);
  }

  private async rejectCsrfIfNeeded(route: Route, captured: CapturedRequest, state: BrowserFixtureState): Promise<boolean> {
    if (state.csrfRejectPath === captured.path && !state.csrfRejectUsed) {
      state.csrfRejectUsed = true;
      await this.error(route, 'CSRF_REJECTED', 'CSRF token rejected', 403);
      return true;
    }
    return false;
  }
}
