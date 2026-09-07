import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { createDb, type DbHandle } from './db/client.js';
import { loadEnv, type CloudEnv } from './env.js';
import { AppError, appError, errorBody } from './errors.js';
import { createSafeLogger, safeRequestEvent } from './logger.js';
import { registerRequestContext, type RouteContext } from './request-context.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerAdminAuthRoutes } from './routes/admin-auth.js';
import { registerAdminUserRoutes } from './routes/admin-users.js';
import { registerAdminGroupRoutes } from './routes/admin-groups.js';
import { registerAdminKeyRoutes } from './routes/admin-keys.js';
import { registerAdminAuditRoutes } from './routes/admin-audit.js';

export type AdditionalRouteRegistrar = (app: FastifyInstance, context: RouteContext) => void;

export interface BuildAppOptions {
  env?: CloudEnv | NodeJS.ProcessEnv;
  db?: DbHandle;
  closeDbOnClose?: boolean;
  registerAdditionalRoutes?: AdditionalRouteRegistrar;
}

function resolveEnv(value: BuildAppOptions['env']): CloudEnv {
  if (value !== undefined && typeof value === 'object' && 'databaseUrl' in value && typeof value.databaseUrl === 'string') return value as CloudEnv;
  return loadEnv(value as NodeJS.ProcessEnv | undefined);
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const env = resolveEnv(options.env);
  const db = options.db ?? createDb(env.databaseUrl);
  const ownsDb = options.db === undefined || options.closeDbOnClose === true;
  const context: RouteContext = { env, db };
  const logger = createSafeLogger();
  const app = Fastify({
    bodyLimit: 64 * 1024,
    logger: false,
    requestIdHeader: 'x-request-id',
  });
  app.register(cookie);
  registerRequestContext(app, context);

  app.addHook('onRequest', async (request) => {
    if (request.url.startsWith('/api/admin')) {
      if (request.headers.authorization !== undefined) throw appError('AUTH_REQUIRED');
      if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS') {
        const origin = request.headers.origin;
        if (origin !== env.publicOrigin) throw appError('ORIGIN_REJECTED');
      } else if (request.headers.origin !== undefined && request.headers.origin !== env.publicOrigin) {
        throw appError('ORIGIN_REJECTED');
      }
    }
  });

  app.addHook('preValidation', async (request) => {
    if (request.url.startsWith('/api/admin') && request.body !== undefined && request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS') {
      const contentType = request.headers['content-type'];
      if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|$)/i.test(contentType)) throw appError('VALIDATION_FAILED');
    }
  });

  app.addHook('onResponse', async (request, reply) => {
    const event = safeRequestEvent(request, reply.statusCode, request.requestStart);
    logger.info(event);
  });

  app.setNotFoundHandler((request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return reply.code(404).send(errorBody(appError('NOT_FOUND'), request.requestId));
  });
  app.setErrorHandler((error, request, reply) => {
    const normalized = normalizeFastifyError(error);
    reply.header('Cache-Control', 'no-store');
    return reply.code(normalized.statusCode).send(errorBody(normalized, request.requestId));
  });

  registerHealthRoutes(app);
  registerAdminAuthRoutes(app);
  registerAdminUserRoutes(app);
  registerAdminGroupRoutes(app);
  registerAdminKeyRoutes(app);
  registerAdminAuditRoutes(app);
  options.registerAdditionalRoutes?.(app, context);
  if (ownsDb) app.addHook('onClose', async () => { await db.pool.end(); });
  return app;
}

function normalizeFastifyError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'FST_ERR_CTP_BODY_TOO_LARGE') return appError('VALIDATION_FAILED', { fields: [{ path: 'body', code: 'TOO_LARGE' }] });
    if (code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') return appError('VALIDATION_FAILED', { fields: [{ path: 'content-type', code: 'JSON_REQUIRED' }] });
    if (code === 'FST_ERR_CTP_INVALID_JSON_BODY') return appError('VALIDATION_FAILED', { fields: [{ path: 'body', code: 'INVALID_JSON' }] });
  }
  if (typeof error === 'object' && error !== null && 'validation' in error) return appError('VALIDATION_FAILED');
  return appError('INTERNAL');
}

export { createDb, loadEnv };
export type { CloudEnv, DbHandle, RouteContext };
