import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { queryOne, type QueryExecutor } from '../db/transaction.js';
import { appError } from '../errors.js';
import { operation, resolveChannelOperation, type ProviderId } from './catalog.js';
import { SecretVault, type EncryptedSecret } from './crypto.js';
import { ScriptChannels } from './script-channels.js';
import { insertPool, loadPool, poolMetadata, replacePool, selectPoolSecret, type PoolKey, type PoolKeyInput } from './key-pool.js';

export interface ProviderRow {
  id: string; tenant_id: string; name: string; provider_id: ProviderId; status: 'active' | 'disabled';
  current_config_id: string | null; revision: number; deleted_at: Date | null; created_at: Date; updated_at: Date;
}
export interface ConfigRow {
  id: string; tenant_id: string; provider_id: string; version: number; sdk_version: string; adapter_version: string;
  base_url: string; options: Record<string, unknown>; secret_key_id: string | null; nonce: Buffer | null; ciphertext: Buffer | null; auth_tag: Buffer | null;
  credential_updated_at: Date | null; created_at: Date;
}
export interface ProviderInput { name: string; provider_id: ProviderId; base_url?: string; options?: Record<string, unknown>; secret?: string; key_pool?: PoolKeyInput[] }
export interface ProviderPatch { expected_revision: number; name?: string; status?: 'active' | 'disabled'; base_url?: string; options?: Record<string, unknown>; secret?: string; clear_secret?: boolean; key_pool?: PoolKeyInput[] }
export class ProviderService {
  constructor(readonly sdkVersion: string, private readonly vault: SecretVault | undefined, private readonly validateEndpoint: (url: string) => void, readonly scripts = new ScriptChannels()) {}
  async create(tx: PoolClient, tenantId: string, input: ProviderInput): Promise<Record<string, unknown>> {
    const id = randomUUID();
    const kind = input.provider_id;
    const descriptor = operation(kind);
    const storageOptions = kind === 'script' ? this.scripts.options(input.options) : input.options ?? {};
    const resolved = resolveChannelOperation(kind, descriptor.operation_id, input.base_url, storageOptions, this.scripts);
    for (const target of resolved.endpoints) this.validateEndpoint(target);
    const base = resolved.instance.base_url ?? '';
    const options = kind === 'script' ? storageOptions : { ...resolved.instance.options };
    await tx.query('INSERT INTO providers(id,tenant_id,name,provider_id) VALUES($1,$2,$3,$4)', [id, tenantId, input.name, input.provider_id]);
    if (input.secret !== undefined && input.key_pool !== undefined) throw appError('VALIDATION_FAILED');
    const pool = input.key_pool === undefined ? undefined : replacePool(input.key_pool, []);
    const secret = pool === undefined ? input.secret : pool.find(key => key.enabled)?.secret;
    const configId = await this.insertConfig(tx, tenantId, id, input.provider_id, 1, base, options, secret, secret === undefined ? null : new Date());
    if (pool) await insertPool(tx, await this.config(tx, tenantId, configId), pool, this.vault);
    await tx.query('UPDATE providers SET current_config_id=$1 WHERE tenant_id=$2 AND id=$3', [configId, tenantId, id]);
    return this.get(tx, tenantId, id);
  }
  async patch(tx: PoolClient, tenantId: string, id: string, input: ProviderPatch): Promise<Record<string, unknown>> {
    const row = await this.row(tx, tenantId, id);
    if (row.revision !== input.expected_revision) throw appError('STALE_VERSION');
    if ([input.secret !== undefined, input.key_pool !== undefined, input.clear_secret === true].filter(Boolean).length > 1) throw appError('VALIDATION_FAILED');
    let configId = row.current_config_id;
    if (input.base_url !== undefined || input.options !== undefined || input.secret !== undefined || input.clear_secret === true || input.key_pool !== undefined) {
      const prior = await this.config(tx, tenantId, row.current_config_id!);
      const kind = row.provider_id;
      const descriptor = operation(kind);
      const storageOptions = kind === 'script' ? this.scripts.options(input.options ?? prior.options) : input.options ?? prior.options;
      const resolved = resolveChannelOperation(kind, descriptor.operation_id, input.base_url ?? prior.base_url, storageOptions, this.scripts);
      for (const target of resolved.endpoints) this.validateEndpoint(target);
      const base = resolved.instance.base_url ?? '';
      const options = kind === 'script' ? storageOptions : { ...resolved.instance.options };
      const needsPrevious = input.clear_secret !== true && input.secret === undefined && (input.key_pool === undefined || input.key_pool.some(key => key.id !== undefined));
      const previousPool = needsPrevious ? await loadPool(tx, prior, this.vault) : [];
      const pool: PoolKey[] = input.clear_secret === true || input.secret !== undefined ? [] : input.key_pool === undefined ? previousPool : replacePool(input.key_pool, previousPool);
      const secret = input.clear_secret === true ? undefined : input.secret ?? (input.key_pool !== undefined || previousPool.length ? pool.find(key => key.enabled)?.secret : this.decrypt(prior));
      const changedCredentialAt = secret === undefined ? null : input.secret !== undefined || input.key_pool !== undefined ? new Date() : prior.credential_updated_at;
      configId = await this.insertConfig(tx, tenantId, id, row.provider_id, prior.version + 1, base, options, secret, changedCredentialAt);
      if (pool.length) await insertPool(tx, await this.config(tx, tenantId, configId), pool, this.vault);
    }
    await tx.query('UPDATE providers SET name=$1,status=$2,current_config_id=$3,revision=revision+1,updated_at=now() WHERE tenant_id=$4 AND id=$5', [input.name ?? row.name, input.status ?? row.status, configId, tenantId, id]);
    return this.get(tx, tenantId, id);
  }
  async remove(tx: PoolClient, tenantId: string, id: string): Promise<Record<string, unknown>> {
    const row = await queryOne<ProviderRow>(tx, 'SELECT * FROM providers WHERE tenant_id=$1 AND id=$2', [tenantId, id]);
    if (!row) throw appError('NOT_FOUND');
    if (!row.deleted_at) await tx.query("UPDATE providers SET status='disabled',deleted_at=now(),revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2", [tenantId, id]);
    return this.get(tx, tenantId, id, true);
  }
  async row(tx: QueryExecutor, tenantId: string, id: string): Promise<ProviderRow> {
    const row = await queryOne<ProviderRow>(tx, 'SELECT * FROM providers WHERE tenant_id=$1 AND id=$2 AND deleted_at IS NULL', [tenantId, id]);
    if (!row) throw appError('NOT_FOUND');
    return row;
  }
  async config(tx: QueryExecutor, tenantId: string, id: string): Promise<ConfigRow> {
    const row = await queryOne<ConfigRow>(tx, 'SELECT * FROM provider_configs WHERE tenant_id=$1 AND id=$2', [tenantId, id]);
    if (!row) throw appError('UNAVAILABLE');
    return row;
  }
  decrypt(row: ConfigRow): string | undefined {
    if (row.secret_key_id === null) return undefined;
    if (!this.vault || !row.nonce || !row.ciphertext || !row.auth_tag) throw appError('UNAVAILABLE');
    return this.vault.decrypt({ tenantId: row.tenant_id, providerId: row.provider_id, configId: row.id, version: row.version }, row as ConfigRow & EncryptedSecret);
  }
  async selectSecret(tx: QueryExecutor, row: ConfigRow): Promise<string | undefined> {
    const selected = await selectPoolSecret(tx, row, this.vault);
    return selected.pooled ? selected.secret : this.decrypt(row);
  }
  async get(tx: QueryExecutor, tenantId: string, id: string, includeDeleted = false): Promise<Record<string, unknown>> {
    const row = await queryOne<ProviderRow>(tx, `SELECT * FROM providers WHERE tenant_id=$1 AND id=$2${includeDeleted ? '' : ' AND deleted_at IS NULL'}`, [tenantId, id]);
    if (!row) throw appError('NOT_FOUND');
    const config = row.current_config_id ? await this.config(tx, tenantId, row.current_config_id) : undefined;
    const pool = config ? await poolMetadata(tx, config) : { keys: [], selections: '0' };
    return { id: row.id, name: row.name, provider_id: row.provider_id, status: row.status, revision: row.revision, key_pool: pool.keys, key_pool_selections: pool.selections,
      base_url: config?.base_url ?? null, options: config?.options ?? {}, credential_configured: config?.secret_key_id != null,
      credential_updated_at: config?.credential_updated_at?.toISOString() ?? null, deleted_at: row.deleted_at?.toISOString() ?? null,
      created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString() };
  }
  private async insertConfig(tx: PoolClient, tenantId: string, providerId: string, kind: ProviderId, version: number, base: string, options: Record<string, unknown>, secret: string | undefined, credentialAt: Date | null): Promise<string> {
    const id = randomUUID();
    const adapterVersion = operation(kind).adapter_version;
    if (secret !== undefined && !this.vault) throw appError('UNAVAILABLE');
    const encrypted = secret === undefined ? undefined : this.vault!.encrypt({ tenantId, providerId, configId: id, version }, secret);
    await tx.query('INSERT INTO provider_configs(id,tenant_id,provider_id,version,sdk_version,adapter_version,base_url,options,secret_key_id,nonce,ciphertext,auth_tag,credential_updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
      [id, tenantId, providerId, version, this.sdkVersion, adapterVersion, base, JSON.stringify(options), encrypted?.secret_key_id ?? null, encrypted?.nonce ?? null, encrypted?.ciphertext ?? null, encrypted?.auth_tag ?? null, encrypted ? credentialAt : null]);
    return id;
  }
}
