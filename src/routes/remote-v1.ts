import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { capabilitiesInputSchema, fetchActionInputSchema, searchInputSchema } from '@nb-corp/nb-search';
import { authenticateServiceKey } from '../auth/api-key.js';
import { consumeRateLimit } from '../auth/rate-limit.js';
import { lockTenant, withTransaction } from '../db/transaction.js';
import { AppError } from '../errors.js';
import type { RouteContext } from '../request-context.js';
import { BusinessRejection, ExecutionError } from '../execution/errors.js';
import { ExecutionStore } from '../execution/store.js';
import { capabilities } from '../execution/capabilities.js';
import type { LaneReady } from '../execution/plans.js';
import { cancelView, jobView, runReceipt } from '../execution/projections.js';
import { EgressError, publicUrl } from '../egress/address.js';
import type { Json, Kind, ServicePrincipal } from '../execution/types.js';

export function registerRemoteRoutes(parent: FastifyInstance, context: RouteContext, store: ExecutionStore, ready: LaneReady): void {
  parent.register(async (app) => {
    app.removeContentTypeParser('application/json');
    app.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 1024 * 1024 }, (_request, body, done) => {
      try { done(null, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body as Buffer))); }
      catch { done(new ExecutionError('INVALID_REQUEST')); }
    });
    app.addHook('onRequest', async (request, reply) => {
      reply.header('X-NB-Search-Protocol', '1').header('X-Request-Id', request.requestId).header('Cache-Control', 'no-store');
      if (request.headers['x-nb-search-protocol'] !== undefined && request.headers['x-nb-search-protocol'] !== '1') throw new ExecutionError('PROTOCOL_UNSUPPORTED');
      if (request.headers.cookie !== undefined) throw new ExecutionError('UNAUTHENTICATED');
      if (request.method === 'POST' && !/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) throw new ExecutionError('UNSUPPORTED_MEDIA_TYPE');
    });
    app.setErrorHandler(async (error, request, reply) => { await discardRejectedUpload(request); return wireError(reply, error); });
    app.setNotFoundHandler((_request, reply) => wireError(reply, new ExecutionError('NOT_FOUND')));
    app.post('/capabilities', { bodyLimit: 1024 * 1024 }, async (request) => {
      const parsed = capabilitiesInputSchema.safeParse(request.body);
      if (!parsed.success) throw new ExecutionError('INVALID_REQUEST');
      const principal = await identity(request, context);
      return withTransaction(context.db, async (tx) => { await lockTenant(tx, principal.tenantId); return capabilities(tx, principal, ready); });
    });
    for (const kind of ['search', 'fetch'] as const) app.post(`/${kind}`, { bodyLimit: 1024 * 1024 }, async (request, reply) => {
      const parsed = (kind === 'search' ? searchInputSchema : fetchActionInputSchema).safeParse(request.body);
      if (!parsed.success) throw new ExecutionError('INVALID_REQUEST');
      const input = parsed.data;
      if (kind === 'fetch' && input.action === 'run' && 'source' in input && input.source.kind !== 'url') throw new ExecutionError('INVALID_REQUEST');
      const principal = await identity(request, context);
      if (input.action === 'get') return jobView(context.db.pool, await store.get(principal, kind, input.job_id));
      if (input.action === 'read') return store.read(principal, kind, input.job_id, input.cursor, input.page_size);
      if (input.action === 'cancel') return cancelView(await store.cancel(principal, kind, input.job_id));
      const wire = JSON.parse(JSON.stringify(input)) as Record<string, Json>;
      try {
        if (kind === 'fetch' && 'source' in input && input.source.kind === 'url') {
          try { publicUrl(input.source.url, false); } catch { throw new BusinessRejection('FETCH_BLOCKED', 'Fetch target is not allowed.'); }
        }
        const admitted = await store.admit(principal, kind, wire, request.requestId);
        if (input.execution === 'async') return runReceipt(admitted.job, admitted.reused);
        // Waiting is not execution: client disconnect never replays or refunds the durable job.
        const until = Date.now() + 125_000;
        while (Date.now() < until) {
          if (request.raw.destroyed && !request.raw.complete || reply.raw.destroyed) throw new ExecutionError('UNAVAILABLE');
          const job = await store.get(principal, kind, admitted.job.id);
          if (job.sync_envelope) return job.sync_envelope;
          if (job.state === 'failed' || job.state === 'cancelled') return failed(kind, wire, job.public_error?.code ?? 'INTERNAL', job.public_error?.message ?? 'Execution failed.');
          await delay(50);
        }
        reply.code(504);
        return { error: { code: 'UNAVAILABLE', message: 'Execution response deadline exceeded.', retryable: true } };
      } catch (error) {
        if (error instanceof BusinessRejection) return failed(kind, wire, error.code, error.message);
        throw error;
      }
    });
  }, { prefix: '/v1' });
}
/** Discard, never parse/store, a bounded rejected upload before closing HTTP/1.
 * Closing with ordinary in-flight bytes unread can reset TCP before the error reaches a client.
 * Slow or arbitrarily large uploads still stop after 1 second or 1 MiB + 64 KiB discarded. */
