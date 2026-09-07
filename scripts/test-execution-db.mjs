import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPnpm, startTestDatabase, stopTestDatabase, withControlLock } from './test-database-control.mjs';

const options = { root: resolve(dirname(fileURLToPath(import.meta.url)), '..'), name: 'nbcloud-task18-execution-test', project: 'nbcloud-task18-execution-test', database: 'nbcloud_test_execution', port: 55433 };
try {
  await withControlLock(options, async () => {
    try {
      const { env } = await startTestDatabase(options);
      const args = process.argv.slice(2);
      process.exitCode = await runPnpm(options.root, args.length ? args : ['test:execution'], env);
    } finally { await stopTestDatabase(options); }
  });
} catch { process.stderr.write('Execution database operation failed or ownership was refused. No credentials are logged.\n'); process.exitCode = 1; }
