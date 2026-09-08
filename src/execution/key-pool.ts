import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { QueryExecutor } from '../db/transaction.js';
import { appError } from '../errors.js';
import type { ConfigRow } from './providers.js';
import { SecretVault, type EncryptedSecret } from './crypto.js';

export interface PoolKeyInput { id?: string; label?: string; secret?: string; enabled?: boolean }
export interface PoolKey { label: string; secret: string; enabled: boolean }
interface KeyRow extends EncryptedSecret { id: string; label: string; enabled: boolean }
export async function poolMetadata(tx: QueryExecutor, config: ConfigRow) {
  const keys = await tx.query<{ id: string; label: string; enabled: boolean }>('SELECT id,label,enabled FROM provider_config_keys WHERE tenant_id=$1 AND config_id=$2 ORDER BY ordinal', [config.tenant_id, config.id]);
  const count = await tx.query<{ selections: string }>('SELECT selections FROM provider_key_counters WHERE tenant_id=$1 AND config_id=$2', [config.tenant_id, config.id]);
  return { keys: keys.rows, selections: count.rows[0]?.selections ?? '0' };
}
export async function loadPool(tx: QueryExecutor, config: ConfigRow, vault: SecretVault | undefined): Promise<(PoolKey & { id: string })[]> {
  const rows = await tx.query<KeyRow>('SELECT * FROM provider_config_keys WHERE tenant_id=$1 AND config_id=$2 ORDER BY ordinal', [config.tenant_id, config.id]);
  return rows.rows.map(row => {
    if (!vault) throw appError('UNAVAILABLE');
    return { id: row.id, label: row.label, enabled: row.enabled, secret: vault.decrypt({ tenantId: config.tenant_id, providerId: config.provider_id, configId: row.id, version: config.version }, row) };
  });
}
export function replacePool(input: PoolKeyInput[], prior: (PoolKey & { id: string })[]): PoolKey[] {
  if (input.length > 32) throw appError('VALIDATION_FAILED');
  const ids = new Set<string>();
  return input.map((key, index) => {
    const previous = key.id ? prior.find(p => p.id === key.id) : undefined;
    if (key.id && (!previous || ids.has(key.id))) throw appError('VALIDATION_FAILED');
    if (key.id) ids.add(key.id);
    const secret = key.secret ?? previous?.secret;
    if (!secret || secret.length > 8192) throw appError('VALIDATION_FAILED');
    return { label: key.label ?? previous?.label ?? `Key ${index + 1}`, secret, enabled: key.enabled ?? previous?.enabled ?? true };
  });
}
export async function insertPool(tx: PoolClient, config: ConfigRow, pool: PoolKey[], vault: SecretVault | undefined) {
  if (pool.length && !vault) throw appError('UNAVAILABLE');
  for (const [ordinal, key] of pool.entries()) {
    const id = randomUUID();
    const encrypted = vault!.encrypt({ tenantId: config.tenant_id, providerId: config.provider_id, configId: id, version: config.version }, key.secret);
    await tx.query('INSERT INTO provider_config_keys(id,tenant_id,config_id,ordinal,label,enabled,secret_key_id,nonce,ciphertext,auth_tag) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [id, config.tenant_id, config.id, ordinal, key.label, key.enabled, encrypted.secret_key_id, encrypted.nonce, encrypted.ciphertext, encrypted.auth_tag]);
  }
  if (pool.length) await tx.query('INSERT INTO provider_key_counters(tenant_id,config_id) VALUES($1,$2)', [config.tenant_id, config.id]);
}
/** One atomic counter per immutable config: workers coordinate without process-local state.
 * Selecting a key never retries or falls back to another paid credential. */
export async function selectPoolSecret(tx: QueryExecutor, config: ConfigRow, vault: SecretVault | undefined): Promise<{ pooled: boolean; secret?: string }> {
  const rows = await tx.query<KeyRow>('SELECT * FROM provider_config_keys WHERE tenant_id=$1 AND config_id=$2 ORDER BY ordinal', [config.tenant_id, config.id]);
  if (!rows.rows.length) return { pooled: false };
  const enabled = rows.rows.filter(row => row.enabled);
  if (!enabled.length || !vault) throw appError('UNAVAILABLE');
  const counter = await tx.query<{ selected: string }>('UPDATE provider_key_counters SET selections=selections+1 WHERE tenant_id=$1 AND config_id=$2 RETURNING (selections-1)::text AS selected', [config.tenant_id, config.id]);
  if (!counter.rows[0]) throw appError('UNAVAILABLE');
  const row = enabled[Number(BigInt(counter.rows[0].selected) % BigInt(enabled.length))]!;
  return { pooled: true, secret: vault.decrypt({ tenantId: config.tenant_id, providerId: config.provider_id, configId: row.id, version: config.version }, row) };
}
