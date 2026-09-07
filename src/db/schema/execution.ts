import { sql } from 'drizzle-orm';
import type { FrozenPlan, Json, SafeFailure } from '../../execution/types.js';
import { apiKeys, groups, tenants, users } from './identity.js';
import {
  bigint,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn, ForeignKeyBuilder } from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });
type JsonObject = Record<string, Json>;
export type GroupExecutionPresets = Record<string, string[]>;

function providersCurrentForeignKey(table: {
  tenantId: AnyPgColumn;
  id: AnyPgColumn;
  currentConfigId: AnyPgColumn;
}): ForeignKeyBuilder {
  return foreignKey({
    name: 'providers_current_fk',
    columns: [table.tenantId, table.id, table.currentConfigId],
    foreignColumns: [providerConfigs.tenantId, providerConfigs.providerId, providerConfigs.id],
  });
}

function providerConfigsProviderForeignKey(table: {
  tenantId: AnyPgColumn;
  providerId: AnyPgColumn;
}): ForeignKeyBuilder {
  return foreignKey({
    name: 'provider_configs_provider_fk',
    columns: [table.tenantId, table.providerId],
    foreignColumns: [providers.tenantId, providers.id],
  });
}

/**
 * `groups` remains declared by the frozen identity projection. Migration 0002 adds these columns.
 */
export interface GroupExecutionFields {
  default_search_lane: string | null;
  default_fetch_pipeline: string | null;
  presets: GroupExecutionPresets;
}

export const providers = pgTable('providers', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  name: varchar('name', { length: 100 }).notNull(),
  providerId: varchar('provider_id', { length: 64 }).notNull().$type<'exa' | 'grok-multi-agent'>(),
  status: varchar('status', { length: 16 }).notNull().default('active').$type<'active' | 'disabled'>(),
  currentConfigId: uuid('current_config_id'),
  revision: integer('revision').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
}, (table) => [
  unique('providers_tenant_id_uq').on(table.tenantId, table.id),
  uniqueIndex('providers_name_uq').on(table.tenantId, table.name).where(sql`${table.deletedAt} IS NULL`),
  check('providers_provider_id_check', sql`${table.providerId} IN ('exa', 'grok-multi-agent')`),
  check('providers_status_check', sql`${table.status} IN ('active', 'disabled')`),
  check('providers_revision_check', sql`${table.revision} > 0`),
  providersCurrentForeignKey(table),
]);

export const providerConfigs = pgTable('provider_configs', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  providerId: uuid('provider_id').notNull(),
  version: integer('version').notNull(),
  sdkVersion: varchar('sdk_version', { length: 128 }).notNull(),
  adapterVersion: varchar('adapter_version', { length: 32 }).notNull(),
  configSchema: varchar('config_schema', { length: 8 }).notNull().default('4').$type<'4'>(),
  baseUrl: varchar('base_url', { length: 2048 }).notNull(),
  options: jsonb('options').$type<JsonObject>().notNull().default({}),
  secretKeyId: varchar('secret_key_id', { length: 64 }),
  nonce: bytea('nonce'),
  ciphertext: bytea('ciphertext'),
  authTag: bytea('auth_tag'),
  credentialUpdatedAt: timestamp('credential_updated_at', { withTimezone: true, mode: 'date' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [
  unique('provider_configs_tenant_id_uq').on(table.tenantId, table.id),
  unique('provider_configs_tenant_provider_id_id_uq').on(table.tenantId, table.providerId, table.id),
  unique('provider_configs_provider_id_version_uq').on(table.providerId, table.version),
  unique('provider_configs_secret_key_id_nonce_uq').on(table.secretKeyId, table.nonce),
  check('provider_configs_version_check', sql`${table.version} > 0`),
  check('provider_configs_schema_check', sql`${table.configSchema} = '4'`),
  check('provider_configs_credential_check', sql`(
    ${table.secretKeyId} IS NULL AND ${table.nonce} IS NULL AND ${table.ciphertext} IS NULL AND ${table.authTag} IS NULL AND ${table.credentialUpdatedAt} IS NULL
  ) OR (
    ${table.secretKeyId} IS NOT NULL AND ${table.nonce} IS NOT NULL AND ${table.authTag} IS NOT NULL AND ${table.ciphertext} IS NOT NULL AND octet_length(${table.nonce}) = 12 AND octet_length(${table.authTag}) = 16 AND octet_length(${table.ciphertext}) > 0 AND ${table.credentialUpdatedAt} IS NOT NULL
  )`),
  providerConfigsProviderForeignKey(table),
]);

export const lanes = pgTable('lanes', {
  tenantId: uuid('tenant_id').notNull(),
  id: varchar('id', { length: 256 }).notNull(),
  kind: varchar('kind', { length: 8 }).notNull().$type<'search' | 'fetch'>(),
  providerId: uuid('provider_id').notNull(),
  operationId: varchar('operation_id', { length: 32 }).notNull(),
  status: varchar('status', { length: 16 }).notNull().default('active').$type<'active' | 'disabled'>(),
  latency: varchar('latency', { length: 8 }).notNull().$type<'fast' | 'medium' | 'slow'>(),
  cost: varchar('cost', { length: 16 }).notNull().$type<'free' | 'cheap' | 'expensive'>(),
  evidenceGroups: jsonb('evidence_groups').$type<string[]>().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.tenantId, table.id] }),
  check('lanes_kind_check', sql`${table.kind} IN ('search', 'fetch')`),
  check('lanes_status_check', sql`${table.status} IN ('active', 'disabled')`),
  check('lanes_latency_check', sql`${table.latency} IN ('fast', 'medium', 'slow')`),
  check('lanes_cost_check', sql`${table.cost} IN ('free', 'cheap', 'expensive')`),
  foreignKey({
    name: 'lanes_provider_fk',
    columns: [table.tenantId, table.providerId],
    foreignColumns: [providers.tenantId, providers.id],
  }),
]);

