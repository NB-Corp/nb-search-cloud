import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { authenticateSession, recheckSessionInTransaction, withAdminTransaction, withSessionTransaction } from '../auth/session.js';
import { canUserBindGroupById } from '../auth/policy.js';
import { lockTenant, queryOne, withTransaction } from '../db/transaction.js';
import { appError, isForeignKeyViolation, isUniqueViolation } from '../errors.js';
import { contextOf, parseBody, safeJsonInteger, sendData, sendRequestError, type Principal } from '../request-context.js';
import { SUPPORTED_OPERATIONS, modes, operation } from '../execution/catalog.js';
import { ProviderService } from '../execution/providers.js';
import { groupLanes, type LaneReady } from '../execution/plans.js';
import type { ExecutionStore } from '../execution/store.js';

const uuid = z.string().uuid();
const idSchema = z.object({ id: uuid }).strict();
const providerCreate = z.object({ name: z.string().trim().min(1).max(100), provider_id: z.enum(['exa', 'grok-multi-agent']), base_url: z.string().max(2048).optional(), options: z.record(z.string(), z.unknown()).optional(), secret: z.string().min(1).max(8192).optional() }).strict();
const providerPatch = providerCreate.omit({ provider_id: true }).partial().extend({ expected_revision: z.number().int().positive(), status: z.enum(['active', 'disabled']).optional(), clear_secret: z.boolean().optional() }).strict();
const laneCreate = z.object({ id: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/), provider_id: uuid, operation_id: z.enum(['search', 'contents', 'research']), latency: z.enum(['fast', 'medium', 'slow']), cost: z.enum(['free', 'cheap', 'expensive']), evidence_groups: z.array(z.string().trim().min(1).max(128)).max(32).default([]) }).strict();
const capabilitiesInput = z.object({ expected_revision: z.number().int().positive(), lanes: z.array(z.object({ lane_id: z.string().min(1).max(256), units_per_query: z.number().int().min(1).max(1_000_000) }).strict()).max(64), default_search_lane: z.string().max(256).nullable(), default_fetch_pipeline: z.string().max(256).nullable(), presets: z.record(z.string().min(1).max(256), z.array(z.string().min(1).max(256)).min(1).max(64)) }).strict();
const pageSchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(25), cursor: z.string().max(2048).optional() }).strict();

export async function readSession<T>(request: FastifyRequest, admin: boolean, fn: (tx: PoolClient, principal: Principal) => Promise<T>): Promise<T> {
  const context = contextOf(request);
  const initial = await authenticateSession(request, context.db, context.env);
  return withTransaction(context.db, async (tx) => {
    await lockTenant(tx, initial.tenantId);
    const current = await recheckSessionInTransaction(tx, request, context.env, initial.tenantId);
    if (admin && current.principal.role !== 'admin') throw appError('ADMIN_REQUIRED');
    return fn(tx, current.principal);
  });
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value); if (!result.success) throw appError('VALIDATION_FAILED'); return result.data;
}
async function audit(tx: PoolClient, principal: Principal, request: FastifyRequest, action: string, type: string, id: string | null, metadata: Record<string, unknown> = {}): Promise<void> {
  await tx.query('INSERT INTO audit_events(id,tenant_id,actor_user_id,action,target_type,target_id,request_id,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [randomUUID(), principal.tenantId, principal.userId, action, type, id, request.requestId, JSON.stringify(metadata)]);
}
function normalize(error: unknown): unknown { return isUniqueViolation(error) ? appError('ALREADY_EXISTS') : isForeignKeyViolation(error) ? appError('VALIDATION_FAILED') : error; }
function cursor(value: string | undefined): [string, string] | null {
  if (!value) return null;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString());
    return parse(z.tuple([z.string().datetime(), uuid]), decoded);
  } catch { throw appError('VALIDATION_FAILED'); }
}

