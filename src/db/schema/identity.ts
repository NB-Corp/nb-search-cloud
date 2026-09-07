import { relations } from 'drizzle-orm';
import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey(),
  slug: varchar('slug', { length: 63 }).notNull(),
  name: varchar('name', { length: 120 }).notNull(),
  status: varchar('status', { length: 16 }).notNull().$type<'active' | 'disabled'>(),
  revision: bigint('revision', { mode: 'bigint' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
}, (table) => [uniqueIndex('tenants_slug_uq').on(table.slug), uniqueIndex('tenants_tenant_id_uq').on(table.id)]);

export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  username: varchar('username', { length: 64 }).notNull(),
  displayName: varchar('display_name', { length: 120 }).notNull(),
  role: varchar('role', { length: 16 }).notNull().$type<'admin' | 'user'>(),
  status: varchar('status', { length: 16 }).notNull().$type<'active' | 'disabled'>(),
  passwordHash: text('password_hash').notNull(),
  passwordVersion: integer('password_version').notNull(),
  restrictPublicGroups: boolean('restrict_public_groups').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
}, (table) => [
  uniqueIndex('users_tenant_username_uq').on(table.tenantId, table.username),
  uniqueIndex('users_tenant_id_uq').on(table.tenantId, table.id),
  index('users_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
]);

export const groups = pgTable('groups', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  name: varchar('name', { length: 100 }).notNull(),
  description: varchar('description', { length: 1000 }).notNull(),
  status: varchar('status', { length: 16 }).notNull().$type<'active' | 'disabled'>(),
  isExclusive: boolean('is_exclusive').notNull(),
  dailyUnitsPerUser: bigint('daily_units_per_user', { mode: 'bigint' }).notNull(),
  revision: bigint('revision', { mode: 'bigint' }).notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
}, (table) => [
  uniqueIndex('groups_tenant_id_uq').on(table.tenantId, table.id),
  index('groups_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
]);

export const userAllowedGroups = pgTable('user_allowed_groups', {
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  groupId: uuid('group_id').notNull(),
}, (table) => [
  primaryKey({ columns: [table.tenantId, table.userId, table.groupId] }),
  index('user_allowed_groups_group_idx').on(table.tenantId, table.groupId),
]);

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  groupId: uuid('group_id').notNull(),
  name: varchar('name', { length: 100 }).notNull(),
  tokenHash: bytea('token_hash').notNull(),
  prefix: varchar('prefix', { length: 20 }).notNull(),
  status: varchar('status', { length: 16 }).notNull().$type<'active' | 'disabled'>(),
  quotaUnits: bigint('quota_units', { mode: 'bigint' }).notNull(),
  quotaEpoch: integer('quota_epoch').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  revision: bigint('revision', { mode: 'bigint' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
}, (table) => [
  uniqueIndex('api_keys_token_hash_uq').on(table.tokenHash),
  uniqueIndex('api_keys_tenant_id_uq').on(table.tenantId, table.id),
  index('api_keys_owner_idx').on(table.tenantId, table.userId, table.createdAt, table.id),
]);

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  tokenHash: bytea('token_hash').notNull(),
  csrfHash: bytea('csrf_hash').notNull(),
  passwordVersion: integer('password_version').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
}, (table) => [
  uniqueIndex('sessions_token_hash_uq').on(table.tokenHash),
  index('sessions_expiry_idx').on(table.expiresAt),
  index('sessions_user_idx').on(table.tenantId, table.userId),
]);

export const authRateBuckets = pgTable('auth_rate_buckets', {
  scope: varchar('scope', { length: 24 }).notNull(),
  subjectHash: bytea('subject_hash').notNull(),
  windowStart: timestamp('window_start', { withTimezone: true, mode: 'date' }).notNull(),
  count: integer('count').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
}, (table) => [primaryKey({ columns: [table.scope, table.subjectHash, table.windowStart] }), index('auth_rate_expiry_idx').on(table.expiresAt)]);

export const auditEvents = pgTable('audit_events', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  actorUserId: uuid('actor_user_id'),
  action: varchar('action', { length: 64 }).notNull(),
  targetType: varchar('target_type', { length: 32 }).notNull(),
  targetId: uuid('target_id'),
  requestId: varchar('request_id', { length: 128 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  metadata: jsonb('metadata').notNull(),
}, (table) => [index('audit_events_tenant_time_idx').on(table.tenantId, table.createdAt, table.id)]);

export const tenantRelations = relations(tenants, ({ many }) => ({ users: many(users), groups: many(groups), keys: many(apiKeys), sessions: many(sessions), auditEvents: many(auditEvents) }));
export const userRelations = relations(users, ({ many }) => ({ memberships: many(userAllowedGroups), keys: many(apiKeys), sessions: many(sessions) }));
export const groupRelations = relations(groups, ({ many }) => ({ memberships: many(userAllowedGroups), keys: many(apiKeys) }));