export const groupLanes = pgTable('group_lanes', {
  tenantId: uuid('tenant_id').notNull(),
  groupId: uuid('group_id').notNull(),
  laneId: varchar('lane_id', { length: 256 }).notNull(),
  unitsPerQuery: integer('units_per_query').notNull().default(1),
}, (table) => [
  primaryKey({ columns: [table.tenantId, table.groupId, table.laneId] }),
  check('group_lanes_units_per_query_check', sql`${table.unitsPerQuery} BETWEEN 1 AND 1000000`),
  foreignKey({
    name: 'group_lanes_group_fk',
    columns: [table.tenantId, table.groupId],
    foreignColumns: [groups.tenantId, groups.id],
  }),
  foreignKey({
    name: 'group_lanes_lane_fk',
    columns: [table.tenantId, table.laneId],
    foreignColumns: [lanes.tenantId, lanes.id],
  }),
]);

export const groupUsageBuckets = pgTable('group_usage_buckets', {
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  groupId: uuid('group_id').notNull(),
  utcDay: date('utc_day', { mode: 'string' }).notNull(),
  reservedUnits: bigint('reserved_units', { mode: 'bigint' }).notNull().default(0n),
  usedUnits: bigint('used_units', { mode: 'bigint' }).notNull().default(0n),
}, (table) => [
  primaryKey({ columns: [table.tenantId, table.userId, table.groupId, table.utcDay] }),
  check('group_usage_buckets_reserved_check', sql`${table.reservedUnits} >= 0`),
  check('group_usage_buckets_used_check', sql`${table.usedUnits} >= 0`),
  foreignKey({
    name: 'group_usage_buckets_user_fk',
    columns: [table.tenantId, table.userId],
    foreignColumns: [users.tenantId, users.id],
  }),
  foreignKey({
    name: 'group_usage_buckets_group_fk',
    columns: [table.tenantId, table.groupId],
    foreignColumns: [groups.tenantId, groups.id],
  }),
]);

export const keyUsageBuckets = pgTable('key_usage_buckets', {
  tenantId: uuid('tenant_id').notNull(),
  keyId: uuid('key_id').notNull(),
  epoch: integer('epoch').notNull(),
  reservedUnits: bigint('reserved_units', { mode: 'bigint' }).notNull().default(0n),
  usedUnits: bigint('used_units', { mode: 'bigint' }).notNull().default(0n),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.tenantId, table.keyId, table.epoch] }),
  check('key_usage_buckets_epoch_check', sql`${table.epoch} > 0`),
  check('key_usage_buckets_reserved_check', sql`${table.reservedUnits} >= 0`),
  check('key_usage_buckets_used_check', sql`${table.usedUnits} >= 0`),
  foreignKey({
    name: 'key_usage_buckets_key_fk',
    columns: [table.tenantId, table.keyId],
    foreignColumns: [apiKeys.tenantId, apiKeys.id],
  }),
]);

