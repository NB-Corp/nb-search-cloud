import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { DbHandle } from '../db/client.js';
import { lockTenant, queryOne, withTransaction } from '../db/transaction.js';
import { appError } from '../errors.js';
import { canonicalContent, contentHash } from './idempotency.js';
import { ExecutionError } from './errors.js';
import { currentIdentity, jobAccess, type JobPrincipal } from './policy.js';
import { buildPlan, type LaneReady } from './plans.js';
import { LIMITS, failure, jsonBytes, type JobRow, type JobState, type Json, type Kind, type SafeFailure, type ServicePrincipal } from './types.js';

interface Reservation { job_id: string; tenant_id: string; user_id: string; group_id: string; key_id: string; utc_day: string; key_epoch: number; units: string; state: 'reserved' | 'settled' | 'released' }
interface Bucket { reserved_units: string; used_units: string }
export interface Completion { state: 'succeeded' | 'failed' | 'cancelled'; envelope: Record<string, Json>; artifact?: Json; error?: SafeFailure }
export class ExecutionStore {
  constructor(readonly db: DbHandle, readonly sdkVersion: string, private readonly ready: LaneReady) {}

  async admit(principal: ServicePrincipal, kind: Kind, wire: Record<string, Json>, requestId: string): Promise<{ job: JobRow; reused: boolean }> {
    const asynchronous = wire['execution'] === 'async';
    const canonical = asynchronous ? canonicalContent(kind, wire) : undefined;
    return withTransaction(this.db, async (tx) => {
      await lockTenant(tx, principal.tenantId);
      const identity = await currentIdentity(tx, principal);
      if (asynchronous) {
        const prior = await queryOne<{ job_id: string; canonical_content: Buffer }>(tx, 'SELECT job_id,canonical_content FROM idempotency_admissions WHERE tenant_id=$1 AND user_id=$2 AND kind=$3 AND key=$4', [principal.tenantId, principal.userId, kind, wire['idempotency_key']]);
        if (prior) {
          const job = await this.row(tx, principal.tenantId, prior.job_id);
          if (job.expires_at && job.expires_at.getTime() <= Date.now()) await this.purgeOne(tx, job);
          else {
            // A hash is an index aid only: never let a collision alias different content.
            if (!prior.canonical_content.equals(canonical!)) throw new ExecutionError('CONFLICT');
            await jobAccess(tx, principal, job, true);
            return { job, reused: true };
          }
        }
      }
      const plan = await buildPlan(tx, principal.tenantId, identity.group, kind, wire, this.sdkVersion, this.ready);
      const count = await queryOne<{ tenant_count: string; user_count: string }>(tx, "SELECT count(*)::text AS tenant_count,count(*) FILTER(WHERE user_id=$2)::text AS user_count FROM jobs WHERE tenant_id=$1 AND state IN ('queued','running')", [principal.tenantId, principal.userId]);
      if (Number(count!.tenant_count) >= LIMITS.tenantActive || Number(count!.user_count) >= LIMITS.userActive) throw new ExecutionError('RATE_LIMITED', 1000);
      const now = (await queryOne<{ at: Date }>(tx, 'SELECT now() AS at'))!.at;
      const day = now.toISOString().slice(0, 10);
      const keyEpoch = identity.key.quota_epoch;
      await tx.query('INSERT INTO group_usage_buckets(tenant_id,user_id,group_id,utc_day) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [principal.tenantId, principal.userId, identity.group.id, day]);
      await tx.query('INSERT INTO key_usage_buckets(tenant_id,key_id,epoch) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [principal.tenantId, principal.keyId, keyEpoch]);
      const groupBucket = (await queryOne<Bucket>(tx, 'SELECT reserved_units,used_units FROM group_usage_buckets WHERE tenant_id=$1 AND user_id=$2 AND group_id=$3 AND utc_day=$4 FOR UPDATE', [principal.tenantId, principal.userId, identity.group.id, day]))!;
      const keyBucket = (await queryOne<Bucket>(tx, 'SELECT reserved_units,used_units FROM key_usage_buckets WHERE tenant_id=$1 AND key_id=$2 AND epoch=$3 FOR UPDATE', [principal.tenantId, principal.keyId, keyEpoch]))!;
      const units = BigInt(plan.budget.units);
      // A lifetime key quota has no predictable reset time; do not invent Retry-After.
      if (exhausted(identity.key.quota_units, keyBucket, units)) throw new ExecutionError('RATE_LIMITED');
      if (exhausted(identity.group.daily_units_per_user, groupBucket, units)) throw new ExecutionError('RATE_LIMITED', Date.parse(`${day}T00:00:00.000Z`) + 86_400_000 - now.getTime());
      await tx.query('UPDATE group_usage_buckets SET reserved_units=reserved_units+$5 WHERE tenant_id=$1 AND user_id=$2 AND group_id=$3 AND utc_day=$4', [principal.tenantId, principal.userId, identity.group.id, day, units.toString()]);
      await tx.query('UPDATE key_usage_buckets SET reserved_units=reserved_units+$4 WHERE tenant_id=$1 AND key_id=$2 AND epoch=$3', [principal.tenantId, principal.keyId, keyEpoch, units.toString()]);
      const id = randomUUID();
      const job = (await queryOne<JobRow>(tx, 'INSERT INTO jobs(id,tenant_id,user_id,group_id,admitting_key_id,kind,delivery,first_plan,selection,request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *', [id, principal.tenantId, principal.userId, identity.group.id, principal.keyId, kind, plan.delivery, JSON.stringify(plan), JSON.stringify(plan.selection), requestId]))!;
      for (const configId of new Set(plan.selected.map((item) => item.provider_config_id))) await tx.query('INSERT INTO job_config_refs(tenant_id,job_id,config_id) VALUES($1,$2,$3)', [principal.tenantId, id, configId]);
      await tx.query('INSERT INTO usage_reservations(job_id,tenant_id,user_id,group_id,key_id,utc_day,key_epoch,units) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [id, principal.tenantId, principal.userId, identity.group.id, principal.keyId, day, keyEpoch, units.toString()]);
      await tx.query("INSERT INTO usage_events(id,tenant_id,user_id,group_id,key_id,job_id,event,units,utc_day,key_epoch,request_id,safe_reason) VALUES($1,$2,$3,$4,$5,$6,'reserve',$7,$8,$9,$10,'admitted')", [randomUUID(), principal.tenantId, principal.userId, identity.group.id, principal.keyId, id, units.toString(), day, keyEpoch, requestId]);
      if (asynchronous) await tx.query('INSERT INTO idempotency_admissions(tenant_id,user_id,kind,key,canonical_content,content_sha256,job_id) VALUES($1,$2,$3,$4,$5,$6,$7)', [principal.tenantId, principal.userId, kind, wire['idempotency_key'], canonical, contentHash(canonical!), id]);
      return { job, reused: false };
    });
  }

  async get(principal: JobPrincipal, kind: Kind, id: string): Promise<JobRow> {
    return withTransaction(this.db, async (tx) => {
      await lockTenant(tx, principal.tenantId);
      const job = await this.row(tx, principal.tenantId, id);
      if (job.kind !== kind) throw new ExecutionError('NOT_FOUND');
      await jobAccess(tx, principal, job, false);
      return job;
    });
  }
  async cancel(principal: JobPrincipal, kind: Kind, id: string): Promise<JobRow> {
    return withTransaction(this.db, async (tx) => {
      await lockTenant(tx, principal.tenantId);
      let job = await this.row(tx, principal.tenantId, id);
      if (job.kind !== kind) throw new ExecutionError('NOT_FOUND');
      await jobAccess(tx, principal, job, false);
      if (!active(job.state)) return job;
      job = (await queryOne<JobRow>(tx, 'UPDATE jobs SET cancel_requested_at=coalesce(cancel_requested_at,now()),updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *', [principal.tenantId, id]))!;
      if (job.state === 'queued') job = await this.finish(tx, job, 'cancelled', failure('CANCELLED'), undefined, 'cancel_before_dispatch');
      return job;
    });
  }

  async claim(): Promise<JobRow | undefined> {
    return withTransaction(this.db, async (tx) => {
      const tenant = await queryOne<{ id: string }>(tx, `SELECT t.id FROM tenants t WHERE EXISTS(SELECT 1 FROM jobs j WHERE j.tenant_id=t.id AND j.state='queued')
        ORDER BY (SELECT min(created_at) FROM jobs j WHERE j.tenant_id=t.id AND j.state='queued') FOR UPDATE OF t SKIP LOCKED LIMIT 1`);
      if (!tenant) return undefined;
      const job = await queryOne<JobRow>(tx, "SELECT * FROM jobs WHERE tenant_id=$1 AND state='queued' ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1", [tenant.id]);
      if (!job) return undefined;
      if (Date.now() - job.created_at.getTime() > LIMITS.queueMs) { await this.finish(tx, job, 'failed', failure('WORKER_START_FAILED'), undefined, 'queue_timeout'); return undefined; }
      return queryOne<JobRow>(tx, "UPDATE jobs SET state='running',started_at=now(),updated_at=now(),lease_owner=$3,lease_expires_at=now()+interval '30 seconds',claim_count=claim_count+1 WHERE tenant_id=$1 AND id=$2 RETURNING *", [tenant.id, job.id, randomUUID()]);
    });
  }
  async heartbeat(job: Pick<JobRow, 'id' | 'tenant_id' | 'lease_owner'>): Promise<{ valid: boolean; cancelled: boolean }> {
    const row = await queryOne<{ cancel_requested_at: Date | null }>(this.db.pool, "UPDATE jobs SET lease_expires_at=now()+interval '30 seconds',updated_at=now() WHERE tenant_id=$1 AND id=$2 AND lease_owner=$3 AND state='running' AND lease_expires_at>now() RETURNING cancel_requested_at", [job.tenant_id, job.id, job.lease_owner]);
    return { valid: !!row, cancelled: row?.cancel_requested_at != null };
  }
  async markDispatch(claimed: JobRow): Promise<JobRow | undefined> {
    return withTransaction(this.db, async (tx) => {
      await lockTenant(tx, claimed.tenant_id);
      const job = await this.row(tx, claimed.tenant_id, claimed.id);
      if (!validLease(job, claimed.lease_owner) || job.dispatch_started_at) return undefined;
      if (job.cancel_requested_at) { await this.finish(tx, job, 'cancelled', failure('CANCELLED'), undefined, 'cancel_before_dispatch'); return undefined; }
      try { await jobAccess(tx, owner(job), job, true); }
      catch (error) {
        if (!(error instanceof ExecutionError)) throw error;
        await this.finish(tx, job, 'failed', failure('WORKER_START_FAILED'), undefined, 'permission_revoked'); return undefined;
      }
      return queryOne<JobRow>(tx, 'UPDATE jobs SET dispatch_started_at=now(),updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *', [job.tenant_id, job.id]);
    });
  }
  async failPreparation(claimed: JobRow): Promise<void> {
    await withTransaction(this.db, async (tx) => {
      await lockTenant(tx, claimed.tenant_id);
      const job = await this.row(tx, claimed.tenant_id, claimed.id);
      if (validLease(job, claimed.lease_owner) && !job.dispatch_started_at) await this.finish(tx, job, 'failed', failure('WORKER_START_FAILED'), undefined, 'worker_start_failed');
    });
  }
  async complete(claimed: JobRow, result: Completion): Promise<boolean> {
    return withTransaction(this.db, async (tx) => {
      await lockTenant(tx, claimed.tenant_id);
      const job = await this.row(tx, claimed.tenant_id, claimed.id);
      if (!validLease(job, claimed.lease_owner) || !job.dispatch_started_at) return false;
      let state = result.state;
      let error = result.error;
      let artifact = result.artifact;
      if (job.cancel_requested_at) { state = 'cancelled'; error = failure('CANCELLED'); artifact = undefined; }
      const bytes = artifact === undefined ? undefined : jsonBytes(artifact);
      if (bytes && bytes.length > LIMITS.artifactBytes) { state = 'failed'; error = failure('OUTPUT_TOO_LARGE'); artifact = undefined; }
      const overridden = state !== result.state || error !== result.error;
      const envelope = job.delivery !== 'sync' ? undefined : !overridden ? result.envelope : {
        schema_version: '3.0', action: 'run', execution: 'sync', status: state === 'cancelled' ? 'cancelled' : 'failed',
        error: { ...error! }, hints: [], selection: job.selection,
        ...(job.kind === 'fetch' ? { mode: 'fetch', documents: [], lane_outcomes: [] } : {}),
      } satisfies Record<string, Json>;
      const final = await this.finish(tx, job, state, error, envelope, job.cancel_requested_at ? 'cancel_after_dispatch' : 'completed');
      if (state === 'succeeded' && artifact !== undefined) {
        const output = jsonBytes(artifact);
        await tx.query('INSERT INTO artifacts(job_id,tenant_id,byte_length,sha256,expires_at) VALUES($1,$2,$3,$4,$5)', [job.id, job.tenant_id, output.length, createHash('sha256').update(output).digest('hex'), final.expires_at]);
        for (let offset = 0, index = 0; offset < output.length; offset += LIMITS.chunkBytes, index++) {
          const chunk = output.subarray(offset, offset + LIMITS.chunkBytes);
          await tx.query('INSERT INTO artifact_chunks(tenant_id,job_id,index,"offset",byte_length,data) VALUES($1,$2,$3,$4,$5,$6)', [job.tenant_id, job.id, index, offset, chunk.length, chunk]);
        }
      }
      return true;
    });
  }

  async reconcile(): Promise<number> {
    const candidates = await this.db.pool.query<{ id: string; tenant_id: string }>("SELECT id,tenant_id FROM jobs WHERE (state='running' AND lease_expires_at<=now()) OR (state='queued' AND created_at<now()-interval '300 seconds') ORDER BY created_at LIMIT 100");
    let changed = 0;
    for (const item of candidates.rows) await withTransaction(this.db, async (tx) => {
      await lockTenant(tx, item.tenant_id);
      const job = await this.row(tx, item.tenant_id, item.id);
      if (!active(job.state) || (job.state === 'running' && job.lease_expires_at && job.lease_expires_at.getTime() > Date.now())) return;
      // A concurrent reconciler may already have safely requeued this claim.
      if (job.state === 'queued' && Date.now() - job.created_at.getTime() < LIMITS.queueMs) return;
      if (job.dispatch_started_at) await this.finish(tx, job, 'failed', failure('WORKER_LOST'), undefined, 'dispatch_unknown');
      else if (job.cancel_requested_at) await this.finish(tx, job, 'cancelled', failure('CANCELLED'), undefined, 'cancel_before_dispatch');
      else if (job.state === 'queued' || job.claim_count >= 2 || Date.now() - job.created_at.getTime() >= LIMITS.queueMs) await this.finish(tx, job, 'failed', failure('WORKER_START_FAILED'), undefined, 'worker_start_failed');
      else await tx.query("UPDATE jobs SET state='queued',lease_owner=NULL,lease_expires_at=NULL,started_at=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2", [job.tenant_id, job.id]);
      changed++;
    });
    return changed;
  }

  async read(principal: JobPrincipal, kind: Kind, id: string, cursor?: string, pageSize = 25): Promise<Record<string, Json>> {
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new ExecutionError('INVALID_REQUEST');
    return withTransaction(this.db, async (tx) => {
      await lockTenant(tx, principal.tenantId);
      const job = await this.row(tx, principal.tenantId, id);
      if (job.kind !== kind) throw new ExecutionError('NOT_FOUND');
      await jobAccess(tx, principal, job, false);
      const artifact = await queryOne<{ media_type: string; byte_length: number; sha256: string; expires_at: Date }>(tx, 'SELECT * FROM artifacts WHERE tenant_id=$1 AND job_id=$2 AND expires_at>clock_timestamp()', [principal.tenantId, id]);
      const base: Record<string, Json> = { schema_version: '3.0', ...(kind === 'fetch' ? { mode: 'fetch' } : {}), action: 'read', job_id: id, state: job.state, chunks: [] };
      if (!artifact) { if (cursor) throw new ExecutionError('INVALID_REQUEST'); return base; }
      let nextIndex = 0;
      if (cursor) {
        try {
          if (cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor) || Buffer.from(cursor, 'base64url').toString('base64url') !== cursor) throw new Error();
          const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(cursor, 'base64url'))) as Record<string, unknown>;
          if (Object.keys(parsed).sort().join(',') !== 'job_id,next_index,sha256,v' || parsed['v'] !== 1 || parsed['job_id'] !== id || parsed['sha256'] !== artifact.sha256 || !Number.isSafeInteger(parsed['next_index']) || Number(parsed['next_index']) < 0 || Number(parsed['next_index']) >= Math.ceil(artifact.byte_length / LIMITS.chunkBytes)) throw new Error();
          nextIndex = Number(parsed['next_index']);
        } catch { throw new ExecutionError('INVALID_REQUEST'); }
      }
      const chunks = await tx.query<{ index: number; offset: number; byte_length: number; data: Buffer }>('SELECT index,"offset",byte_length,data FROM artifact_chunks WHERE tenant_id=$1 AND job_id=$2 AND index>=$3 ORDER BY index LIMIT $4', [principal.tenantId, id, nextIndex, pageSize + 1]);
      if (!chunks.rows.length || chunks.rows[0]!.index !== nextIndex) throw new ExecutionError('INVALID_REQUEST');
      const shown = chunks.rows.slice(0, pageSize);
      base['artifact'] = { media_type: 'application/json', byte_length: artifact.byte_length, sha256: artifact.sha256, expires_at: artifact.expires_at.toISOString() };
      base['chunks'] = shown.map((chunk) => ({ index: chunk.index, offset: chunk.offset, byte_length: chunk.byte_length, data_base64: chunk.data.toString('base64') }));
      if (chunks.rows.length > pageSize) base['next_cursor'] = Buffer.from(JSON.stringify({ v: 1, job_id: id, sha256: artifact.sha256, next_index: shown.at(-1)!.index + 1 })).toString('base64url');
      return base;
    });
  }

