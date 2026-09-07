import { setTimeout as delay } from 'node:timers/promises';
import type { ExecutionBridge } from './bridge.js';
import { ExecutionStore, type Completion } from './store.js';
import { failure, type JobRow, type Json } from './types.js';

export interface WorkerObserver { onStage?(stage: 'claimed' | 'prepared' | 'dispatched' | 'completed', job: JobRow): Promise<void> | void; onFault?(code: 'WORKER_STORAGE_UNAVAILABLE'): void }
export class CloudWorker {
  constructor(private readonly store: ExecutionStore, private readonly bridge: ExecutionBridge, private readonly observer: WorkerObserver = {}) {}
  async once(): Promise<boolean> {
    const claimed = await this.store.claim();
    if (!claimed) return false;
    const abort = new AbortController();
    let heartbeatRunning = false;
    const timer = setInterval(() => {
      if (heartbeatRunning) return;
      heartbeatRunning = true;
      this.store.heartbeat(claimed).then((state) => { if (!state.valid || state.cancelled) abort.abort(); }, () => abort.abort()).finally(() => { heartbeatRunning = false; });
    }, 5000);
    timer.unref();
    try {
      await this.observer.onStage?.('claimed', claimed);
      if (!claimed.first_plan) { await this.store.failPreparation(claimed); return true; }
      let prepared;
      try { prepared = await this.bridge.prepare(claimed.first_plan, abort.signal); }
      catch { await this.store.failPreparation(claimed); return true; }
      await this.observer.onStage?.('prepared', claimed);
      // A failed/uncertain commit must never be followed by provider dispatch.
      let dispatched;
      try { dispatched = await this.store.markDispatch(claimed); }
      catch { this.observer.onFault?.('WORKER_STORAGE_UNAVAILABLE'); return true; }
      if (!dispatched) return true;
      await this.observer.onStage?.('dispatched', dispatched);
      let completion: Completion;
      try {
        const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(claimed.first_plan.budget.timeout_ms)]);
        const result = await prepared.execute(signal);
        const envelope = JSON.parse(JSON.stringify(result)) as Record<string, Json>;
        const successful = result.status === 'succeeded' || result.status === 'partial' || result.status === 'empty';
        const cancelled = result.status === 'cancelled';
        completion = { state: successful ? 'succeeded' : cancelled ? 'cancelled' : 'failed', envelope,
          ...(successful && (claimed.kind === 'fetch' || envelope['output']) ? { artifact: claimed.kind === 'fetch' ? envelope : envelope['output']! } : {}),
          ...(!successful ? { error: failure(cancelled ? 'CANCELLED' : result.status === 'timed_out' ? 'DEADLINE_EXCEEDED' : result.error?.code === 'OUTPUT_TOO_LARGE' ? 'OUTPUT_TOO_LARGE' : 'PROVIDER_UNAVAILABLE') } : {}) };
      } catch {
        const error = failure(abort.signal.aborted ? 'CANCELLED' : 'PROVIDER_UNAVAILABLE');
        const selection = claimed.selection;
        completion = { state: abort.signal.aborted ? 'cancelled' : 'failed', error,
          envelope: { schema_version: '3.0', action: 'run', execution: 'sync', status: abort.signal.aborted ? 'cancelled' : 'failed', error: { ...error }, hints: [],
            ...(claimed.kind === 'fetch' ? { mode: 'fetch', selection, documents: [], lane_outcomes: [] } : { selection }) } };
      }
      await this.store.complete(dispatched, completion);
      await this.observer.onStage?.('completed', dispatched);
      return true;
    } finally { clearInterval(timer); abort.abort(); }
  }
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.store.reconcile();
        await this.store.cleanup();
        if (await this.once()) continue;
      } catch { this.observer.onFault?.('WORKER_STORAGE_UNAVAILABLE'); }
      try { await delay(250, undefined, { signal }); } catch { break; }
    }
  }
}