export const jobs = pgTable('jobs', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  groupId: uuid('group_id').notNull(),
  admittingKeyId: uuid('admitting_key_id').notNull(),
  kind: varchar('kind', { length: 8 }).notNull().$type<'search' | 'fetch'>(),
  delivery: varchar('delivery', { length: 8 }).notNull().$type<'sync' | 'async'>(),
  state: varchar('state', { length: 16 }).notNull().default('queued').$type<'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'>(),
  planVersion: integer('plan_version').notNull().default(1),
  firstPlan: jsonb('first_plan').$type<FrozenPlan>(),
  selection: jsonb('selection').$type<JsonObject>().notNull(),
  requestId: varchar('request_id', { length: 128 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
  completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
  cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true, mode: 'date' }),
  leaseOwner: uuid('lease_owner'),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true, mode: 'date' }),
  claimCount: integer('claim_count').notNull().default(0),
  dispatchStartedAt: timestamp('dispatch_started_at', { withTimezone: true, mode: 'date' }),
  publicError: jsonb('public_error').$type<SafeFailure>(),
  syncEnvelope: jsonb('sync_envelope').$type<JsonObject>(),
  purgedAt: timestamp('purged_at', { withTimezone: true, mode: 'date' }),
}, (table) => [
  unique('jobs_tenant_id_uq').on(table.tenantId, table.id),
  check('jobs_kind_check', sql`${table.kind} IN ('search', 'fetch')`),
  check('jobs_delivery_check', sql`${table.delivery} IN ('sync', 'async')`),
  check('jobs_state_check', sql`${table.state} IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')`),
  check('jobs_plan_version_check', sql`${table.planVersion} = 1`),
  check('jobs_claim_count_check', sql`${table.claimCount} >= 0`),
  check('jobs_state_completion_check', sql`(
    ${table.state} IN ('queued', 'running') AND ${table.completedAt} IS NULL AND ${table.expiresAt} IS NULL
  ) OR (
    ${table.state} IN ('succeeded', 'failed', 'cancelled') AND ${table.completedAt} IS NOT NULL AND ${table.expiresAt} IS NOT NULL AND ${table.expiresAt} >= ${table.completedAt}
  )`),
  check('jobs_plan_retention', sql`${table.firstPlan} IS NOT NULL OR ${table.purgedAt} IS NOT NULL`),
  index('jobs_queue_idx').on(table.state, table.createdAt, table.id).where(sql`${table.state} IN ('queued', 'running')`),
  index('jobs_owner_idx').on(table.tenantId, table.userId, table.kind, table.id),
  index('jobs_retention_idx').on(table.expiresAt).where(sql`${table.completedAt} IS NOT NULL`),
  foreignKey({
    name: 'jobs_user_fk',
    columns: [table.tenantId, table.userId],
    foreignColumns: [users.tenantId, users.id],
  }),
  foreignKey({
    name: 'jobs_group_fk',
    columns: [table.tenantId, table.groupId],
    foreignColumns: [groups.tenantId, groups.id],
  }),
  foreignKey({
    name: 'jobs_admitting_key_fk',
    columns: [table.tenantId, table.admittingKeyId],
    foreignColumns: [apiKeys.tenantId, apiKeys.id],
  }),
]);

export const jobConfigRefs = pgTable('job_config_refs', {
  tenantId: uuid('tenant_id').notNull(),
  jobId: uuid('job_id').notNull(),
  configId: uuid('config_id').notNull(),
}, (table) => [
  primaryKey({ columns: [table.tenantId, table.jobId, table.configId] }),
  foreignKey({
    name: 'job_config_refs_job_fk',
    columns: [table.tenantId, table.jobId],
    foreignColumns: [jobs.tenantId, jobs.id],
  }),
  foreignKey({
    name: 'job_config_refs_config_fk',
    columns: [table.tenantId, table.configId],
    foreignColumns: [providerConfigs.tenantId, providerConfigs.id],
  }),
]);