async function discardRejectedUpload(request: FastifyRequest): Promise<void> {
  const stream = request.raw;
  if (stream.complete || stream.destroyed || stream.readableEnded) return;
  await new Promise<void>((resolve) => {
    let discarded = 0, done = false;
    const finish = () => {
      if (done) return; done = true; clearTimeout(timer);
      stream.off('data', data); stream.off('end', finish); stream.off('aborted', finish);
      // Keep the one-shot error listener for an abort/error emitted during subsequent socket closure.
      stream.pause(); resolve();
    };
    const data = (chunk: Buffer) => { discarded += chunk.length; if (discarded > 1_114_112) finish(); };
    const timer = setTimeout(finish, 1000); timer.unref();
    stream.on('data', data); stream.once('end', finish); stream.once('error', finish); stream.once('aborted', finish); stream.resume();
  });
}
async function identity(request: FastifyRequest, context: RouteContext): Promise<ServicePrincipal> {
  const p = await authenticateServiceKey(request, context.db, context.env);
  if (!p.keyId || !p.groupId) throw new ExecutionError('UNAUTHENTICATED');
  await consumeRateLimit(context.db.pool, { scope: 'service', subject: `${p.tenantId}\0${p.userId}`, limit: 120, windowMs: 60_000 });
  return { tenantId: p.tenantId, userId: p.userId, keyId: p.keyId, groupId: p.groupId };
}
function failed(kind: Kind, input: Record<string, Json>, code: string, message: string): Record<string, Json> {
  const asynchronous = input['execution'] === 'async';
  return { schema_version: '3.0', action: 'run', execution: asynchronous ? 'async' : 'sync', status: 'failed', error: { code, message, retryable: false }, hints: [],
    ...(kind === 'fetch' ? { mode: 'fetch', ...(!asynchronous ? { selection: typeof input['pipeline'] === 'string' ? { source: 'pipeline', pipeline: input['pipeline'] } : { source: 'default' }, documents: [], lane_outcomes: [] } : {}) } : {}) };
}
function wireError(reply: FastifyReply, error: unknown): unknown {
  let failure: ExecutionError;
  if (error instanceof ExecutionError) failure = error;
  else if (error instanceof AppError) failure = new ExecutionError(error.code === 'AUTH_REQUIRED' ? 'UNAUTHENTICATED' : error.code === 'RATE_LIMITED' ? 'RATE_LIMITED' : error.code === 'NOT_FOUND' ? 'NOT_FOUND' : error.code === 'GROUP_NOT_ALLOWED' ? 'FORBIDDEN' : error.code === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'INTERNAL', error.retryAfterMs);
  else if (error instanceof EgressError) failure = new ExecutionError('INVALID_REQUEST');
  else {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    failure = new ExecutionError(code === 'FST_ERR_CTP_BODY_TOO_LARGE' ? 'REQUEST_TOO_LARGE' : code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' ? 'UNSUPPORTED_MEDIA_TYPE' : 'INTERNAL');
  }
  // Rejected early/oversized uploads may still have unread bytes. Do not advertise a reusable HTTP/1 socket.
  if (failure.code === 'REQUEST_TOO_LARGE' || !reply.request.raw.complete) reply.header('Connection', 'close');
  if (failure.retryAfterMs !== undefined) reply.header('Retry-After', String(Math.ceil(failure.retryAfterMs / 1000)));
  return reply.code(failure.status).send({ error: { code: failure.code, message: failure.message, retryable: failure.retryable, ...(failure.retryAfterMs !== undefined ? { retry_after_ms: Math.ceil(failure.retryAfterMs) } : {}) } });
}
