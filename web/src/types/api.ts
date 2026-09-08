export type Role = 'admin' | 'user';
export type EntityStatus = 'active' | 'disabled';

export interface UserDto {
  id: string;
  username: string;
  display_name: string;
  role: Role;
  status: EntityStatus;
  restrict_public_groups: boolean;
  allowed_group_ids: string[];
  created_at: string;
  updated_at: string;
}

export interface GroupDto {
  id: string;
  name: string;
  description: string;
  status: EntityStatus;
  is_exclusive: boolean;
  daily_units_per_user: number;
  revision: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface GroupLaneCapability {
  lane_id: string;
  kind: 'search' | 'fetch';
  units_per_query: number;
  output: {
    channel: 'results' | 'typed';
    schema_id?: string;
  };
  configured: boolean;
  effective_execution_modes: string[];
  issues?: Array<{ code: string }>;
}

export interface GroupCapabilitiesDto {
  group_id: string;
  revision: number;
  default_search_lane: string | null;
  default_fetch_pipeline: string | null;
  presets: Record<string, string[]>;
  lanes: GroupLaneCapability[];
}

export interface KeyDto {
  id: string;
  user_id: string;
  group_id: string;
  name: string;
  prefix: string;
  status: EntityStatus;
  effective_status?: 'active' | 'disabled' | 'quota_exhausted' | 'expired';
  quota_units: number;
  quota_epoch?: number;
  expires_at: string | null;
  deleted_at: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  usage?: {
    epoch: number;
    used_units: number;
    reserved_units: number;
    remaining_units: number | null;
  };
}

export interface KeyIssueResult {
  key: KeyDto;
  access_key: string;
}

export interface TenantSummary {
  id: string;
  slug: string;
  name: string;
}

export interface SessionDto {
  tenant: TenantSummary;
  user: UserDto;
  csrf_token: string;
  expires_at: string;
}

export interface ProviderPoolKey { id?: string; label: string; enabled: boolean; secret?: string }
export interface ProviderDto {
  id: string;
  name: string;
  provider_id: 'exa' | 'grok-multi-agent' | 'script';
  status: EntityStatus;
  revision: number;
  base_url?: string | null;
  options?: Record<string, unknown>;
  credential_configured: boolean;
  key_pool?: ProviderPoolKey[];
  key_pool_selections?: string;
  credential_updated_at?: string | null;
  deleted_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface ProviderCatalogDto {
  operations: Array<{
    provider_id: string;
    operation_id: string;
    kind: 'search' | 'fetch';
  }>;
  provider_options: Record<string, Record<string, unknown>>;
  credential_write_only: boolean;
  script_channels?: { id: string; label: string }[];
}

export interface LaneDto {
  id: string;
  kind: 'search' | 'fetch';
  provider_id: string;
  operation_id: string;
  status: EntityStatus;
  latency: 'fast' | 'medium' | 'slow';
  cost: 'free' | 'cheap' | 'expensive';
  evidence_groups: string[];
  created_at?: string;
  updated_at?: string;
}

export interface UserQuotaDto {
  group_id: string;
  daily_units_per_user: number;
  utc_day: string;
  used_units: number;
  reserved_units: number;
  remaining_units: number | null;
  reset_at: string;
  unit: 'execution_unit';
}

export interface UsageItemDto {
  job_id: string;
  user_id: string;
  request_id: string;
  kind: 'search' | 'fetch';
  delivery: 'sync' | 'async';
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  group_id: string;
  key_id: string;
  selection: Record<string, unknown>;
  reserved_units: number;
  charged_units: number;
  released_units: number;
  settlement_reason: string;
  created_at: string;
  completed_at: string | null;
}

export interface UsageReportDto {
  items: UsageItemDto[];
  totals: {
    reserved: number;
    charged: number;
    released: number;
  };
  next_cursor?: string | null;
}

/**
 * Backend GET /api/admin/jobs/:id response.
 * When user is owner (or content_access=true): includes jobView schema_version='3.0', cancel_requested, error, etc.
 * When admin views another user's job: content_access=false with metadata only.
 */
export interface JobDetailDto {
  schema_version?: string;
  action?: string;
  job_id: string;
  user_id?: string;
  kind?: 'search' | 'fetch';
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  cancel_requested?: boolean;
  created_at: string;
  updated_at?: string;
  started_at?: string;
  completed_at?: string | null;
  content_access: boolean;
  error?: { code: string; message: string } | null;
  artifact?: {
    media_type: string;
    byte_length: number;
    sha256: string;
    expires_at: string;
  };
}

export interface CancelJobResultDto {
  schema_version: string;
  mode?: string;
  action: 'cancel';
  job_id: string;
  state: string;
  cancel_requested: boolean;
}

export interface ArtifactChunkDto {
  index: number;
  offset: number;
  byte_length: number;
  data_base64: string;
}

export interface JobReadResponseDto {
  schema_version: string;
  mode?: string;
  action: 'read';
  job_id: string;
  state: string;
  artifact?: {
    media_type: string;
    byte_length: number;
    sha256: string;
    expires_at: string;
  };
  chunks: ArtifactChunkDto[];
  next_cursor?: string;
}

export interface AuditEventDto {
  id: string;
  actor_user_id: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  request_id: string;
  created_at: string;
  metadata: Record<string, unknown>;
}

export interface ApiEnvelope<T> {
  data: T;
  request_id: string;
}

export interface ApiErrorField {
  path: string;
  code: string;
}

export interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    fields?: ApiErrorField[];
    retry_after_ms?: number;
  };
  request_id: string;
}