export const idempotencyAdmissions = pgTable('idempotency_admissions', {
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  kind: varchar('kind', { length: 8 }).notNull().$type<'search' | 'fetch'>(),
  key: varchar('key', { length: 128 }).notNull(),
  canonicalContent: bytea('canonical_content').notNull(),
  contentSha256: bytea('content_sha256').notNull(),
  jobId: uuid('job_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.tenantId, table.userId, table.kind, table.key] }),
  unique('idempotency_admissions_job_id_uq').on(table.jobId),
  check('idempotency_admissions_kind_check', sql`${table.kind} IN ('search', 'fetch')`),
  check('idempotency_admissions_content_sha256_check', sql`octet_length(${table.contentSha256}) = 32`),
  foreignKey({
    name: 'idempotency_admissions_user_fk',
    columns: [table.tenantId, table.userId],
    foreignColumns: [users.tenantId, users.id],
  }),
  foreignKey({
    name: 'idempotency_admissions_job_fk',
    columns: [table.tenantId, table.jobId],
    foreignColumns: [jobs.tenantId, jobs.id],
  }),
]);

export const usageReservations = pgTable('usage_reservations', {
  jobId: uuid('job_id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  groupId: uuid('group_id').notNull(),
  keyId: uuid('key_id').notNull(),
  utcDay: date('utc_day', { mode: 'string' }).notNull(),
  keyEpoch: integer('key_epoch').notNull(),
  units: bigint('units', { mode: 'bigint' }).notNull(),
  state: varchar('state', { length: 16 }).notNull().default('reserved').$type<'reserved' | 'settled' | 'released'>(),
  reason: varchar('reason', { length: 64 }).notNull().default('admitted'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  settledAt: timestamp('settled_at', { withTimezone: true, mode: 'date' }),
}, (table) => [
  check('usage_reservations_units_check', sql`${table.units} > 0`),
  check('usage_reservations_state_check', sql`${table.state} IN ('reserved', 'settled', 'released')`),
  check('usage_reservations_settled_check', sql`(${table.state} = 'reserved' AND ${table.settledAt} IS NULL) OR (${table.state} <> 'reserved' AND ${table.settledAt} IS NOT NULL)`),
  foreignKey({
    name: 'usage_reservations_job_fk',
    columns: [table.tenantId, table.jobId],
    foreignColumns: [jobs.tenantId, jobs.id],
  }),
  foreignKey({
    name: 'usage_reservations_group_bucket_fk',
    columns: [table.tenantId, table.userId, table.groupId, table.utcDay],
    foreignColumns: [groupUsageBuckets.tenantId, groupUsageBuckets.userId, groupUsageBuckets.groupId, groupUsageBuckets.utcDay],
  }),
  foreignKey({
    name: 'usage_reservations_key_bucket_fk',
    columns: [table.tenantId, table.keyId, table.keyEpoch],
    foreignColumns: [keyUsageBuckets.tenantId, keyUsageBuckets.keyId, keyUsageBuckets.epoch],
  }),
]);

export const usageEvents = pgTable('usage_events', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  groupId: uuid('group_id').notNull(),
  keyId: uuid('key_id').notNull(),
  jobId: uuid('job_id').notNull(),
  event: varchar('event', { length: 8 }).notNull().$type<'reserve' | 'settle' | 'release'>(),
  units: bigint('units', { mode: 'bigint' }).notNull(),
  utcDay: date('utc_day', { mode: 'string' }).notNull(),
  keyEpoch: integer('key_epoch').notNull(),
  requestId: varchar('request_id', { length: 128 }).notNull(),
  safeReason: varchar('safe_reason', { length: 64 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [
  unique('usage_events_job_event_uq').on(table.jobId, table.event),
  check('usage_events_event_check', sql`${table.event} IN ('reserve', 'settle', 'release')`),
  check('usage_events_units_check', sql`${table.units} > 0`),
  foreignKey({
    name: 'usage_events_job_fk',
    columns: [table.tenantId, table.jobId],
    foreignColumns: [jobs.tenantId, jobs.id],
  }),
  index('usage_owner_idx').on(table.tenantId, table.userId, table.createdAt, table.id),
]);

export const artifacts = pgTable('artifacts', {
  jobId: uuid('job_id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  mediaType: varchar('media_type', { length: 32 }).notNull().default('application/json').$type<'application/json'>(),
  byteLength: integer('byte_length').notNull(),
  sha256: varchar('sha256', { length: 64 }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [
  unique('artifacts_tenant_id_job_id_uq').on(table.tenantId, table.jobId),
  check('artifacts_media_type_check', sql`${table.mediaType} = 'application/json'`),
  check('artifacts_byte_length_check', sql`${table.byteLength} BETWEEN 1 AND 16777216`),
  check('artifacts_sha256_check', sql`${table.sha256} ~ '^[0-9a-f]{64}$'`),
  foreignKey({
    name: 'artifacts_job_fk',
    columns: [table.tenantId, table.jobId],
    foreignColumns: [jobs.tenantId, jobs.id],
  }),
]);

export const artifactChunks = pgTable('artifact_chunks', {
  tenantId: uuid('tenant_id').notNull(),
  jobId: uuid('job_id').notNull(),
  index: integer('index').notNull(),
  offset: integer('offset').notNull(),
  byteLength: integer('byte_length').notNull(),
  data: bytea('data').notNull(),
}, (table) => [
  primaryKey({ columns: [table.jobId, table.index] }),
  unique('artifact_chunks_job_id_offset_uq').on(table.jobId, table.offset),
  check('artifact_chunks_index_check', sql`${table.index} >= 0`),
  check('artifact_chunks_offset_check', sql`${table.offset} >= 0`),
  check('artifact_chunks_byte_length_check', sql`${table.byteLength} BETWEEN 1 AND 12288`),
  check('artifact_chunks_data_length_check', sql`octet_length(${table.data}) = ${table.byteLength}`),
  foreignKey({
    name: 'artifact_chunks_artifact_fk',
    columns: [table.tenantId, table.jobId],
    foreignColumns: [artifacts.tenantId, artifacts.jobId],
  }),
]);
