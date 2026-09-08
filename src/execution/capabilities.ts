import { builtInProviderRegistrations, type CapabilityEnvelope } from '@nb-corp/nb-search';
import type { PoolClient } from 'pg';
import { queryOne } from '../db/transaction.js';
import { currentIdentity } from './policy.js';
import { groupLanes, type LaneReady } from './plans.js';
import { operation, modes } from './catalog.js';
import { LIMITS, type ServicePrincipal } from './types.js';

export async function capabilities(tx: PoolClient, principal: ServicePrincipal, ready: LaneReady): Promise<CapabilityEnvelope> {
  const identity = await currentIdentity(tx, principal);
  const lanes = await groupLanes(tx, principal.tenantId, identity.group.id);
  const revision = (await queryOne<{ revision: string }>(tx, 'SELECT revision FROM tenants WHERE id=$1', [principal.tenantId]))!.revision;
  const providerAvailable = (lane: (typeof lanes)[number]) => lane.provider_status === 'active' && !lane.provider_deleted_at && ready(lane);
  const available = (lane: (typeof lanes)[number]) => lane.status === 'active' && providerAvailable(lane);
  const descriptors = builtInProviderRegistrations().map((registration) => registration.descriptor).filter((descriptor) => lanes.some((lane) => lane.provider_kind === descriptor.provider_id));
  const providers: CapabilityEnvelope['providers'] = {
    descriptors: descriptors.map((descriptor) => ({ ...descriptor, option_keys: [], query_operations: descriptor.query_operations.filter((op) => lanes.some((lane) => lane.provider_kind === descriptor.provider_id && lane.operation_id === op.operation_id)).map((op) => ({ ...op })), fetch_operations: descriptor.fetch_operations.filter((op) => lanes.some((lane) => lane.provider_kind === descriptor.provider_id && lane.operation_id === op.operation_id)).map((op) => ({ ...op, input_kinds: ['url'], execution_modes: ['sync'], media_types: [...op.media_types], representations: [...op.representations], stages: op.stages.map((stage) => ({ ...stage })) })) })),
    instances: [...new Map(lanes.map((lane) => [lane.provider_id, lane])).values()].map((lane) => {
      const activation = descriptors.find(descriptor => descriptor.provider_id === lane.provider_kind)!.activation;
      return { id: lane.provider_id, provider_id: lane.provider_kind, enabled: lane.provider_status === 'active' && !lane.provider_deleted_at, availability: providerAvailable(lane) ? 'ready' : 'unavailable', issues: providerAvailable(lane) ? [] : [{ code: 'CLOUD_EGRESS_UNVERIFIED' }], credential: { requirement: activation.credential, configured: lane.secret_key_id !== null }, endpoint: { requirement: activation.endpoint, configured: activation.endpoint !== 'required' || !!lane.base_url } };
    }),
  };
  const searchLanes = lanes.filter((lane) => lane.kind === 'search');
  const fetchLanes = lanes.filter((lane) => lane.kind === 'fetch');
  return {
    schema_version: '3.0', revision: `cloud-1-${revision}-${identity.key.revision}-${identity.key.group_id}`, providers,
    search: {
      ...(identity.group.default_search_lane && searchLanes.some((lane) => lane.id === identity.group.default_search_lane) ? { default_lane: identity.group.default_search_lane } : {}),
      lanes: searchLanes.map((lane) => ({ id: lane.id, output: queryOutput(lane.provider_kind, lane.operation_id), execution_modes: modes('search', available(lane)), availability: available(lane) ? 'ready' : 'unavailable', issues: available(lane) ? [] : [{ code: 'CLOUD_EGRESS_UNVERIFIED' }], latency: lane.latency, cost: lane.cost })),
      presets: Object.entries(identity.group.presets).filter(([, ids]) => ids.length > 0 && ids.every((id) => searchLanes.some((lane) => lane.id === id))).map(([name, ids]) => { const configured = ids.every((id) => searchLanes.some((lane) => lane.id === id && available(lane))); return { name, lanes: ids, execution_modes: modes('search', configured), availability: configured ? 'ready' : 'unavailable', issues: configured ? [] : [{ code: 'CLOUD_EGRESS_UNVERIFIED' }] }; }),
      limits: { max_queries: 64, max_results: 100, max_timeout_ms: LIMITS.maxTimeoutMs, max_inline_bytes: LIMITS.inlineBytes },
    },
    fetch: { default_representation: 'markdown', inputs: [{ kind: 'url', enabled: true, max_bytes: 2_097_152 }, { kind: 'inline_text', enabled: false, max_bytes: 0 }, { kind: 'inline_bytes', enabled: false, max_bytes: 0 }, { kind: 'file', enabled: false, max_bytes: 0 }],
      chains: identity.group.default_fetch_pipeline && fetchLanes.some((lane) => lane.id === identity.group.default_fetch_pipeline) ? [{ input_kind: 'url', representation: 'markdown', pipelines: [identity.group.default_fetch_pipeline] }, { input_kind: 'url', representation: 'text', pipelines: [identity.group.default_fetch_pipeline] }] : [],
      pipelines: fetchLanes.map((lane) => {
        const selected = operation(lane.provider_kind, lane.operation_id);
        if (selected.kind !== 'fetch') throw new Error('FETCH_OPERATION_REQUIRED');
        const descriptor = selected.descriptor;
        return { id: lane.id, input_kinds: ['url'], media_types: [...descriptor.media_types], representations: [...descriptor.representations], execution_modes: modes('fetch', available(lane)), egress: descriptor.egress, stages: descriptor.stages.map(stage => ({ ...stage })), availability: available(lane) ? 'ready' : 'unavailable', issues: available(lane) ? [] : [{ code: 'CLOUD_EGRESS_UNVERIFIED' }], latency: lane.latency, cost: lane.cost };
      }),
      limits: { max_source_bytes: 2_097_152, max_response_bytes: 2_097_152, max_content_chars: 200_000, max_redirects: 0, max_timeout_ms: LIMITS.maxSyncTimeoutMs, max_inline_bytes: LIMITS.inlineBytes },
    },
    jobs: { result_ttl_seconds: LIMITS.ttlSeconds, cancel_supported: true },
  };
}
function queryOutput(providerId: string, operationId: string) {
  const descriptor = operation(providerId, operationId);
  if (descriptor.kind !== 'search') throw new Error('QUERY_OPERATION_REQUIRED');
  return descriptor.output;
}
