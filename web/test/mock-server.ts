import http from 'node:http';
import { createHash } from 'node:crypto';
import type {
  AuditEventDto,
  CancelJobResultDto,
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
} from '../src/types/api.js';

export interface MockFixtureState {
  users: UserDto[];
  groups: GroupDto[];
  keys: KeyDto[];
  providers: ProviderDto[];
  lanes: LaneDto[];
  quotas: UserQuotaDto[];
  usage: UsageReportDto;
  jobs: Record<string, JobDetailDto>;
  jobArtifactChunks: Record<
    string,
    {
      chunks: Array<{ index: number; offset: number; byte_length: number; data_base64: string }>;
      artifactMeta: { media_type: string; byte_length: number; sha256: string; expires_at: string };
    }
  >;
  audit: AuditEventDto[];
  currentSession: SessionDto | null;
  failCapabilitiesForGroup?: string;
  usageError?: boolean;
}

export function createInitialFixture(): MockFixtureState {
  const adminUser: UserDto = {
    id: '11111111-1111-4111-8111-111111111111',
    username: 'admin',
    display_name: '系统管理员',
    role: 'admin',
    status: 'active',
    restrict_public_groups: false,
    allowed_group_ids: [],
    created_at: new Date('2026-03-01T00:00:00Z').toISOString(),
    updated_at: new Date('2026-03-01T00:00:00Z').toISOString(),
  };

  const memberUser: UserDto = {
    id: '22222222-2222-4222-8222-222222222222',
    username: 'alice',
    display_name: '研发成员 Alice',
    role: 'user',
    status: 'active',
    restrict_public_groups: false,
    allowed_group_ids: ['33333333-3333-4333-8333-333333333333'],
    created_at: new Date('2026-03-02T10:00:00Z').toISOString(),
    updated_at: new Date('2026-03-02T10:00:00Z').toISOString(),
  };

  const defaultGroup: GroupDto = {
    id: '33333333-3333-4333-8333-333333333333',
    name: '默认公开组 (Standard)',
    description: '标准网络搜索与抓取分组，开放给全部普通用户使用',
    status: 'active',
    is_exclusive: false,
    daily_units_per_user: 500,
    revision: 1,
    deleted_at: null,
    created_at: new Date('2026-03-01T01:00:00Z').toISOString(),
    updated_at: new Date('2026-03-01T01:00:00Z').toISOString(),
  };

  const exclusiveGroup: GroupDto = {
    id: '44444444-4444-4444-8444-444444444444',
    name: '高级推理专属组 (GMA Exclusive)',
    description: '深度研究与多 Agent 推理专属通道，仅白名单授权成员可用',
    status: 'active',
    is_exclusive: true,
    daily_units_per_user: 2000,
    revision: 2,
    deleted_at: null,
    created_at: new Date('2026-03-01T02:00:00Z').toISOString(),
    updated_at: new Date('2026-03-01T02:00:00Z').toISOString(),
  };

  const key1: KeyDto = {
    id: '55555555-5555-4555-8555-555555555555',
    user_id: adminUser.id,
    group_id: defaultGroup.id,
    name: 'CLI 个人生产密钥',
    prefix: 'nbc_cli_prod',
    status: 'active',
    effective_status: 'active',
    quota_units: 0,
    quota_epoch: 1,
    expires_at: null,
    deleted_at: null,
    revision: 1,
    created_at: new Date('2026-03-02T08:00:00Z').toISOString(),
    updated_at: new Date('2026-03-02T08:00:00Z').toISOString(),
    last_used_at: new Date('2026-03-07T09:30:00Z').toISOString(),
    usage: {
      epoch: 1,
      used_units: 42,
      reserved_units: 0,
      remaining_units: null,
    },
  };

  const key2: KeyDto = {
    id: '66666666-6666-4666-8666-666666666666',
    user_id: memberUser.id,
    group_id: defaultGroup.id,
    name: 'Alice 开发联调测试 Key',
    prefix: 'nbc_dev_alice',
    status: 'active',
    effective_status: 'active',
    quota_units: 100,
    quota_epoch: 1,
    expires_at: new Date('2026-12-31T23:59:59Z').toISOString(),
    deleted_at: null,
    revision: 1,
    created_at: new Date('2026-03-03T09:00:00Z').toISOString(),
    updated_at: new Date('2026-03-03T09:00:00Z').toISOString(),
    last_used_at: new Date('2026-03-06T14:12:00Z').toISOString(),
    usage: {
      epoch: 1,
      used_units: 18,
      reserved_units: 1,
      remaining_units: 81,
    },
  };

  const exaProvider: ProviderDto = {
    id: '77777777-7777-4777-8777-777777777777',
    name: 'Exa 官方神经搜索引擎',
    provider_id: 'exa',
    status: 'active',
    revision: 1,
    base_url: 'https://api.exa.ai',
    credential_configured: true,
    credential_updated_at: new Date('2026-03-01T05:00:00Z').toISOString(),
  };

  const grokProvider: ProviderDto = {
    id: '88888888-8888-4888-8888-888888888888',
    name: 'Grok 推理研究引擎',
    provider_id: 'grok-multi-agent',
    status: 'active',
    revision: 1,
    base_url: 'https://api.x.ai',
    credential_configured: true,
    credential_updated_at: new Date('2026-03-02T06:00:00Z').toISOString(),
  };

  const lane1: LaneDto = {
    id: 'exa-fast-search',
    kind: 'search',
    provider_id: exaProvider.id,
    operation_id: 'search',
    status: 'active',
    latency: 'fast',
    cost: 'cheap',
    evidence_groups: ['web', 'news'],
  };

  const lane2: LaneDto = {
    id: 'exa-contents-fetch',
    kind: 'fetch',
    provider_id: exaProvider.id,
    operation_id: 'contents',
    status: 'active',
    latency: 'medium',
    cost: 'cheap',
    evidence_groups: ['html', 'markdown'],
  };

  const lane3: LaneDto = {
    id: 'grok-deep-research',
    kind: 'search',
    provider_id: grokProvider.id,
    operation_id: 'research',
    status: 'active',
    latency: 'slow',
    cost: 'expensive',
    evidence_groups: ['reasoning', 'synthesis'],
  };

  const quotas: UserQuotaDto[] = [
    {
      group_id: defaultGroup.id,
      daily_units_per_user: 500,
      utc_day: '2026-03-07',
      used_units: 42,
      reserved_units: 1,
      remaining_units: 457,
      reset_at: new Date('2026-03-08T00:00:00Z').toISOString(),
      unit: 'execution_unit',
    },
    {
      group_id: exclusiveGroup.id,
      daily_units_per_user: 2000,
      utc_day: '2026-03-07',
      used_units: 0,
      reserved_units: 0,
      remaining_units: 2000,
      reset_at: new Date('2026-03-08T00:00:00Z').toISOString(),
      unit: 'execution_unit',
    },
  ];

  const usageItems = [
    {
      job_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      user_id: adminUser.id,
      request_id: 'req_search_01',
      kind: 'search' as const,
      delivery: 'sync' as const,
      state: 'succeeded' as const,
      group_id: defaultGroup.id,
      key_id: key1.id,
      selection: { lane: 'exa-fast-search', query: 'TypeScript Cloud architecture' },
      reserved_units: 0,
      charged_units: 1,
      released_units: 0,
      settlement_reason: 'completed_succeeded',
      created_at: new Date('2026-03-07T08:10:00Z').toISOString(),
      completed_at: new Date('2026-03-07T08:10:01Z').toISOString(),
    },
    {
      job_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      user_id: memberUser.id,
      request_id: 'req_search_02',
      kind: 'search' as const,
      delivery: 'async' as const,
      state: 'failed' as const,
      group_id: defaultGroup.id,
      key_id: key2.id,
      selection: { lane: 'grok-deep-research', query: 'Quantum error bounds' },
      reserved_units: 0,
      charged_units: 5,
      released_units: 0,
      settlement_reason: 'post_dispatch_provider_error',
      created_at: new Date('2026-03-07T09:00:00Z').toISOString(),
      completed_at: new Date('2026-03-07T09:00:25Z').toISOString(),
    },
  ];

  // UI-02: Job Detail matching real backend jobView
  const jobs: Record<string, JobDetailDto> = {
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa': {
      schema_version: '3.0',
      action: 'get',
      job_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      state: 'succeeded',
      cancel_requested: false,
      created_at: new Date('2026-03-07T08:10:00Z').toISOString(),
      completed_at: new Date('2026-03-07T08:10:01Z').toISOString(),
      content_access: true,
      artifact: {
        media_type: 'application/json',
        byte_length: 0, // will be updated below
        sha256: '',
        expires_at: new Date('2026-04-01T00:00:00Z').toISOString(),
      },
    },
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb': {
      schema_version: '3.0',
      action: 'get',
      job_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      state: 'failed',
      cancel_requested: false,
      created_at: new Date('2026-03-07T09:00:00Z').toISOString(),
      completed_at: new Date('2026-03-07T09:00:25Z').toISOString(),
      content_access: true,
      error: {
        code: 'PROVIDER_TIMEOUT',
        message: '上游 Grok 推理执行超时 (post-dispatch 阶段，消耗已记账)',
      },
    },
  };

  // UI-02: Prepare a real multi-chunk, multi-byte UTF-8 test fixture where a 3-byte Chinese character spans across chunk boundary
  // "测试数据：跨越分块边界的中文 UTF-8 内容"
  // Let's create an exact binary buffer
  const sampleText = '【云端搜索报告】测试数据：跨越分块边界的中文 UTF-8 内容，包含多行和结构化文本。\n第二行数据。';
  const fullBytes = Buffer.from(sampleText, 'utf-8');
  const sha256 = createHash('sha256').update(fullBytes).digest('hex');

  // Split at index 14 (which might split a multi-byte char or cleanly split)
  const part1 = fullBytes.subarray(0, 14);
  const part2 = fullBytes.subarray(14);

  const jobArtifactChunks: MockFixtureState['jobArtifactChunks'] = {
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa': {
      chunks: [
        {
          index: 0,
          offset: 0,
          byte_length: part1.length,
          data_base64: part1.toString('base64'),
        },
        {
          index: 1,
          offset: part1.length,
          byte_length: part2.length,
          data_base64: part2.toString('base64'),
        },
      ],
      artifactMeta: {
        media_type: 'application/json',
        byte_length: fullBytes.length,
        sha256,
        expires_at: new Date('2026-04-01T00:00:00Z').toISOString(),
      },
    },
  };

  jobs['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']!.artifact = jobArtifactChunks['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']!.artifactMeta;

  const audit: AuditEventDto[] = [
    {
      id: '99999999-9999-4999-8999-999999999999',
      actor_user_id: null,
      action: 'tenant.bootstrap',
      target_type: 'tenant',
      target_id: 'default',
      request_id: 'bootstrap_cli_01',
      created_at: new Date('2026-03-01T00:00:00Z').toISOString(),
      metadata: { admin_username: 'admin', initial: true },
    },
    {
      id: 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa',
      actor_user_id: adminUser.id,
      action: 'provider.create',
      target_type: 'provider',
      target_id: exaProvider.id,
      request_id: 'req_prov_01',
      created_at: new Date('2026-03-01T05:00:00Z').toISOString(),
      metadata: { name: exaProvider.name, provider_id: 'exa' },
    },
    {
      id: 'bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb',
      actor_user_id: adminUser.id,
      action: 'group.create',
      target_type: 'group',
      target_id: defaultGroup.id,
      request_id: 'req_grp_01',
      created_at: new Date('2026-03-01T01:00:00Z').toISOString(),
      metadata: { is_exclusive: false },
    },
  ];

  return {
    users: [adminUser, memberUser],
    groups: [defaultGroup, exclusiveGroup],
    keys: [key1, key2],
    providers: [exaProvider, grokProvider],
    lanes: [lane1, lane2, lane3],
    quotas,
    usage: {
      items: usageItems,
      totals: {
        reserved: 1,
        charged: 6,
        released: 0,
      },
    },
    jobs,
    jobArtifactChunks,
    audit,
    currentSession: {
      tenant: { id: '00000000-0000-4000-8000-000000000000', slug: 'default', name: '默认组织' },
      user: adminUser,
      csrf_token: 'mock-in-memory-csrf-token-32bytes-hex-safe',
      expires_at: new Date(Date.now() + 8 * 3600 * 1000).toISOString(),
    },
  };
}

