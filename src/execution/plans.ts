import type { PoolClient } from 'pg';
import { compatibleSdkVersion } from './sdk-version.js';
import { queryRows } from '../db/transaction.js';
import { operation, type ProviderId } from './catalog.js';
import { BusinessRejection, ExecutionError } from './errors.js';
import { LIMITS, type Delivery, type FrozenPlan, type Json, type Kind, type SelectedOperation } from './types.js';
import type { ExecutionGroup } from './policy.js';

export interface AvailableLane {
  id: string; kind: Kind; provider_id: string; operation_id: string; status: string; latency: SelectedOperation['latency']; cost: SelectedOperation['cost']; evidence_groups: string[];
  units_per_query: number; provider_kind: ProviderId; provider_status: string; provider_deleted_at: Date | null;
  config_id: string; sdk_version: string; adapter_version: string; secret_key_id: string | null; base_url: string; options: Record<string, unknown>;
}
export async function groupLanes(tx: PoolClient, tenantId: string, groupId: string): Promise<AvailableLane[]> {
  return queryRows<AvailableLane>(tx, `SELECT l.*,gl.units_per_query,p.provider_id AS provider_kind,p.status AS provider_status,p.deleted_at AS provider_deleted_at,
    c.id AS config_id,c.sdk_version,c.adapter_version,c.secret_key_id,c.base_url,c.options FROM group_lanes gl
    JOIN lanes l ON l.tenant_id=gl.tenant_id AND l.id=gl.lane_id JOIN providers p ON p.tenant_id=l.tenant_id AND p.id=l.provider_id
    JOIN provider_configs c ON c.tenant_id=p.tenant_id AND c.id=p.current_config_id WHERE gl.tenant_id=$1 AND gl.group_id=$2 ORDER BY l.id`, [tenantId, groupId]);
}
export type LaneReady = (lane: AvailableLane) => boolean;
export function resolvePlanTimeout(kind: Kind, delivery: Delivery, selected: readonly Pick<SelectedOperation, 'provider_id' | 'operation_id'>[], requested: Json | undefined): number {
  if (typeof requested === 'number') return requested;
  if (kind === 'fetch') return 60_000;
  const gmaResearch = selected.some((item) => item.provider_id === 'grok-multi-agent' && item.operation_id === 'research');
  if (gmaResearch) return delivery === 'async' ? 600_000 : 120_000;
  return 30_000;
}
export function planTimeoutMaximum(kind: Kind, delivery: Delivery): number { return kind === 'search' && delivery === 'async' ? LIMITS.maxTimeoutMs : LIMITS.maxSyncTimeoutMs; }
export async function buildPlan(tx: PoolClient, tenantId: string, group: ExecutionGroup, kind: Kind, wire: Record<string, Json>, sdkVersion: string, ready: LaneReady): Promise<FrozenPlan> {
  const delivery = wire['execution'] === 'async' ? 'async' : 'sync';
  if (kind === 'fetch' && delivery === 'async') throw new BusinessRejection('LANE_EXECUTION_UNSUPPORTED', 'Asynchronous URL fetch is not supported.');
  const all = await groupLanes(tx, tenantId, group.id);
  let ids: string[];
  let selection: Record<string, Json>;
  if (kind === 'search') {
    if (typeof wire['lane'] === 'string') { ids = [wire['lane']]; selection = { source: 'lane', lanes: ids, requested: wire['lane'] }; }
    else if (Array.isArray(wire['lanes'])) { ids = wire['lanes'] as string[]; selection = { source: 'lanes', lanes: ids, requested: ids }; }
    else if (typeof wire['preset'] === 'string') {
      ids = Object.hasOwn(group.presets, wire['preset']) ? group.presets[wire['preset']]! : [];
      if (!ids.length) throw new BusinessRejection('PRESET_NOT_FOUND', 'Search preset is unavailable.');
      selection = { source: 'preset', lanes: ids, requested: wire['preset'] };
    } else {
      if (!group.default_search_lane) throw new BusinessRejection('DEFAULT_NOT_CONFIGURED', 'Default search lane is not configured.');
      ids = [group.default_search_lane]; selection = { source: 'default', lanes: ids };
    }
  } else {
    const pipeline = typeof wire['pipeline'] === 'string' ? wire['pipeline'] : group.default_fetch_pipeline;
    if (!pipeline) throw new BusinessRejection('FETCH_DEFAULT_NOT_CONFIGURED', 'Default fetch pipeline is not configured.');
    ids = [pipeline]; selection = typeof wire['pipeline'] === 'string' ? { source: 'pipeline', pipeline } : { source: 'default' };
  }
  if (new Set(ids).size !== ids.length) throw new BusinessRejection('INVALID_INPUT', 'Selected lanes must be unique.');
  const selected: SelectedOperation[] = ids.map((id) => {
    const lane = all.find((item) => item.id === id && item.kind === kind);
    if (!lane) throw new ExecutionError('FORBIDDEN');
    if (lane.status !== 'active' || lane.provider_status !== 'active' || lane.provider_deleted_at || !ready(lane) || !compatibleSdkVersion(lane.sdk_version, sdkVersion)) throw new BusinessRejection('LANE_NOT_CONFIGURED', 'Selected lane is unavailable.');
    const descriptor = operation(lane.provider_kind, lane.operation_id);
    return { lane_id: lane.id, kind, provider_resource_id: lane.provider_id, provider_config_id: lane.config_id, provider_id: lane.provider_kind,
      operation_id: descriptor.operation_id, adapter_version: lane.adapter_version, output: { ...descriptor.output }, units_per_query: lane.units_per_query, latency: lane.latency, cost: lane.cost, evidence_groups: lane.evidence_groups };
  });
  if (kind === 'search' && selected.some((item) => item.output.channel === 'typed') && (selected.length !== 1 || wire['lanes'] !== undefined || wire['preset'] !== undefined)) throw new BusinessRejection('MIXED_OUTPUT_UNSUPPORTED', 'Typed output requires one explicit or default lane.');
  const count = kind === 'fetch' ? 1 : Array.isArray(wire['query']) ? wire['query'].length : 1;
  const calls = count * selected.length;
  if (calls < 1 || calls > LIMITS.maxItems) throw new BusinessRejection('BUDGET_EXCEEDED', 'Selected operations exceed the execution budget.');
  const timeout = resolvePlanTimeout(kind, delivery, selected, wire['timeout_ms']);
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > planTimeoutMaximum(kind, delivery)) throw new ExecutionError('INVALID_REQUEST');
  const effective: Record<string, Json> = { ...wire, execution: 'sync', timeout_ms: timeout };
  delete effective['idempotency_key'];
  if (kind === 'search') effective['max_results'] = wire['max_results'] ?? 8;
  else { effective['representation'] = wire['representation'] ?? 'markdown'; effective['max_content_chars'] = Math.min(typeof wire['max_content_chars'] === 'number' ? wire['max_content_chars'] : 200_000, 200_000); }
  return { version: 1, tenant_id: tenantId, kind, delivery, sdk_version: sdkVersion, group_id: group.id, parsed_wire: wire, effective_input: effective, selection, selected,
    budget: { units: count * selected.reduce((sum, item) => sum + item.units_per_query, 0), provider_calls: calls, retry_count: 0, max_concurrency: 4, timeout_ms: timeout, max_inline_bytes: delivery === 'sync' ? LIMITS.inlineBytes : LIMITS.artifactBytes, result_ttl_seconds: LIMITS.ttlSeconds }, group_revision: String(group.revision) };
}
