import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { CloudEnv } from './env.js';
import { appError, sendError } from './errors.js';
import type { DbHandle } from './db/client.js';
import type { ZodType } from 'zod';

export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export interface Principal {
  tenantId: string;
  userId: string;
  role: 'admin' | 'user';
  keyId?: string;
  groupId?: string;
  sessionId?: string;
  passwordVersion?: number;
}

export interface RouteContext {
  db: DbHandle;
  env: CloudEnv;
}

export interface TenantRow {
  id: string;
  slug: string;
  name: string;
  status: 'active' | 'disabled';
  revision: string | number;
  created_at: Date;
  updated_at: Date;
}

export interface UserRow {
  id: string;
  tenant_id: string;
  username: string;
  display_name: string;
  role: 'admin' | 'user';
  status: 'active' | 'disabled';
  password_hash: string;
  password_version: number;
  restrict_public_groups: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface GroupRow {
  id: string;
  tenant_id: string;
  name: string;
  description: string;
  status: 'active' | 'disabled';
  is_exclusive: boolean;
  daily_units_per_user: string | number;
  revision: string | number;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface KeyRow {
  id: string;
  tenant_id: string;
  user_id: string;
  group_id: string;
  name: string;
  prefix: string;
  status: 'active' | 'disabled';
  quota_units: string | number;
  quota_epoch: number;
  expires_at: Date | null;
  deleted_at: Date | null;
  revision: string | number;
  created_at: Date;
  updated_at: Date;
  last_used_at: Date | null;
}

export interface SessionRow {
  id: string;
  tenant_id: string;
  user_id: string;
  token_hash: Buffer;
  csrf_hash: Buffer;
  password_version: number;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  role: 'admin' | 'user';
  user_status: 'active' | 'disabled';
  password_version_current: number;
  tenant_status: 'active' | 'disabled';
  tenant_slug: string;
  tenant_name: string;
  username: string;
  display_name: string;
  restrict_public_groups: boolean;
  user_created_at: Date;
  user_updated_at: Date;
}

export function normalizeRequestId(value: unknown): string {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value) ? value : randomUUID();
}

export function safeJsonInteger(value: string | number | bigint): number {
  const numberValue = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isSafeInteger(numberValue) || numberValue < 0) throw appError('INTERNAL');
  return numberValue;
}

export function registerRequestContext(app: FastifyInstance, context: RouteContext): void {
  app.decorate('cloud', context);
  app.decorateRequest('requestId', '');
  app.decorateRequest('requestStart', 0);
  app.addHook('onRequest', async (request) => {
    request.requestId = normalizeRequestId(request.headers['x-request-id']);
    request.requestStart = performance.now();
  });
}

export function requestId(request: FastifyRequest): string {
  return request.requestId ?? normalizeRequestId(request.headers['x-request-id']);
}

export function contextOf(request: FastifyRequest): RouteContext {
  return request.server.cloud;
}

export function requireJson(request: FastifyRequest): void {
  const contentType = request.headers['content-type'];
  if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw appError('VALIDATION_FAILED', { fields: [{ path: 'content-type', code: 'JSON_REQUIRED' }] });
  }
}

export function requireExactOrigin(request: FastifyRequest, env: CloudEnv, required = true): void {
  const origin = request.headers.origin;
  if (origin === undefined && !required) return;
  if (origin !== env.publicOrigin) throw appError('ORIGIN_REJECTED');
}

export function parseBody<T>(schema: ZodType<T>, request: FastifyRequest): T {
  const parsed = schema.safeParse(request.body);
  if (parsed.success) return parsed.data;
  throw appError('VALIDATION_FAILED', {
    fields: parsed.error.issues.map((issue) => ({ path: issue.path.join('.') || 'body', code: issue.code })),
  });
}

export function rejectAuthorization(request: FastifyRequest): void {
  if (request.headers.authorization !== undefined) throw appError('AUTH_REQUIRED');
}

export function rejectCookie(request: FastifyRequest, cookieName: string): void {
  if (request.cookies?.[cookieName] !== undefined) throw appError('AUTH_REQUIRED');
}

export function sendData(reply: FastifyReply, data: unknown, statusCode = 200): unknown {
  reply.header('Cache-Control', 'no-store');
  return reply.code(statusCode).send({ data, request_id: (reply.request as FastifyRequest).requestId });
}

export function sendRequestError(reply: FastifyReply, error: unknown): unknown {
  reply.header('Cache-Control', 'no-store');
  return sendError(reply, error, requestId(reply.request));
}

declare module 'fastify' {
  interface FastifyInstance {
    cloud: RouteContext;
  }
  interface FastifyRequest {
    requestId: string;
    requestStart: number;
  }
}
