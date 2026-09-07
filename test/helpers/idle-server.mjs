import { buildApp } from '../../dist/app.js';
import { createDb } from '../../dist/db/client.js';
import { loadEnv } from '../../dist/env.js';

const env = loadEnv();
const db = createDb(env.databaseUrl, { max: 1, idleTimeoutMillis: 120_000, connectionTimeoutMillis: 1000, application_name: process.env.TEST_APPLICATION_NAME });
const app = buildApp({ env, db, closeDbOnClose: true });
try {
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  process.send?.({ ready: true, address, pid: process.pid });
  process.on('message', async (message) => { if (message === 'close') { await app.close(); process.exit(0); } });
} catch { process.stderr.write('IDLE_SERVER_START_FAILED\n'); await app.close(); process.exitCode = 1; }