export function registerAdminExecutionRoutes(app: FastifyInstance, providers: ProviderService, store: ExecutionStore, ready: LaneReady): void {
  app.get('/api/admin/providers/catalog', async (request, reply) => {
    try { return sendData(reply, await readSession(request, true, async () => ({ operations: SUPPORTED_OPERATIONS, provider_options: { exa: {}, 'grok-multi-agent': { model: 'string', reasoning_effort: ['low', 'medium', 'high', 'xhigh'], api_mode: ['chat_completions', 'messages'] } }, credential_write_only: true }))); }
    catch (error) { return sendRequestError(reply, error); }
  });
  app.get('/api/admin/providers', async (request, reply) => {
    try {
      const input = parse(pageSchema, request.query); const after = cursor(input.cursor);
      return sendData(reply, await readSession(request, true, async (tx, p) => {
        const rows = await tx.query<{ id: string; created_at: Date }>('SELECT id,created_at FROM providers WHERE tenant_id=$1 AND deleted_at IS NULL AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT $4', [p.tenantId, after?.[0] ?? null, after?.[1] ?? null, input.limit + 1]);
        const shown = rows.rows.slice(0, input.limit);
        const items = await Promise.all(shown.map((row) => providers.get(tx, p.tenantId, row.id)));
        const last = shown.at(-1);
        return { items, ...(rows.rows.length > input.limit && last ? { next_cursor: Buffer.from(JSON.stringify([last.created_at.toISOString(), last.id])).toString('base64url') } : {}) };
      }));
    } catch (error) { return sendRequestError(reply, error); }
  });
  app.post('/api/admin/providers', async (request, reply) => {
    try {
      const input = parseBody(providerCreate, request);
      const result = await withAdminTransaction(request, contextOf(request), async (tx, p) => {
        const result = await providers.create(tx, p.tenantId, input); await audit(tx, p, request, 'provider.create', 'provider', String(result['id'])); return result;
      });
      return sendData(reply, result, 201);
    } catch (error) { return sendRequestError(reply, normalize(error)); }
  });
  app.get('/api/admin/providers/:id', async (request, reply) => {
    try { const { id } = parse(idSchema, request.params); return sendData(reply, await readSession(request, true, (tx, p) => providers.get(tx, p.tenantId, id))); }
    catch (error) { return sendRequestError(reply, error); }
  });
  app.patch('/api/admin/providers/:id', async (request, reply) => {
    try {
      const { id } = parse(idSchema, request.params); const input = parseBody(providerPatch, request);
      return sendData(reply, await withAdminTransaction(request, contextOf(request), async (tx, p) => { const result = await providers.patch(tx, p.tenantId, id, input); await audit(tx, p, request, 'provider.update', 'provider', id); return result; }));
    } catch (error) { return sendRequestError(reply, normalize(error)); }
  });
  app.delete('/api/admin/providers/:id', async (request, reply) => {
    try {
      const { id } = parse(idSchema, request.params); parseBody(z.object({}).strict().optional(), request);
      return sendData(reply, await withAdminTransaction(request, contextOf(request), async (tx, p) => { const result = await providers.remove(tx, p.tenantId, id); await audit(tx, p, request, 'provider.delete', 'provider', id); return result; }));
    } catch (error) { return sendRequestError(reply, error); }
  });
  app.get('/api/admin/lanes', async (request, reply) => {
    try {
      return sendData(reply, await readSession(request, true, async (tx, p) => {
        const rows = await tx.query('SELECT id,kind,provider_id,operation_id,status,latency,cost,evidence_groups,created_at,updated_at FROM lanes WHERE tenant_id=$1 ORDER BY id', [p.tenantId]);
        return { items: rows.rows };
      }));
    } catch (error) { return sendRequestError(reply, error); }
  });
  app.post('/api/admin/lanes', async (request, reply) => {
    try {
      const input = parseBody(laneCreate, request);
      return sendData(reply, await withAdminTransaction(request, contextOf(request), async (tx, p) => {
        const provider = await providers.row(tx, p.tenantId, input.provider_id); const descriptor = operation(provider.provider_id, input.operation_id);
        const result = await tx.query('INSERT INTO lanes(tenant_id,id,kind,provider_id,operation_id,latency,cost,evidence_groups) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,kind,provider_id,operation_id,status,latency,cost,evidence_groups', [p.tenantId, input.id, descriptor.kind, input.provider_id, input.operation_id, input.latency, input.cost, JSON.stringify(input.evidence_groups)]);
        await audit(tx, p, request, 'lane.create', 'lane', null, { lane_id: input.id }); return result.rows[0];
      }), 201);
    } catch (error) { return sendRequestError(reply, normalize(error)); }
  });
  app.patch('/api/admin/lanes/:id', async (request, reply) => {
    try {
      const { id } = parse(z.object({ id: z.string().min(1).max(256) }).strict(), request.params); const input = parseBody(z.object({ status: z.enum(['active', 'disabled']) }).strict(), request);
      return sendData(reply, await withAdminTransaction(request, contextOf(request), async (tx, p) => {
        const row = await queryOne(tx, 'UPDATE lanes SET status=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING id,kind,provider_id,operation_id,status,latency,cost,evidence_groups', [p.tenantId, id, input.status]);
        if (!row) throw appError('NOT_FOUND'); await audit(tx, p, request, 'lane.update', 'lane', null, { lane_id: id }); return row;
      }));
    } catch (error) { return sendRequestError(reply, error); }
  });
  app.get('/api/admin/groups/:id/capabilities', async (request, reply) => {
    try {
      const { id } = parse(idSchema, request.params);
      return sendData(reply, await readSession(request, false, async (tx, p) => {
        if (p.role !== 'admin' && !await canUserBindGroupById(tx, p.tenantId, p.userId, id)) throw appError('NOT_FOUND');
        return groupCapabilities(tx, p.tenantId, id, ready);
      }));
    } catch (error) { return sendRequestError(reply, error); }
  });
  app.put('/api/admin/groups/:id/capabilities', async (request, reply) => {
    try {
      const { id } = parse(idSchema, request.params); const input = parseBody(capabilitiesInput, request);
      return sendData(reply, await withAdminTransaction(request, contextOf(request), async (tx, p) => {
        const group = await queryOne<{ revision: string }>(tx, 'SELECT revision FROM groups WHERE tenant_id=$1 AND id=$2 AND deleted_at IS NULL', [p.tenantId, id]);
        if (!group) throw appError('NOT_FOUND'); if (Number(group.revision) !== input.expected_revision) throw appError('STALE_VERSION');
        if (new Set(input.lanes.map((lane) => lane.lane_id)).size !== input.lanes.length || Object.keys(input.presets).length > 32) throw appError('VALIDATION_FAILED');
        const selected = new Map<string, ReturnType<typeof operation>>();
        for (const lane of input.lanes) {
          const row = await queryOne<{ provider_kind: string; operation_id: string }>(tx, 'SELECT p.provider_id AS provider_kind,l.operation_id FROM lanes l JOIN providers p ON p.tenant_id=l.tenant_id AND p.id=l.provider_id WHERE l.tenant_id=$1 AND l.id=$2 AND p.deleted_at IS NULL', [p.tenantId, lane.lane_id]);
          if (!row) throw appError('VALIDATION_FAILED'); selected.set(lane.lane_id, operation(row.provider_kind, row.operation_id));
        }
        if (input.default_search_lane !== null && selected.get(input.default_search_lane)?.kind !== 'search' || input.default_fetch_pipeline !== null && selected.get(input.default_fetch_pipeline)?.kind !== 'fetch') throw appError('VALIDATION_FAILED');
        for (const ids of Object.values(input.presets)) if (new Set(ids).size !== ids.length || ids.some((lane) => selected.get(lane)?.kind !== 'search' || selected.get(lane)?.output.channel !== 'results')) throw appError('VALIDATION_FAILED');
        await tx.query('DELETE FROM group_lanes WHERE tenant_id=$1 AND group_id=$2', [p.tenantId, id]);
        for (const lane of input.lanes) await tx.query('INSERT INTO group_lanes(tenant_id,group_id,lane_id,units_per_query) VALUES($1,$2,$3,$4)', [p.tenantId, id, lane.lane_id, lane.units_per_query]);
        await tx.query('UPDATE groups SET default_search_lane=$3,default_fetch_pipeline=$4,presets=$5,revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2', [p.tenantId, id, input.default_search_lane, input.default_fetch_pipeline, JSON.stringify(input.presets)]);
        await audit(tx, p, request, 'group.capabilities.replace', 'group', id);
        return groupCapabilities(tx, p.tenantId, id, ready);
      }));
    } catch (error) { return sendRequestError(reply, normalize(error)); }
  });
  app.post('/api/admin/keys/:id/reset-quota', async (request, reply) => {
    try {
      const { id } = parse(idSchema, request.params); const input = parseBody(z.object({ expected_revision: z.number().int().positive() }).strict(), request);
      return sendData(reply, await withSessionTransaction(request, contextOf(request), async (tx, p) => {
        const key = await queryOne<{ user_id: string }>(tx, 'SELECT user_id FROM api_keys WHERE tenant_id=$1 AND id=$2 AND deleted_at IS NULL', [p.tenantId, id]);
        if (!key || key.user_id !== p.userId && p.role !== 'admin') throw appError('NOT_FOUND');
        await store.resetKeyQuota(tx, p.tenantId, id, input.expected_revision); await audit(tx, p, request, 'key.quota.reset', 'api_key', id);
        return { id, reset: true, revision: input.expected_revision + 1, usage: { used_units: 0, reserved_units: 0 } };
      }));
    } catch (error) { return sendRequestError(reply, error); }
  });
}
async function groupCapabilities(tx: PoolClient, tenantId: string, id: string, ready: LaneReady): Promise<Record<string, unknown>> {
  const group = await queryOne<{ revision: string; default_search_lane: string | null; default_fetch_pipeline: string | null; presets: unknown }>(tx, 'SELECT revision,default_search_lane,default_fetch_pipeline,presets FROM groups WHERE tenant_id=$1 AND id=$2 AND deleted_at IS NULL', [tenantId, id]);
  if (!group) throw appError('NOT_FOUND');
  const lanes = await groupLanes(tx, tenantId, id);
  return { group_id: id, revision: safeJsonInteger(group.revision), default_search_lane: group.default_search_lane, default_fetch_pipeline: group.default_fetch_pipeline, presets: group.presets,
    lanes: lanes.map((lane) => { const configured = lane.status === 'active' && lane.provider_status === 'active' && !lane.provider_deleted_at && ready(lane); return { lane_id: lane.id, kind: lane.kind, units_per_query: lane.units_per_query, output: operation(lane.provider_kind, lane.operation_id).output, configured, effective_execution_modes: modes(lane.kind, configured), ...(!configured ? { issues: [{ code: 'CLOUD_EGRESS_UNVERIFIED' }] } : {}) }; }) };
}
