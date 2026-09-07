export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Kind = 'search' | 'fetch';
export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type Delivery = 'sync' | 'async';
export interface ServicePrincipal { tenantId: string; userId: string; keyId: string; groupId: string }
export interface SafeFailure { code: string; message: string; retryable: boolean }
export interface SelectedOperation {
  lane_id: string;
  kind: Kind;
  provider_resource_id: string;
  provider_config_id: string;
  provider_id: 'exa' | 'grok-multi-agent';
  operation_id: 'search' | 'contents' | 'research';
  adapter_version: string;
  output: { channel: 'results' | 'typed'; schema_id: string };
  units_per_query: number;
  latency: 'fast' | 'medium' | 'slow';
  cost: 'free' | 'cheap' | 'expensive';
  evidence_groups: string[];
}
export interface FrozenPlan {
  version: 1;
  tenant_id: string;
  kind: Kind;
  delivery: Delivery;
  sdk_version: string;
  group_id: string;
  parsed_wire: Record<string, Json>;
  effective_input: Record<string, Json>;
  selection: Record<string, Json>;
  selected: SelectedOperation[];
  budget: { units: number; provider_calls: number; retry_count: 0; max_concurrency: number; timeout_ms: number; max_inline_bytes: number; result_ttl_seconds: number };
  group_revision: string;
}
export interface JobRow {
  id: string; tenant_id: string; user_id: string; group_id: string; admitting_key_id: string;
  kind: Kind; delivery: Delivery; state: JobState; first_plan: FrozenPlan | null;
  selection: Record<string, Json>; request_id: string; created_at: Date; updated_at: Date;
  started_at: Date | null; completed_at: Date | null; expires_at: Date | null;
  cancel_requested_at: Date | null; lease_owner: string | null; lease_expires_at: Date | null;
  claim_count: number; dispatch_started_at: Date | null; public_error: SafeFailure | null;
  sync_envelope: Record<string, Json> | null; purged_at: Date | null;
}
export const LIMITS = Object.freeze({ maxItems: 64, inlineBytes: 65_536, artifactBytes: 16_777_216, chunkBytes: 12_288, ttlSeconds: 259_200, maxTimeoutMs: 120_000, userActive: 4, tenantActive: 16, queueMs: 300_000, leaseMs: 30_000 });
export function failure(code: 'WORKER_LOST' | 'WORKER_START_FAILED' | 'CANCELLED' | 'DEADLINE_EXCEEDED' | 'INTERNAL' | 'OUTPUT_TOO_LARGE' | 'PROVIDER_UNAVAILABLE'): SafeFailure {
  const messages = { WORKER_LOST: 'Worker execution outcome is unknown.', WORKER_START_FAILED: 'Worker could not start execution.', CANCELLED: 'Execution was cancelled.', DEADLINE_EXCEEDED: 'Execution deadline exceeded.', INTERNAL: 'Execution failed.', OUTPUT_TOO_LARGE: 'Execution output exceeded the result limit.', PROVIDER_UNAVAILABLE: 'Provider execution is unavailable.' };
  return { code, message: messages[code], retryable: false };
}
export function jsonBytes(value: unknown): Buffer { return Buffer.from(JSON.stringify(value), 'utf8'); }
