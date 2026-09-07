import { createDb, closeDb } from '../../dist/db/client.js';
import { executionService } from '../../dist/execution/service.js';
import { NodePinnedIo } from '../../dist/egress/transport.js';
const db = createDb(process.env.DATABASE_URL);
const port = process.env.TASK_PROVIDER_PORT;
const node = new NodePinnedIo(process.env.TASK_CA_CERT);
const service = executionService(db);
const runtime = await service.worker({ resolver: async () => ['93.184.216.34'], io: { request(input) {
  if (input.address !== '93.184.216.34' || input.url.hostname !== 'provider.example' || input.url.port !== port) throw new Error('FIXTURE_PIN_DENIED');
  return node.request({ ...input, address: '127.0.0.1', family: 4 });
} } }, { async onStage(stage, job) {
  process.send?.({ stage, id: job.id, lease_owner: job.lease_owner });
  if (stage === process.env.TASK_PAUSE_STAGE) await new Promise((resolve) => {
    const resume = (message) => { if (message?.command === 'resume') { process.off('message', resume); resolve(); } };
    process.on('message', resume);
  });
}, onFault(code) { process.stderr.write(`${code}\n`); } });
const abort = new AbortController();
process.once('SIGTERM', () => abort.abort()); process.once('SIGINT', () => abort.abort());
process.send?.({ stage: 'ready' });
try { await runtime.worker.run(abort.signal); }
finally { await runtime.close(); await closeDb(db); }