  async resetKeyQuota(tx: PoolClient, tenantId: string, keyId: string, expectedRevision: number): Promise<void> {
    const key = await queryOne<{ revision: string; quota_epoch: number }>(tx, 'SELECT revision,quota_epoch FROM api_keys WHERE tenant_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE', [tenantId, keyId]);
    if (!key) throw appError('NOT_FOUND');
    if (Number(key.revision) !== expectedRevision) throw appError('STALE_VERSION');
    if (await queryOne(tx, "SELECT job_id FROM usage_reservations WHERE tenant_id=$1 AND key_id=$2 AND state='reserved' LIMIT 1", [tenantId, keyId])) throw appError('ACTIVE_RESERVATIONS');
    await tx.query('UPDATE api_keys SET quota_epoch=quota_epoch+1,revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2', [tenantId, keyId]);
    await tx.query('INSERT INTO key_usage_buckets(tenant_id,key_id,epoch) VALUES($1,$2,$3)', [tenantId, keyId, key.quota_epoch + 1]);
  }

  async cleanup(): Promise<number> {
    const candidates = await this.db.pool.query<{ id: string; tenant_id: string }>('SELECT id,tenant_id FROM jobs WHERE expires_at<=now() AND purged_at IS NULL LIMIT 100');
    for (const item of candidates.rows) await withTransaction(this.db, async (tx) => {
      await lockTenant(tx, item.tenant_id);
      const job = await queryOne<JobRow>(tx, 'SELECT * FROM jobs WHERE tenant_id=$1 AND id=$2', [item.tenant_id, item.id]);
      if (job) await this.purgeOne(tx, job);
    });
    const tenants = await this.db.pool.query<{ id: string }>(`SELECT t.id FROM tenants t WHERE EXISTS(SELECT 1 FROM jobs j WHERE j.tenant_id=t.id AND j.purged_at IS NOT NULL AND j.completed_at<now()-interval '90 days') OR EXISTS(SELECT 1 FROM provider_configs c WHERE c.tenant_id=t.id AND c.created_at<now()-interval '72 hours') LIMIT 100`);
    for (const tenant of tenants.rows) await withTransaction(this.db, async (tx) => {
      await lockTenant(tx, tenant.id);
      const old = await tx.query<{ id: string }>("SELECT id FROM jobs WHERE tenant_id=$1 AND purged_at IS NOT NULL AND completed_at<now()-interval '90 days' LIMIT 100", [tenant.id]);
      for (const job of old.rows) {
        await tx.query('DELETE FROM usage_events WHERE tenant_id=$1 AND job_id=$2', [tenant.id, job.id]);
        await tx.query("DELETE FROM usage_reservations WHERE tenant_id=$1 AND job_id=$2 AND state<>'reserved'", [tenant.id, job.id]);
        await tx.query('DELETE FROM jobs WHERE tenant_id=$1 AND id=$2', [tenant.id, job.id]);
      }
      // Cumulative key buckets survive ledger retention; do not silently forgive old usage.
      await tx.query("UPDATE providers SET current_config_id=NULL WHERE tenant_id=$1 AND deleted_at<now()-interval '72 hours' AND current_config_id IS NOT NULL", [tenant.id]);
      await tx.query(`DELETE FROM provider_configs c WHERE c.tenant_id=$1 AND c.created_at<now()-interval '72 hours'
        AND NOT EXISTS(SELECT 1 FROM providers p WHERE p.tenant_id=c.tenant_id AND p.current_config_id=c.id)
        AND NOT EXISTS(SELECT 1 FROM job_config_refs r WHERE r.tenant_id=c.tenant_id AND r.config_id=c.id)`, [tenant.id]);
    });
    return candidates.rows.length;
  }
  async row(tx: PoolClient, tenantId: string, id: string): Promise<JobRow> {
    const job = await queryOne<JobRow>(tx, 'SELECT * FROM jobs WHERE tenant_id=$1 AND id=$2', [tenantId, id]);
    if (!job) throw new ExecutionError('NOT_FOUND');
    return job;
  }
  private async purgeOne(tx: PoolClient, job: JobRow): Promise<void> {
    if (!job.expires_at || job.expires_at.getTime() > Date.now() || job.purged_at) return;
    await tx.query('DELETE FROM artifact_chunks WHERE tenant_id=$1 AND job_id=$2', [job.tenant_id, job.id]);
    await tx.query('DELETE FROM artifacts WHERE tenant_id=$1 AND job_id=$2', [job.tenant_id, job.id]);
    await tx.query('DELETE FROM idempotency_admissions WHERE tenant_id=$1 AND job_id=$2', [job.tenant_id, job.id]);
    await tx.query('DELETE FROM job_config_refs WHERE tenant_id=$1 AND job_id=$2', [job.tenant_id, job.id]);
    await tx.query('UPDATE jobs SET first_plan=NULL,sync_envelope=NULL,purged_at=now() WHERE tenant_id=$1 AND id=$2', [job.tenant_id, job.id]);
  }
  private async finish(tx: PoolClient, job: JobRow, state: Exclude<JobState, 'queued' | 'running'>, error?: SafeFailure, envelope?: Record<string, Json>, reason = 'completed'): Promise<JobRow> {
    const result = (await queryOne<JobRow>(tx, 'UPDATE jobs SET state=$3,public_error=$4,sync_envelope=$5,completed_at=now(),expires_at=now()+interval \'72 hours\',updated_at=now(),lease_owner=NULL,lease_expires_at=NULL WHERE tenant_id=$1 AND id=$2 RETURNING *', [job.tenant_id, job.id, state, error ? JSON.stringify(error) : null, envelope ? JSON.stringify(envelope) : null]))!;
    const reservation = await queryOne<Reservation>(tx, "SELECT *,utc_day::text AS utc_day FROM usage_reservations WHERE job_id=$1 AND state='reserved' FOR UPDATE", [job.id]);
    if (reservation) {
      const charged = job.dispatch_started_at !== null;
      const values = [reservation.tenant_id, reservation.user_id, reservation.group_id, reservation.utc_day, reservation.units, charged ? reservation.units : '0'];
      await tx.query('UPDATE group_usage_buckets SET reserved_units=reserved_units-$5,used_units=used_units+$6 WHERE tenant_id=$1 AND user_id=$2 AND group_id=$3 AND utc_day=$4', values);
      await tx.query('UPDATE key_usage_buckets SET reserved_units=reserved_units-$4,used_units=used_units+$5 WHERE tenant_id=$1 AND key_id=$2 AND epoch=$3', [reservation.tenant_id, reservation.key_id, reservation.key_epoch, reservation.units, charged ? reservation.units : '0']);
      await tx.query('UPDATE usage_reservations SET state=$2,reason=$3,settled_at=now() WHERE job_id=$1', [job.id, charged ? 'settled' : 'released', reason]);
      await tx.query('INSERT INTO usage_events(id,tenant_id,user_id,group_id,key_id,job_id,event,units,utc_day,key_epoch,request_id,safe_reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [randomUUID(), reservation.tenant_id, reservation.user_id, reservation.group_id, reservation.key_id, job.id, charged ? 'settle' : 'release', reservation.units, reservation.utc_day, reservation.key_epoch, job.request_id, reason]);
    }
    return result;
  }
}
function exhausted(limit: string | number, bucket: Bucket, requested: bigint): boolean { const quota = BigInt(limit); return quota !== 0n && BigInt(bucket.used_units) + BigInt(bucket.reserved_units) + requested > quota; }
function active(state: JobState): boolean { return state === 'queued' || state === 'running'; }
function validLease(job: JobRow, token: string | null): boolean { return token !== null && job.state === 'running' && job.lease_owner === token && job.lease_expires_at !== null && job.lease_expires_at.getTime() > Date.now(); }
function owner(job: JobRow): ServicePrincipal { return { tenantId: job.tenant_id, userId: job.user_id, keyId: job.admitting_key_id, groupId: job.group_id }; }
