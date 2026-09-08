import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createNbSearchRuntime, parseConfigPatch, type CanonicalConfigPatch, type FetchRunSyncEnvelope, type SearchRunSyncEnvelope } from '@nb-corp/nb-search';
import type { DbHandle } from '../db/client.js';
import { endpoint } from './catalog.js';
import { ProviderService } from './providers.js';
import { CloudPinnedHttpTransport, type PinnedIo } from '../egress/transport.js';
import { publicUrl, resolvePinned, type Resolver } from '../egress/address.js';
import type { FrozenPlan } from './types.js';

export interface PreparedExecution { execute(signal: AbortSignal): Promise<SearchRunSyncEnvelope | FetchRunSyncEnvelope> }
export interface ExecutionBridge { prepare(plan: FrozenPlan, signal: AbortSignal): Promise<PreparedExecution> }
export interface BridgeOptions { db: DbHandle; providers: ProviderService; sdkVersion: string; homeRoot: string; io?: PinnedIo; resolver?: Resolver }

/** Only a trusted host can supply IO overrides; none are expressible through HTTP or database options. */
export class SdkExecutionBridge implements ExecutionBridge {
  private constructor(private readonly options: BridgeOptions, readonly privateHome: string) {}
  static async create(options: BridgeOptions): Promise<SdkExecutionBridge> {
    const root = resolve(options.homeRoot);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const home = await mkdtemp(resolve(root, 'sdk-'));
    return new SdkExecutionBridge(options, home);
  }
  async close(): Promise<void> { await rm(this.privateHome, { recursive: true, force: true }); }
  async prepare(plan: FrozenPlan, signal: AbortSignal): Promise<PreparedExecution> {
    if (plan.version !== 1 || plan.sdk_version !== this.options.sdkVersion || plan.selected.length === 0) throw new Error('EXECUTION_VERSION_UNAVAILABLE');
    const env: NodeJS.ProcessEnv = { NB_SEARCH_HOME: this.privateHome, NB_SEARCH_JOBS_ROOT: resolve(this.privateHome, 'unused-jobs') };
    const instances: Record<string, unknown> = {};
    const credentials: Record<string, unknown> = {};
    const lanes: Record<string, unknown> = {};
    const endpoints: string[] = [];
    let credentialIndex = 0;
    for (const selected of plan.selected) {
      const config = await this.options.providers.config(this.options.db.pool, plan.selected.length ? planTenant(plan) : '', selected.provider_config_id);
      if (config.sdk_version !== plan.sdk_version || config.adapter_version !== selected.adapter_version || config.provider_id !== selected.provider_resource_id) throw new Error('EXECUTION_VERSION_UNAVAILABLE');
      const target = endpoint(config.base_url, selected.provider_id, selected.operation_id, config.options);
      publicUrl(target);
      endpoints.push(target);
      const credential = this.options.providers.decrypt(config);
      if (!credential) throw new Error('CREDENTIAL_UNAVAILABLE');
      const slot = `credential.${selected.provider_resource_id}`;
      const environmentName = `NBC_CREDENTIAL_${credentialIndex++}`;
      env[environmentName] = credential;
      credentials[slot] = { provider_id: selected.provider_id, env: environmentName };
      instances[selected.provider_resource_id] = { provider_id: selected.provider_id, enabled: true, credential_slot_id: slot, base_url: config.base_url, options: config.options };
      lanes[selected.lane_id] = { provider_instance_id: selected.provider_resource_id, operation_id: selected.operation_id, latency: selected.latency, cost: selected.cost, ...(selected.evidence_groups.length ? { evidence_groups: selected.evidence_groups } : {}) };
    }
    if (plan.kind === 'fetch') {
      const source = plan.effective_input['source'];
      if (!source || Array.isArray(source) || typeof source !== 'object' || source['kind'] !== 'url' || typeof source['url'] !== 'string') throw new Error('URL_ONLY');
      // This is source screening only. Exa's remote acquisition DNS is not under our control.
      await resolvePinned(publicUrl(source['url'], false), signal, this.options.resolver);
    }
    const transport = new CloudPinnedHttpTransport({ endpoints, maxRequests: plan.budget.provider_calls, deadlineMs: plan.budget.timeout_ms }, this.options.io, this.options.resolver);
    const searchTimeout = plan.kind === 'search' ? plan.budget.timeout_ms : 30_000;
    const fetchTimeout = plan.kind === 'fetch' ? plan.budget.timeout_ms : 60_000;
    const defaults = plan.kind === 'search' ? { search_lane: plan.selected[0]!.lane_id } : { fetch_chain: [{ input_kind: 'url', pipelines: [plan.selected[0]!.lane_id] }] };
    const presets = typeof plan.parsed_wire['preset'] === 'string' ? { [plan.parsed_wire['preset']]: { lanes: plan.selected.map((lane) => lane.lane_id) } } : {};
    const overrides = parseConfigPatch({ schema_version: '4', home: this.privateHome, jobs_root: resolve(this.privateHome, 'unused-jobs'), provider_instances: instances, credential_slots: credentials, lanes, defaults, presets,
      retention_hours: 72, log_level: 'error', fetch: { file_scopes: [] }, execution: { max_provider_calls: plan.budget.provider_calls, max_concurrency: plan.budget.max_concurrency, retry_count: 0,
        search_timeout_ms: searchTimeout, fetch_timeout_ms: fetchTimeout, max_inline_bytes: plan.budget.max_inline_bytes,
        fetch: { max_source_bytes: 2_097_152, max_response_bytes: 2_097_152, max_content_chars: 200_000, max_redirects: 0, quality: { min_content_chars: 1, blocked_markers: [] } } } }, 'cloud execution plan');
    const clear: CanonicalConfigPatch = { provider_instances: null, credential_slots: null, lanes: null, defaults: null, presets: null };
    const runtime = createNbSearchRuntime({ env, config: clear, overrides, http_transport: transport });
    let used = false;
    return { execute: async (executionSignal) => {
      if (used) throw new Error('EXECUTION_ALREADY_DISPATCHED'); used = true;
      const input = { ...plan.effective_input, action: 'run' as const, execution: 'sync' as const };
      const envelope = plan.kind === 'search'
        ? await runtime.search(input as Parameters<typeof runtime.search>[0], { signal: executionSignal })
        : await runtime.fetch(input as Parameters<typeof runtime.fetch>[0], { signal: executionSignal });
      if (envelope.action !== 'run' || envelope.execution !== 'sync') throw new Error('SYNC_BRIDGE_CONTRACT');
      if (transport.policyFailure) {
        const error = { code: 'PROVIDER_UNAVAILABLE' as const, message: 'Provider network policy rejected the request.', retryable: false };
        if (plan.kind === 'fetch') return { schema_version: '3.0', mode: 'fetch', action: 'run', execution: 'sync', selection: { source: 'default' }, status: 'failed', error, documents: [], lane_outcomes: [], hints: [] };
        return { schema_version: '3.0', action: 'run', execution: 'sync', status: 'failed', error, hints: [] };
      }
      return envelope;
    } };
  }
}
function planTenant(plan: FrozenPlan): string {
  // The tenant is server-owned, stored with the immutable plan; never supplied by SDK wire input.
  const tenant = plan.tenant_id;
  if (!tenant) throw new Error('PLAN_TENANT_REQUIRED');
  return tenant;
}
