import { z } from 'zod';
import { appError } from '../errors.js';
import type { Kind } from './types.js';

export const SUPPORTED_OPERATIONS = Object.freeze([
  { provider_id: 'exa', operation_id: 'search', kind: 'search', adapter_version: '1', output: { channel: 'results', schema_id: 'nb-search.results@1' } },
  { provider_id: 'exa', operation_id: 'contents', kind: 'fetch', adapter_version: '1', output: { channel: 'results', schema_id: 'nb-search.fetch@1' } },
  { provider_id: 'grok-multi-agent', operation_id: 'research', kind: 'search', adapter_version: '2', output: { channel: 'typed', schema_id: 'nb-search.multi-agent-research@1' } },
] as const);
export type ProviderId = 'exa' | 'grok-multi-agent';
const modelSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/);
const gmaOptions = z.object({ model: modelSchema.default('grok-4.20-multi-agent-xhigh'), reasoning_effort: z.enum(['low', 'medium', 'high', 'xhigh']).default('xhigh'), api_mode: z.enum(['chat_completions', 'messages']).default('chat_completions') }).strict();

export function operation(providerId: string, operationId: string) {
  const found = SUPPORTED_OPERATIONS.find((item) => item.provider_id === providerId && item.operation_id === operationId);
  if (!found) throw appError('VALIDATION_FAILED');
  return found;
}
export function providerOptions(providerId: ProviderId, input: unknown): Record<string, string> {
  const parsed = (providerId === 'exa' ? z.object({}).strict() : gmaOptions).safeParse(input ?? {});
  if (!parsed.success) throw appError('VALIDATION_FAILED');
  return parsed.data;
}
/** Syntax only; the transport independently classifies every resolved address at execution. */
export function providerBase(providerId: ProviderId, value: string | undefined): string {
  if (value === undefined && providerId === 'grok-multi-agent') throw appError('VALIDATION_FAILED');
  const raw = value ?? 'https://api.exa.ai';
  try {
    if (raw !== raw.trim() || raw.length > 2048 || /[\u0000-\u0020\u007f\\]/u.test(raw)) throw new Error();
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.hostname) throw new Error();
    const parts = url.pathname.split('/');
    if (parts.some((part) => /[/%\\]/.test(decodeURIComponent(part)))) throw new Error();
    if (providerId === 'exa' && /\/(search|contents)\/?$/.test(url.pathname)) throw new Error();
    return url.toString().replace(/\/$/, '');
  } catch { throw appError('VALIDATION_FAILED'); }
}
export function endpoint(baseUrl: string, providerId: ProviderId, operationId: string, options: Record<string, string>): string {
  operation(providerId, operationId);
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, '');
  const suffix = providerId === 'exa' ? `/${operationId}` : options['api_mode'] === 'messages' ? '/messages' : '/chat/completions';
  if (providerId === 'grok-multi-agent') {
    const configured = ['/chat/completions', '/messages', '/responses'].find((item) => path.endsWith(item));
    if (configured && configured !== suffix) throw appError('VALIDATION_FAILED');
  }
  url.pathname = path.endsWith(suffix) ? path : `${path}${suffix}`;
  return url.toString();
}
export function modes(kind: Kind, ready: boolean): ('sync' | 'async')[] { return !ready ? [] : kind === 'search' ? ['sync', 'async'] : ['sync']; }