export function startMockServer(port = 3000): { server: http.Server; state: MockFixtureState } {
  const state = createInitialFixture();

  const server = http.createServer((req, res) => {
    // Set standard secure response headers
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || 'http://localhost:5173');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });

    req.on('end', () => {
      let parsedBody: Record<string, unknown> = {};
      const isMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method || '');

      if (body) {
        try {
          parsedBody = JSON.parse(body);
        } catch {
          res.writeHead(400);
          res.end(JSON.stringify({ error: { code: 'INVALID_JSON', message: 'Malformed JSON' }, request_id: 'req_mock' }));
          return;
        }
      }

      const send = (data: unknown, statusCode = 200) => {
        res.writeHead(statusCode);
        res.end(JSON.stringify({ data, request_id: 'mock_req_' + Math.random().toString(36).slice(2, 8) }));
      };

      const sendErr = (code: string, message: string, statusCode = 400) => {
        res.writeHead(statusCode);
        res.end(JSON.stringify({ error: { code, message }, request_id: 'mock_req_err' }));
      };

      // UI-04: Strict CSRF verification for mutation routes
      if (isMutation && pathname !== '/api/admin/auth/login') {
        const csrfHeader = req.headers['x-csrf-token'];
        if (state.currentSession && csrfHeader !== state.currentSession.csrf_token) {
          sendErr('CSRF_REJECTED', 'CSRF validation failed.', 403);
          return;
        }
      }

      // Check session requirement
      if (pathname !== '/api/admin/auth/login' && pathname !== '/api/admin/auth/session') {
        if (!state.currentSession) {
          sendErr('AUTH_REQUIRED', 'Authentication required.', 401);
          return;
        }
      }

      // Mock Routes
      if (pathname === '/api/admin/auth/session') {
        if (!state.currentSession) {
          sendErr('AUTH_REQUIRED', '会话不存在', 401);
          return;
        }
        // UI-04: Rotate CSRF token on session refresh
        state.currentSession.csrf_token = 'rotated-csrf-' + Math.random().toString(36).slice(2);
        send(state.currentSession);
        return;
      }

      if (pathname === '/api/admin/auth/login' && req.method === 'POST') {
        const { username, password } = parsedBody as { username?: string; password?: string };
        const found = state.users.find((u) => u.username === username);
        if (found && password) {
          state.currentSession = {
            tenant: { id: '00000000-0000-4000-8000-000000000000', slug: 'default', name: '默认组织' },
            user: found,
            csrf_token: 'mock-csrf-' + Math.random().toString(36).slice(2),
            expires_at: new Date(Date.now() + 8 * 3600 * 1000).toISOString(),
          };
          res.setHeader('Set-Cookie', '__Host-nbcloud_session=mock-token; Path=/; HttpOnly; SameSite=Strict');
          send(state.currentSession);
        } else {
          sendErr('AUTH_REQUIRED', '租户、用户名或密码不正确', 401);
        }
        return;
      }

      if (pathname === '/api/admin/auth/logout' && req.method === 'POST') {
        state.currentSession = null;
        send({ logged_out: true });
        return;
      }

      // Keys routes
      if (pathname === '/api/admin/keys' && req.method === 'GET') {
        const limit = Number(url.searchParams.get('limit')) || 25;
        const cursor = url.searchParams.get('cursor');
        let startIndex = 0;
        if (cursor) {
          const found = state.keys.findIndex((k) => k.id === cursor);
          if (found >= 0) startIndex = found + 1;
        }
        const slice = state.keys.slice(startIndex, startIndex + limit);
        const hasMore = startIndex + limit < state.keys.length;
        send({ items: slice, next_cursor: hasMore && slice.at(-1) ? slice.at(-1)!.id : null });
        return;
      }

      if (pathname.startsWith('/api/admin/keys/') && req.method === 'GET') {
        const id = pathname.split('/')[4];
        const key = state.keys.find((k) => k.id === id);
        if (!key) {
          sendErr('NOT_FOUND', 'Key not found', 404);
          return;
        }
        send(key);
        return;
      }

      if (pathname === '/api/admin/keys' && req.method === 'POST') {
        const { name, group_id, quota_units, expires_at } = parsedBody as any;
        const newKey: KeyDto = {
          id: 'mock-key-' + Date.now(),
          user_id: state.currentSession?.user.id || '11111111-1111-4111-8111-111111111111',
          group_id,
          name,
          prefix: 'nbc_mock_' + Math.random().toString(36).slice(2, 6),
          status: 'active',
          quota_units: quota_units || 0,
          quota_epoch: 1,
          expires_at: expires_at || null,
          deleted_at: null,
          revision: 1,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          last_used_at: null,
        };
        state.keys.unshift(newKey);
        send({ key: newKey, access_key: 'nbc_live_' + Buffer.from(Math.random().toString(36)).toString('base64url') }, 201);
        return;
      }

      if (pathname.startsWith('/api/admin/keys/') && req.method === 'PATCH') {
        const id = pathname.split('/')[4];
        const key = state.keys.find((k) => k.id === id);
        if (!key) {
          sendErr('NOT_FOUND', 'Key not found', 404);
          return;
        }
        const { expected_revision, name, status, quota_units, expires_at } = parsedBody as any;
        if (key.revision !== expected_revision) {
          sendErr('STALE_VERSION', 'Resource was modified; reload and retry.', 409);
          return;
        }
        if (name) key.name = name;
        if (status) key.status = status;
        if (quota_units !== undefined) key.quota_units = quota_units;
        if (expires_at !== undefined) key.expires_at = expires_at;
        key.revision += 1;
        key.updated_at = new Date().toISOString();
        send(key);
        return;
      }

      // UI-03: Keys delete requires strict {} and returns KeyDto
      if (pathname.startsWith('/api/admin/keys/') && req.method === 'DELETE') {
        const id = pathname.split('/')[4];
        const key = state.keys.find((k) => k.id === id);
        if (!key) {
          sendErr('NOT_FOUND', 'Key not found', 404);
          return;
        }
        key.status = 'disabled';
        key.deleted_at = new Date().toISOString();
        key.revision += 1;
        send(key);
        return;
      }

      if (pathname.startsWith('/api/admin/keys/') && pathname.endsWith('/reset-quota') && req.method === 'POST') {
        const id = pathname.split('/')[4];
        const key = state.keys.find((k) => k.id === id);
        if (!key) {
          sendErr('NOT_FOUND', 'Key not found', 404);
          return;
        }
        const { expected_revision } = parsedBody as any;
        if (key.revision !== expected_revision) {
          sendErr('STALE_VERSION', 'Resource was modified; reload and retry.', 409);
          return;
        }
        key.quota_epoch = (key.quota_epoch || 1) + 1;
        key.revision += 1;
        send({ id, reset: true, revision: key.revision, usage: { used_units: 0, reserved_units: 0 } });
        return;
      }

      // Groups routes
      if (pathname === '/api/admin/groups' && req.method === 'GET') {
        const limit = Number(url.searchParams.get('limit')) || 25;
        const cursor = url.searchParams.get('cursor');
        let startIndex = 0;
        if (cursor) {
          const found = state.groups.findIndex((g) => g.id === cursor);
          if (found >= 0) startIndex = found + 1;
        }
        const slice = state.groups.slice(startIndex, startIndex + limit);
        const hasMore = startIndex + limit < state.groups.length;
        send({ items: slice, next_cursor: hasMore && slice.at(-1) ? slice.at(-1)!.id : null });
        return;
      }

      if (pathname.startsWith('/api/admin/groups/') && req.method === 'GET' && !pathname.endsWith('/capabilities')) {
        const id = pathname.split('/')[4];
        const group = state.groups.find((g) => g.id === id);
        if (!group) {
          sendErr('NOT_FOUND', 'Group not found', 404);
          return;
        }
        send(group);
        return;
      }

      if (pathname === '/api/admin/me/available-groups') {
        send(state.groups.filter((g) => g.status === 'active' && !g.deleted_at));
        return;
      }

      if (pathname === '/api/admin/groups' && req.method === 'POST') {
        const { name, description, is_exclusive, daily_units_per_user } = parsedBody as any;
        const newGroup: GroupDto = {
          id: 'mock-grp-' + Date.now(),
          name,
          description: description || '',
          status: 'active',
          is_exclusive: Boolean(is_exclusive),
          daily_units_per_user: daily_units_per_user || 0,
          revision: 1,
          deleted_at: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        state.groups.unshift(newGroup);
        send(newGroup, 201);
        return;
      }

      if (pathname.startsWith('/api/admin/groups/') && req.method === 'PATCH') {
        const id = pathname.split('/')[4];
        const grp = state.groups.find((g) => g.id === id);
        if (!grp) {
          sendErr('NOT_FOUND', 'Group not found', 404);
          return;
        }
        const { expected_revision, name, description, status, is_exclusive, daily_units_per_user } = parsedBody as any;
        if (grp.revision !== expected_revision) {
          sendErr('STALE_VERSION', 'Resource was modified; reload and retry.', 409);
          return;
        }
        if (name) grp.name = name;
        if (description !== undefined) grp.description = description;
        if (status) grp.status = status;
        if (is_exclusive !== undefined) grp.is_exclusive = is_exclusive;
        if (daily_units_per_user !== undefined) grp.daily_units_per_user = daily_units_per_user;
        grp.revision += 1;
        grp.updated_at = new Date().toISOString();
        send(grp);
        return;
      }

      // UI-03: Groups delete requires JSON {} and returns GroupDto
      if (pathname.startsWith('/api/admin/groups/') && req.method === 'DELETE') {
        const id = pathname.split('/')[4];
        const grp = state.groups.find((g) => g.id === id);
        if (!grp) {
          sendErr('NOT_FOUND', 'Group not found', 404);
          return;
        }
        grp.status = 'disabled';
        grp.deleted_at = new Date().toISOString();
        grp.revision += 1;
        send(grp);
        return;
      }

      // UI-01: Groups capabilities GET/PUT
      if (pathname.startsWith('/api/admin/groups/') && pathname.endsWith('/capabilities')) {
        const id = pathname.split('/')[4];
        if (state.failCapabilitiesForGroup === id) {
          sendErr('INTERNAL', 'Failed to retrieve group capabilities from backend database.', 500);
          return;
        }

        const group = state.groups.find((g) => g.id === id);
        if (!group) {
          sendErr('NOT_FOUND', 'Group not found', 404);
          return;
        }

        if (req.method === 'GET') {
          const cap: GroupCapabilitiesDto = {
            group_id: id,
            revision: group.revision,
            default_search_lane: 'exa-fast-search',
            default_fetch_pipeline: 'exa-contents-fetch',
            presets: {},
            lanes: [
              {
                lane_id: 'exa-fast-search',
                kind: 'search',
                units_per_query: 1,
                output: { channel: 'results' },
                configured: true,
                effective_execution_modes: ['sync', 'async'],
              },
            ],
          };
          send(cap);
          return;
        }

        if (req.method === 'PUT') {
          const { expected_revision, lanes, default_search_lane, default_fetch_pipeline, presets } = parsedBody as any;
          if (group.revision !== expected_revision) {
            sendErr('STALE_VERSION', 'Resource was modified; reload and retry.', 409);
            return;
          }
          group.revision += 1;
          const updatedCap: GroupCapabilitiesDto = {
            group_id: id,
            revision: group.revision,
            default_search_lane: default_search_lane ?? null,
            default_fetch_pipeline: default_fetch_pipeline ?? null,
            presets: presets ?? {},
            lanes: (lanes || []).map((l: any) => ({
              lane_id: l.lane_id,
              kind: 'search',
              units_per_query: l.units_per_query,
              output: { channel: 'results' },
              configured: true,
              effective_execution_modes: ['sync'],
            })),
          };
          send(updatedCap);
          return;
        }
      }

      // Users routes
      if (pathname === '/api/admin/users' && req.method === 'GET') {
        const limit = Number(url.searchParams.get('limit')) || 25;
        const cursor = url.searchParams.get('cursor');
        let startIndex = 0;
        if (cursor) {
          const found = state.users.findIndex((u) => u.id === cursor);
          if (found >= 0) startIndex = found + 1;
        }
        const slice = state.users.slice(startIndex, startIndex + limit);
        const hasMore = startIndex + limit < state.users.length;
        send({ items: slice, next_cursor: hasMore && slice.at(-1) ? slice.at(-1)!.id : null });
        return;
      }

      if (pathname.startsWith('/api/admin/users/') && req.method === 'GET' && !pathname.endsWith('/allowed-groups') && !pathname.endsWith('/password')) {
        const id = pathname.split('/')[4];
        const user = state.users.find((u) => u.id === id);
        if (!user) {
          sendErr('NOT_FOUND', 'User not found', 404);
          return;
        }
        send(user);
        return;
      }

      if (pathname === '/api/admin/users' && req.method === 'POST') {
        const { username, display_name, role, restrict_public_groups, allowed_group_ids } = parsedBody as any;
        const newUser: UserDto = {
          id: 'mock-user-' + Date.now(),
          username,
          display_name,
          role: role || 'user',
          status: 'active',
          restrict_public_groups: Boolean(restrict_public_groups),
          allowed_group_ids: allowed_group_ids || [],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        state.users.unshift(newUser);
        send(newUser, 201);
        return;
      }

      if (pathname.startsWith('/api/admin/users/') && req.method === 'PATCH') {
        const id = pathname.split('/')[4];
        const user = state.users.find((u) => u.id === id);
        if (!user) {
          sendErr('NOT_FOUND', 'User not found', 404);
          return;
        }
        const { display_name, role, status, restrict_public_groups } = parsedBody as any;
        if (display_name) user.display_name = display_name;
        if (role) user.role = role;
        if (status) user.status = status;
        if (restrict_public_groups !== undefined) user.restrict_public_groups = restrict_public_groups;
        user.updated_at = new Date().toISOString();
        send(user);
        return;
      }

      if (pathname.startsWith('/api/admin/users/') && pathname.endsWith('/allowed-groups') && req.method === 'PUT') {
        const id = pathname.split('/')[4];
        const user = state.users.find((u) => u.id === id);
        if (!user) {
          sendErr('NOT_FOUND', 'User not found', 404);
          return;
        }
        const { group_ids } = parsedBody as { group_ids: string[] };
        user.allowed_group_ids = group_ids || [];
        send(user);
        return;
      }

      if (pathname.startsWith('/api/admin/users/') && pathname.endsWith('/password') && req.method === 'POST') {
        send({ sessions_revoked: true });
        return;
      }

      // Providers catalog & CRUD
      if (pathname === '/api/admin/providers/catalog') {
        const cat: ProviderCatalogDto = {
          operations: [
            { provider_id: 'exa', operation_id: 'search', kind: 'search' },
            { provider_id: 'exa', operation_id: 'contents', kind: 'fetch' },
            { provider_id: 'grok-multi-agent', operation_id: 'research', kind: 'search' },
          ],
          provider_options: {
            exa: {},
            'grok-multi-agent': { model: 'string', reasoning_effort: ['low', 'medium', 'high'] },
          },
          credential_write_only: true,
        };
        send(cat);
        return;
      }

      if (pathname === '/api/admin/providers' && req.method === 'GET') {
        const limit = Number(url.searchParams.get('limit')) || 25;
        const cursor = url.searchParams.get('cursor');
        let startIndex = 0;
        if (cursor) {
          const found = state.providers.findIndex((p) => p.id === cursor);
          if (found >= 0) startIndex = found + 1;
        }
        const slice = state.providers.slice(startIndex, startIndex + limit);
        const hasMore = startIndex + limit < state.providers.length;
        send({ items: slice, next_cursor: hasMore && slice.at(-1) ? slice.at(-1)!.id : null });
        return;
      }

      if (pathname.startsWith('/api/admin/providers/') && req.method === 'GET') {
        const id = pathname.split('/')[4];
        const prov = state.providers.find((p) => p.id === id);
        if (!prov) {
          sendErr('NOT_FOUND', 'Provider not found', 404);
          return;
        }
        send(prov);
        return;
      }

      // UI-09: Provider creation rules (Grok requires base_url)
      if (pathname === '/api/admin/providers' && req.method === 'POST') {
        const { name, provider_id, base_url, options, secret } = parsedBody as any;
        if (provider_id === 'grok-multi-agent' && !base_url) {
          sendErr('VALIDATION_FAILED', 'Grok provider requires base_url', 422);
          return;
        }
        const newProv: ProviderDto = {
          id: 'mock-prov-' + Date.now(),
          name,
          provider_id,
          status: 'active',
          revision: 1,
          base_url: base_url || (provider_id === 'exa' ? 'https://api.exa.ai' : null),
          options,
          credential_configured: Boolean(secret),
          credential_updated_at: secret ? new Date().toISOString() : null,
        };
        state.providers.unshift(newProv);
        send(newProv, 201);
        return;
      }

      if (pathname.startsWith('/api/admin/providers/') && req.method === 'PATCH') {
        const id = pathname.split('/')[4];
        const prov = state.providers.find((p) => p.id === id);
        if (!prov) {
          sendErr('NOT_FOUND', 'Provider not found', 404);
          return;
        }
        const { expected_revision, name, status, base_url, secret, clear_secret } = parsedBody as any;
        if (prov.revision !== expected_revision) {
          sendErr('STALE_VERSION', 'Resource was modified; reload and retry.', 409);
          return;
        }
        if (name) prov.name = name;
        if (status) prov.status = status;
        if (base_url !== undefined) prov.base_url = base_url;
        if (clear_secret) {
          prov.credential_configured = false;
          prov.credential_updated_at = null;
        } else if (secret) {
          prov.credential_configured = true;
          prov.credential_updated_at = new Date().toISOString();
        }
        prov.revision += 1;
        send(prov);
        return;
      }

      // UI-03: Provider delete requires JSON {} and returns actual ProviderDto
      if (pathname.startsWith('/api/admin/providers/') && req.method === 'DELETE') {
        const id = pathname.split('/')[4];
        const prov = state.providers.find((p) => p.id === id);
        if (!prov) {
          sendErr('NOT_FOUND', 'Provider not found', 404);
          return;
        }
        prov.status = 'disabled';
        prov.deleted_at = new Date().toISOString();
        prov.revision += 1;
        send(prov);
        return;
      }

      if (pathname === '/api/admin/lanes' && req.method === 'GET') {
        send({ items: state.lanes });
        return;
      }

      if (pathname === '/api/admin/lanes' && req.method === 'POST') {
        const { id, provider_id, operation_id, latency, cost } = parsedBody as any;
        const newLane: LaneDto = {
          id,
          kind: operation_id === 'contents' ? 'fetch' : 'search',
          provider_id,
          operation_id,
          status: 'active',
          latency,
          cost,
          evidence_groups: [],
        };
        state.lanes.unshift(newLane);
        send(newLane, 201);
        return;
      }

      if (pathname.startsWith('/api/admin/lanes/') && req.method === 'PATCH') {
        const id = pathname.split('/')[4];
        const lane = state.lanes.find((l) => l.id === id);
        if (!lane) {
          sendErr('NOT_FOUND', 'Lane not found', 404);
          return;
        }
        const { status } = parsedBody as any;
        if (status) lane.status = status;
        send(lane);
        return;
      }

      // Quotas and usage
      if (pathname === '/api/admin/me/quotas') {
        if (state.usageError) {
          sendErr('INTERNAL', 'Database connection refused.', 500);
          return;
        }
        send({ items: state.quotas });
        return;
      }

      if (pathname === '/api/admin/usage') {
        if (state.usageError) {
          sendErr('INTERNAL', 'Database connection refused.', 500);
          return;
        }
        const limit = Number(url.searchParams.get('limit')) || 25;
        const cursor = url.searchParams.get('cursor');
        let startIndex = 0;
        if (cursor) {
          const found = state.usage.items.findIndex((it) => it.job_id === cursor);
          if (found >= 0) startIndex = found + 1;
        }
        const slice = state.usage.items.slice(startIndex, startIndex + limit);
        const hasMore = startIndex + limit < state.usage.items.length;
        send({
          items: slice,
          totals: state.usage.totals,
          next_cursor: hasMore && slice.at(-1) ? slice.at(-1)!.job_id : null,
        });
        return;
      }

      // UI-02: Jobs detail, cancel and multi-chunk UTF-8 read
      if (pathname.startsWith('/api/admin/jobs/') && !pathname.endsWith('/cancel') && !pathname.endsWith('/read')) {
        const id = pathname.split('/')[4];
        const job = state.jobs[id];
        if (!job) {
          sendErr('NOT_FOUND', 'Job not found', 404);
          return;
        }
        send({ ...job, content_access: true });
        return;
      }

      if (pathname.startsWith('/api/admin/jobs/') && pathname.endsWith('/cancel')) {
        const id = pathname.split('/')[4];
        const job = state.jobs[id];
        if (!job) {
          sendErr('NOT_FOUND', 'Job not found', 404);
          return;
        }
        job.state = 'cancelled';
        job.cancel_requested = true;
        const cancelResult: CancelJobResultDto = {
          schema_version: '3.0',
          action: 'cancel',
          job_id: id,
          state: 'cancelled',
          cancel_requested: true,
        };
        send(cancelResult);
        return;
      }

      if (pathname.startsWith('/api/admin/jobs/') && pathname.endsWith('/read')) {
        const id = pathname.split('/')[4];
        const data = state.jobArtifactChunks[id];
        if (!data) {
          sendErr('NOT_FOUND', 'Artifact not found', 404);
          return;
        }

        const pageSize = (parsedBody.page_size as number) || 1;
        const cursor = parsedBody.cursor as string | undefined;
        let startIndex = 0;
        if (cursor) {
          startIndex = Number(cursor);
        }

        const chunksSlice = data.chunks.slice(startIndex, startIndex + pageSize);
        const nextIndex = startIndex + pageSize;
        const hasMore = nextIndex < data.chunks.length;

        const readResponse: JobReadResponseDto = {
          schema_version: '3.0',
          action: 'read',
          job_id: id,
          state: 'succeeded',
          artifact: data.artifactMeta,
          chunks: chunksSlice,
          next_cursor: hasMore ? String(nextIndex) : undefined,
        };
        send(readResponse);
        return;
      }

      if (pathname === '/api/admin/audit') {
        const limit = Number(url.searchParams.get('limit')) || 25;
        const cursor = url.searchParams.get('cursor');
        let startIndex = 0;
        if (cursor) {
          const found = state.audit.findIndex((a) => a.id === cursor);
          if (found >= 0) startIndex = found + 1;
        }
        const slice = state.audit.slice(startIndex, startIndex + limit);
        const hasMore = startIndex + limit < state.audit.length;
        send({ items: slice, next_cursor: hasMore && slice.at(-1) ? slice.at(-1)!.id : null });
        return;
      }

      sendErr('NOT_FOUND', `Mock route not handled: ${pathname}`, 404);
    });
  });

  server.listen(port);
  return { server, state };
}
