import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DbHandle } from '../../src/db/client.js';
import { SdkExecutionBridge } from '../../src/execution/bridge.js';
import type { ProviderService } from '../../src/execution/providers.js';
import type { FrozenPlan } from '../../src/execution/types.js';
import type { Resolver } from '../../src/egress/address.js';
import type { PinnedIo } from '../../src/egress/transport.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function plan(): FrozenPlan {
  return {
    version: 1, tenant_id: 'tenant', kind: 'search', delivery: 'async', sdk_version: 'sdk', group_id: 'group',
    parsed_wire: { action: 'run', execution: 'async', query: 'bridge brief', lane: 'gma.research', idempotency_key: 'bridge' },
    effective_input: { action: 'run', execution: 'sync', query: 'bridge brief', lane: 'gma.research', timeout_ms: 600_000 },
    selection: { source: 'lane', lanes: ['gma.research'], requested: 'gma.research' },
    selected: [{ lane_id: 'gma.research', kind: 'search', provider_resource_id: 'provider-resource', provider_config_id: 'provider-config', provider_id: 'grok-multi-agent', operation_id: 'research', adapter_version: '2', output: { channel: 'typed', schema_id: 'nb-search.multi-agent-research@1' }, units_per_query: 1, latency: 'slow', cost: 'expensive', evidence_groups: [] }],
    budget: { units: 1, provider_calls: 1, retry_count: 0, max_concurrency: 4, timeout_ms: 600_000, max_inline_bytes: 16_777_216, result_ttl_seconds: 259_200 },
    group_revision: '1',
  };
}

describe('cloud async timeout bridge seams', () => {
  it('prepares and dispatches a 600-second GMA search without applying the fetch 120-second schema', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nb-search-cloud-timeout-')); roots.push(root);
    const config = { id: 'provider-config', tenant_id: 'tenant', provider_id: 'provider-resource', version: 1, sdk_version: 'sdk', adapter_version: '2', base_url: 'https://relay.example/v1', options: { model: 'grok-4.20-multi-agent-xhigh', reasoning_effort: 'xhigh', api_mode: 'chat_completions' }, secret_key_id: 'secret', nonce: Buffer.alloc(12), ciphertext: Buffer.alloc(1), auth_tag: Buffer.alloc(16), credential_updated_at: null, created_at: new Date() };
    const providers = { config: async () => config, decrypt: () => 'fake-provider-secret' } as unknown as ProviderService;
    const seen: Array<{ maximum: number; signal: AbortSignal }> = [];
    const io: PinnedIo = { async request(input) { seen.push({ maximum: input.maximum, signal: input.signal }); return { status: 200, headers: {}, bytes: Buffer.from(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: 'bridge ok', results: [] }) } }] }), 'utf8') }; } };
    const resolver: Resolver = async () => ['93.184.216.34'];
    const bridge = await SdkExecutionBridge.create({ db: { pool: {} } as unknown as DbHandle, providers, sdkVersion: 'sdk', homeRoot: root, io, resolver });
    try {
      const prepared = await bridge.prepare(plan(), new AbortController().signal);
      const result = await prepared.execute(new AbortController().signal);
      expect(result).toMatchObject({ status: 'succeeded', output: { channel: 'typed', data: { answer: 'bridge ok' } } });
      expect(seen).toHaveLength(1); expect(seen[0]?.maximum).toBe(1_048_576); expect(seen[0]?.signal.aborted).toBe(false);
    } finally { await bridge.close(); }
  });
});
