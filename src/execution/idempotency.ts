import { createHash } from 'node:crypto';
import type { Json, Kind } from './types.js';

/** The caller must parse the public strict input schema before invoking this function. */
export function canonicalContent(kind: Kind, parsed: Record<string, Json>): Buffer {
  if (parsed['action'] !== 'run' || parsed['execution'] !== 'async') throw new Error('ASYNC_RUN_REQUIRED');
  const value = { ...parsed };
  delete value['idempotency_key'];
  if (kind === 'search' && typeof value['query'] === 'string') value['query'] = [value['query']];
  if (kind === 'fetch' && value['representation'] === undefined) value['representation'] = 'markdown';
  return Buffer.from(canonicalJson(value), 'utf8');
}
function canonicalJson(value: Json): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('FINITE_JSON_REQUIRED');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(',')}}`;
}
export function contentHash(bytes: Buffer): Buffer { return createHash('sha256').update(bytes).digest(); }
