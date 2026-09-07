import type {
  ApiEnvelope,
  ApiErrorEnvelope,
  AuditEventDto,
  CancelJobResultDto,
  GroupCapabilitiesDto,
  GroupDto,
  JobDetailDto,
  JobReadResponseDto,
  KeyDto,
  KeyIssueResult,
  LaneDto,
  ProviderCatalogDto,
  ProviderDto,
  SessionDto,
  UsageReportDto,
  UserDto,
  UserQuotaDto,
} from '../types/api.js';
import { authNotifier } from './auth-events.js';

export class ApiClientError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly fields?: Array<{ path: string; code: string }>;
  readonly retryAfterMs?: number;
  readonly requestId?: string;

  constructor(code: string, statusCode: number, message: string, options?: { fields?: Array<{ path: string; code: string }>; retryAfterMs?: number; requestId?: string }) {
    super(message);
    this.name = 'ApiClientError';
    this.code = code;
    this.statusCode = statusCode;
    this.fields = options?.fields;
    this.retryAfterMs = options?.retryAfterMs;
    this.requestId = options?.requestId;
  }
}

class MemorySessionStore {
  private csrfToken: string | null = null;

  getCsrf(): string | null {
    return this.csrfToken;
  }

  setCsrf(token: string | null): void {
    this.csrfToken = token;
  }

  clear(): void {
    this.csrfToken = null;
  }
}

export const sessionMemory = new MemorySessionStore();

interface RequestOptions extends RequestInit {
  requireCsrf?: boolean;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(options.headers as Record<string, string> | undefined),
  };

  if (options.body && typeof options.body === 'string' && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  // Strictly attach in-memory CSRF token for unsafe mutation requests
  const method = (options.method || 'GET').toUpperCase();
  const isMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
  if (isMutation || options.requireCsrf) {
    const csrf = sessionMemory.getCsrf();
    if (csrf) {
      headers['X-CSRF-Token'] = csrf;
    }
  }

  const response = await fetch(path, {
    ...options,
    headers,
    credentials: 'include', // Standard secure cookie credentials, never Bearer
  });

  const text = await response.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiClientError('INVALID_RESPONSE', response.status, `非预期响应格式 (${response.status})`);
  }

  if (!response.ok) {
    const err = json as ApiErrorEnvelope | null;
    const code = err?.error?.code || `HTTP_${response.status}`;
    const message = err?.error?.message || `请求失败 (${response.status})`;

    // UI-04: Session expiry 401 handling
    if (response.status === 401 || code === 'AUTH_REQUIRED') {
      sessionMemory.clear();
      authNotifier.emitUnauthorized();
    }

    throw new ApiClientError(code, response.status, message, {
      fields: err?.error?.fields,
      retryAfterMs: err?.error?.retry_after_ms,
      requestId: err?.request_id,
    });
  }

  const envelope = json as ApiEnvelope<T>;
  return envelope.data;
}

