import type { QueryExecutor } from '../db/transaction.js';
import { queryOne } from '../db/transaction.js';
import type { JobRow, Json } from './types.js';

export function runReceipt(job: JobRow, reused: boolean): Record<string, Json> {
  const plan = job.first_plan!;
  const base: Record<string, Json> = { schema_version: '3.0', ...(job.kind === 'fetch' ? { mode: 'fetch' } : {}), action: 'run', execution: 'async',
    status: job.state === 'failed' ? 'failed' : 'queued', selection: job.selection, job: { job_id: job.id, state: job.state, created_at: job.created_at.toISOString() }, reused, hints: [] };
  if (job.kind === 'search') { base['channel'] = plan.selected[0]!.output.channel; base['schema_id'] = plan.selected[0]!.output.schema_id; }
  else base['schema_id'] = 'nb-search.fetch@1';
  if (job.state === 'queued' || job.state === 'running') base['poll_after_ms'] = 1000;
  if (job.state === 'failed') base['error'] = { ...job.public_error! };
  return base;
}
export async function jobView(tx: QueryExecutor, job: JobRow): Promise<Record<string, Json>> {
  const base: Record<string, Json> = { schema_version: '3.0', ...(job.kind === 'fetch' ? { mode: 'fetch' } : {}), action: 'get', job_id: job.id, state: job.state,
    cancel_requested: job.cancel_requested_at !== null, created_at: job.created_at.toISOString(), updated_at: job.updated_at.toISOString() };
  if (job.started_at) base['started_at'] = job.started_at.toISOString();
  if (job.completed_at) base['completed_at'] = job.completed_at.toISOString();
  if (job.public_error) base['error'] = { ...job.public_error };
  if (job.state === 'queued' || job.state === 'running') base['poll_after_ms'] = 1000;
  const artifact = await queryOne<{ byte_length: number; sha256: string; expires_at: Date }>(tx, 'SELECT byte_length,sha256,expires_at FROM artifacts WHERE tenant_id=$1 AND job_id=$2 AND expires_at>clock_timestamp()', [job.tenant_id, job.id]);
  if (artifact) base['artifact'] = { media_type: 'application/json', byte_length: artifact.byte_length, sha256: artifact.sha256, expires_at: artifact.expires_at.toISOString() };
  return base;
}
export function cancelView(job: JobRow): Record<string, Json> {
  return { schema_version: '3.0', ...(job.kind === 'fetch' ? { mode: 'fetch' } : {}), action: 'cancel', job_id: job.id, state: job.state, cancel_requested: job.cancel_requested_at !== null };
}
