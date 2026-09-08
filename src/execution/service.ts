import { resolve } from 'node:path';
import type { DbHandle } from '../db/client.js';
import type { AdditionalRouteRegistrar } from '../app.js';
import { publicUrl } from '../egress/address.js';
import { appError } from '../errors.js';
import { operation, resolveChannelOperation } from './catalog.js';
import { SecretVault } from './crypto.js';
import { ProviderService } from './providers.js';
import { ExecutionStore } from './store.js';
import type { LaneReady } from './plans.js';
import { SdkExecutionBridge, type BridgeOptions } from './bridge.js';
import { CloudWorker, type WorkerObserver } from './worker.js';
import { registerRemoteRoutes } from '../routes/remote-v1.js';
import { registerAdminExecutionRoutes } from '../routes/admin-execution.js';
import { registerAdminUsageRoutes } from '../routes/admin-usage.js';

import { CLOUD_SDK_VERSION, compatibleSdkVersion } from './sdk-version.js';
import { ScriptChannels } from './script-channels.js';
export { CLOUD_SDK_VERSION } from './sdk-version.js';
/** Deployment configuration only. There is no HTTP or database setting for replacing network policy. */
export function executionService(db: DbHandle, env: NodeJS.ProcessEnv = process.env) {
  const key = env['CLOUD_SECRET_MASTER_KEY'], keyId = env['CLOUD_SECRET_KEY_ID'];
  if (!!key !== !!keyId) throw new Error('EXECUTION_SECRET_CONFIG_INVALID');
  const vault = key && keyId ? new SecretVault(keyId, key) : undefined;
  const scripts = new ScriptChannels(env['CLOUD_SCRIPT_CHANNELS']);
  const providers = new ProviderService(CLOUD_SDK_VERSION, vault, (url) => {
    try { publicUrl(url); } catch { throw appError('VALIDATION_FAILED', { fields: [{ path: 'base_url', code: 'PUBLIC_HTTPS_REQUIRED' }] }); }
  }, scripts);
  const ready: LaneReady = (lane) => {
    if (!compatibleSdkVersion(lane.sdk_version, CLOUD_SDK_VERSION)) return false;
    try {
      const descriptor = operation(lane.provider_kind, lane.operation_id);
      if (descriptor.kind !== lane.kind || descriptor.adapter_version !== lane.adapter_version) return false;
      if (lane.secret_key_id !== null ? (!vault || lane.secret_key_id !== vault.keyId) : lane.provider_kind !== 'script') return false;
      const resolved = resolveChannelOperation(lane.provider_kind, descriptor.operation_id, lane.base_url || undefined, lane.options, scripts);
      if (resolved.provider.provider_id !== lane.provider_kind || resolved.provider.adapter_version !== lane.adapter_version || resolved.kind !== lane.kind || resolved.operation.operation_id !== lane.operation_id) return false;
      for (const target of resolved.endpoints) publicUrl(target);
      return true;
    } catch { return false; }
  };
  const store = new ExecutionStore(db, CLOUD_SDK_VERSION, ready);
  const register: AdditionalRouteRegistrar = (app, context) => {
    registerAdminExecutionRoutes(app, providers, store, ready);
    registerAdminUsageRoutes(app, store);
    registerRemoteRoutes(app, context, store, ready);
  };
  async function worker(options: Pick<BridgeOptions, 'io' | 'resolver'> = {}, observer?: WorkerObserver) {
    const bridge = await SdkExecutionBridge.create({ db, providers, sdkVersion: CLOUD_SDK_VERSION,
      homeRoot: resolve(env['CLOUD_EXECUTION_HOME'] ?? '.local/cloud-execution'), ...options });
    return { worker: new CloudWorker(store, bridge, observer), close: () => bridge.close() };
  }
  return { providers, ready, store, register, worker };
}
