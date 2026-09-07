import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPnpm, startTestDatabase, stopTestDatabase, testDatabaseStatus, withControlLock } from './test-database-control.mjs';

const options = { root: resolve(dirname(fileURLToPath(import.meta.url)), '..'), name: 'nbcloud-task18-test-pg17', project: 'nbcloud-task18-test', database: 'nbcloud_test_task18', port: 55432 };
const args = process.argv.slice(2);
try {
  if (args[0] === '--help') process.stdout.write('Use --with pnpm test:identity for a provisioned owner/runtime test cycle; --status and --stop validate the exact recorded container ID. Unknown/stale ownership is refused. Credential state is private and never printed.\n');
  else if (args[0] === '--status') await testDatabaseStatus(options);
  else await withControlLock(options, async () => {
    if (args[0] === '--stop') return stopTestDatabase(options);
    if (args.length && (args[0] !== '--with' || args[1] !== 'pnpm' || args.length < 3)) throw new Error('INVALID_TEST_COMMAND');
    if (args[0] === '--with') {
      try { const { env } = await startTestDatabase(options); process.exitCode = await runPnpm(options.root, args.slice(2), env); }
      finally { await stopTestDatabase(options); }
    } else await startTestDatabase(options);
  });
} catch { process.stderr.write('Test database operation failed or ownership was refused. No credentials are logged.\n'); process.exitCode = 1; }
