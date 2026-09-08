import { builtInProviderRegistrations, resolveProviderOperation } from '@nb-corp/nb-search';
import { appError } from '../errors.js';
import type { Kind } from './types.js';
import type { ScriptChannels } from './script-channels.js';

// Cloud deployment policy, not another provider registry. Do not enable every SDK adapter.
const allowed = [['exa', 'search'], ['exa', 'contents'], ['grok-multi-agent', 'research'], ['script', 'search']] as const;
export type ProviderId = typeof allowed[number][0];
const registrations = builtInProviderRegistrations();
export const SUPPORTED_OPERATIONS = Object.freeze(allowed.map(([provider_id, operation_id]) => {
  const provider = registrations.find(entry => entry.descriptor.provider_id === provider_id)?.descriptor;
  const query = provider?.query_operations.find(entry => entry.operation_id === operation_id);
  const fetch = provider?.fetch_operations.find(entry => entry.operation_id === operation_id);
  if (!provider || !query && !fetch) throw new Error('CLOUD_SDK_OPERATION_MISSING');
  const common = { provider_id, operation_id, adapter_version: provider.adapter_version };
  if (query) return { ...common, kind: 'search' as const, descriptor: query, output: query.output };
  return { ...common, kind: 'fetch' as const, descriptor: fetch!, output: { channel: 'results' as const, schema_id: fetch!.schema_id } };
}));
export function operation(providerId: string, operationId?: string) {
  const found = SUPPORTED_OPERATIONS.find(item => item.provider_id === providerId && (operationId === undefined || item.operation_id === operationId));
  if (!found) throw appError('VALIDATION_FAILED');
  return found;
}
/** SDK owns validation, defaults and exact adapter URLs. Cloud supplies only operator
 * script resolution and checks the returned targets separately against its network policy. */
export function resolveChannelOperation(providerId: ProviderId, operationId: string, base: string | undefined, options: Record<string, unknown>, scripts?: ScriptChannels) {
  operation(providerId, operationId);
  try {
    const script = providerId === 'script' ? scripts?.resolve(options) : undefined;
    if (providerId === 'script' && !script) throw Error('SCRIPT_NOT_REGISTERED');
    const resolved = resolveProviderOperation(providerId, operationId, { provider_id: providerId, enabled: true, ...(base ? { base_url: base } : {}), options: script?.options ?? options });
    return { ...resolved, endpoints: script ? [...resolved.endpoints, ...script.endpoints] : resolved.endpoints };
  } catch { throw appError('VALIDATION_FAILED'); }
}
export function modes(kind: Kind, ready: boolean): ('sync' | 'async')[] { return !ready ? [] : kind === 'search' ? ['sync', 'async'] : ['sync']; }