export const api = {
  auth: {
    login: async (tenant: string, username: string, password: string): Promise<SessionDto> => {
      const session = await request<SessionDto>('/api/admin/auth/login', {
        method: 'POST',
        body: JSON.stringify({ tenant, username, password }),
      });
      sessionMemory.setCsrf(session.csrf_token);
      return session;
    },
    session: async (): Promise<SessionDto> => {
      const session = await request<SessionDto>('/api/admin/auth/session', {
        method: 'GET',
      });
      sessionMemory.setCsrf(session.csrf_token);
      return session;
    },
    logout: async (): Promise<{ logged_out: boolean }> => {
      try {
        const res = await request<{ logged_out: boolean }>('/api/admin/auth/logout', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        return res;
      } finally {
        sessionMemory.clear();
      }
    },
  },

  users: {
    list: async (params?: { limit?: number; cursor?: string }): Promise<{ items: UserDto[]; next_cursor?: string | null }> => {
      const query = new URLSearchParams();
      if (params?.limit) query.set('limit', String(params.limit));
      if (params?.cursor) query.set('cursor', params.cursor);
      const qs = query.toString();
      return request<{ items: UserDto[]; next_cursor?: string | null }>(`/api/admin/users${qs ? `?${qs}` : ''}`);
    },
    create: async (payload: { username: string; display_name: string; password: string; role?: 'admin' | 'user'; restrict_public_groups?: boolean; allowed_group_ids?: string[] }): Promise<UserDto> => {
      return request<UserDto>('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    },
    get: async (id: string): Promise<UserDto> => {
      return request<UserDto>(`/api/admin/users/${id}`);
    },
    patch: async (id: string, payload: { display_name?: string; role?: 'admin' | 'user'; status?: 'active' | 'disabled'; restrict_public_groups?: boolean }): Promise<UserDto> => {
      return request<UserDto>(`/api/admin/users/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
    },
    replaceGroups: async (id: string, groupIds: string[]): Promise<UserDto> => {
      return request<UserDto>(`/api/admin/users/${id}/allowed-groups`, {
        method: 'PUT',
        body: JSON.stringify({ group_ids: groupIds }),
      });
    },
    resetPassword: async (id: string, password: string): Promise<{ sessions_revoked: boolean }> => {
      return request<{ sessions_revoked: boolean }>(`/api/admin/users/${id}/password`, {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
    },
  },

  groups: {
    list: async (params?: { limit?: number; cursor?: string }): Promise<{ items: GroupDto[]; next_cursor?: string | null }> => {
      const query = new URLSearchParams();
      if (params?.limit) query.set('limit', String(params.limit));
      if (params?.cursor) query.set('cursor', params.cursor);
      const qs = query.toString();
      return request<{ items: GroupDto[]; next_cursor?: string | null }>(`/api/admin/groups${qs ? `?${qs}` : ''}`);
    },
    available: async (): Promise<GroupDto[]> => {
      return request<GroupDto[]>('/api/admin/me/available-groups');
    },
    create: async (payload: { name: string; description?: string; is_exclusive?: boolean; daily_units_per_user?: number }): Promise<GroupDto> => {
      return request<GroupDto>('/api/admin/groups', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    },
    get: async (id: string): Promise<GroupDto> => {
      return request<GroupDto>(`/api/admin/groups/${id}`);
    },
    patch: async (id: string, payload: { expected_revision: number; name?: string; description?: string; status?: 'active' | 'disabled'; is_exclusive?: boolean; daily_units_per_user?: number }): Promise<GroupDto> => {
      return request<GroupDto>(`/api/admin/groups/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
    },
    // UI-03: backend admin-groups.ts: deleteGroup requires JSON body {} and exact Origin / CSRF
    delete: async (id: string): Promise<GroupDto> => {
      return request<GroupDto>(`/api/admin/groups/${id}`, {
        method: 'DELETE',
        body: JSON.stringify({}),
      });
    },
    getCapabilities: async (id: string): Promise<GroupCapabilitiesDto> => {
      return request<GroupCapabilitiesDto>(`/api/admin/groups/${id}/capabilities`);
    },
    putCapabilities: async (id: string, payload: { expected_revision: number; lanes: Array<{ lane_id: string; units_per_query: number }>; default_search_lane: string | null; default_fetch_pipeline: string | null; presets: Record<string, string[]> }): Promise<GroupCapabilitiesDto> => {
      return request<GroupCapabilitiesDto>(`/api/admin/groups/${id}/capabilities`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
    },
  },

  keys: {
    list: async (params?: { user_id?: string; limit?: number; cursor?: string }): Promise<{ items: KeyDto[]; next_cursor?: string | null }> => {
      const query = new URLSearchParams();
      if (params?.user_id) query.set('user_id', params.user_id);
      if (params?.limit) query.set('limit', String(params.limit));
      if (params?.cursor) query.set('cursor', params.cursor);
      const qs = query.toString();
      return request<{ items: KeyDto[]; next_cursor?: string | null }>(`/api/admin/keys${qs ? `?${qs}` : ''}`);
    },
    create: async (payload: { user_id?: string; name: string; group_id: string; quota_units?: number; expires_at?: string | null }): Promise<KeyIssueResult> => {
      return request<KeyIssueResult>('/api/admin/keys', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    },
    get: async (id: string): Promise<KeyDto> => {
      return request<KeyDto>(`/api/admin/keys/${id}`);
    },
    patch: async (id: string, payload: { expected_revision: number; name?: string; group_id?: string; status?: 'active' | 'disabled'; quota_units?: number; expires_at?: string | null }): Promise<KeyDto> => {
      return request<KeyDto>(`/api/admin/keys/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
    },
    delete: async (id: string): Promise<KeyDto> => {
      return request<KeyDto>(`/api/admin/keys/${id}`, {
        method: 'DELETE',
        body: JSON.stringify({}),
      });
    },
    resetQuota: async (id: string, expectedRevision: number): Promise<{ id: string; reset: boolean; revision: number; usage: { used_units: number; reserved_units: number } }> => {
      return request<{ id: string; reset: boolean; revision: number; usage: { used_units: number; reserved_units: number } }>(`/api/admin/keys/${id}/reset-quota`, {
        method: 'POST',
        body: JSON.stringify({ expected_revision: expectedRevision }),
      });
    },
    getUsage: async (id: string): Promise<{ id: string; epoch: number; quota_units: number; used_units: number; reserved_units: number; remaining_units: number | null; unit: string }> => {
      return request<{ id: string; epoch: number; quota_units: number; used_units: number; reserved_units: number; remaining_units: number | null; unit: string }>(`/api/admin/keys/${id}/usage`);
    },
  },

  providers: {
    catalog: async (): Promise<ProviderCatalogDto> => {
      return request<ProviderCatalogDto>('/api/admin/providers/catalog');
    },
    list: async (params?: { limit?: number; cursor?: string }): Promise<{ items: ProviderDto[]; next_cursor?: string | null }> => {
      const query = new URLSearchParams();
      if (params?.limit) query.set('limit', String(params.limit));
      if (params?.cursor) query.set('cursor', params.cursor);
      const qs = query.toString();
      return request<{ items: ProviderDto[]; next_cursor?: string | null }>(`/api/admin/providers${qs ? `?${qs}` : ''}`);
    },
    create: async (payload: { name: string; provider_id: 'exa' | 'grok-multi-agent'; base_url?: string; options?: Record<string, unknown>; secret?: string }): Promise<ProviderDto> => {
      return request<ProviderDto>('/api/admin/providers', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    },
    get: async (id: string): Promise<ProviderDto> => {
      return request<ProviderDto>(`/api/admin/providers/${id}`);
    },
    patch: async (id: string, payload: { expected_revision: number; name?: string; status?: 'active' | 'disabled'; base_url?: string; options?: Record<string, unknown>; secret?: string; clear_secret?: boolean }): Promise<ProviderDto> => {
      return request<ProviderDto>(`/api/admin/providers/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
    },
    // UI-03: backend admin-execution.ts: delete /providers/:id parses strict {} and returns ProviderDto
    delete: async (id: string): Promise<ProviderDto> => {
      return request<ProviderDto>(`/api/admin/providers/${id}`, {
        method: 'DELETE',
        body: JSON.stringify({}),
      });
    },
  },

  lanes: {
    list: async (): Promise<{ items: LaneDto[] }> => {
      return request<{ items: LaneDto[] }>('/api/admin/lanes');
    },
    create: async (payload: { id: string; provider_id: string; operation_id: 'search' | 'contents' | 'research'; latency: 'fast' | 'medium' | 'slow'; cost: 'free' | 'cheap' | 'expensive'; evidence_groups?: string[] }): Promise<LaneDto> => {
      return request<LaneDto>('/api/admin/lanes', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    },
    patch: async (id: string, payload: { status: 'active' | 'disabled' }): Promise<LaneDto> => {
      return request<LaneDto>(`/api/admin/lanes/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
    },
  },

  quotas: {
    me: async (): Promise<{ items: UserQuotaDto[] }> => {
      return request<{ items: UserQuotaDto[] }>('/api/admin/me/quotas');
    },
    user: async (userId: string): Promise<{ items: UserQuotaDto[] }> => {
      return request<{ items: UserQuotaDto[] }>(`/api/admin/users/${userId}/quotas`);
    },
  },

  usage: {
    report: async (params?: { user_id?: string; group_id?: string; key_id?: string; job_id?: string; from?: string; to?: string; limit?: number; cursor?: string }): Promise<UsageReportDto> => {
      const query = new URLSearchParams();
      if (params?.user_id) query.set('user_id', params.user_id);
      if (params?.group_id) query.set('group_id', params.group_id);
      if (params?.key_id) query.set('key_id', params.key_id);
      if (params?.job_id) query.set('job_id', params.job_id);
      if (params?.from) query.set('from', params.from);
      if (params?.to) query.set('to', params.to);
      if (params?.limit) query.set('limit', String(params.limit));
      if (params?.cursor) query.set('cursor', params.cursor);
      const qs = query.toString();
      return request<UsageReportDto>(`/api/admin/usage${qs ? `?${qs}` : ''}`);
    },
  },

  jobs: {
    get: async (id: string): Promise<JobDetailDto> => {
      return request<JobDetailDto>(`/api/admin/jobs/${id}`);
    },
    cancel: async (id: string): Promise<CancelJobResultDto> => {
      return request<CancelJobResultDto>(`/api/admin/jobs/${id}/cancel`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
    },
    // UI-02: real wire DTO returns { schema_version, action, job_id, state, chunks, artifact?, next_cursor? }
    read: async (id: string, params?: { cursor?: string; page_size?: number }): Promise<JobReadResponseDto> => {
      return request<JobReadResponseDto>(`/api/admin/jobs/${id}/read`, {
        method: 'POST',
        body: JSON.stringify(params || {}),
      });
    },
  },

  audit: {
    list: async (params?: { limit?: number; cursor?: string }): Promise<{ items: AuditEventDto[]; next_cursor?: string | null }> => {
      const query = new URLSearchParams();
      if (params?.limit) query.set('limit', String(params.limit));
      if (params?.cursor) query.set('cursor', params.cursor);
      const qs = query.toString();
      return request<{ items: AuditEventDto[]; next_cursor?: string | null }>(`/api/admin/audit${qs ? `?${qs}` : ''}`);
    },
  },
};
