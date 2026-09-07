import { buildApp } from './app.js';
import { closeDb, createDb, type DbHandle } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { loadDatabaseUrl, loadEnv } from './env.js';

let db: DbHandle | undefined;
try {
  if (process.argv[2] === 'migrate') {
    const databaseUrl = loadDatabaseUrl();
    const migrationUrl = process.env['MIGRATION_DATABASE_URL'];
    if (!migrationUrl) throw new Error('MIGRATION_OWNER_REQUIRED');
    const { grantRuntimeAccess, migrationConnections } = await import('./db/provision.js');
    const { runtime } = migrationConnections(migrationUrl, databaseUrl);
    db = createDb(migrationUrl);
    const version = await runMigrations(db.pool);
    await grantRuntimeAccess(db.pool, runtime.user);
    await closeDb(db); db = undefined;
    process.stdout.write(`schema_version=${version}\n`);
  } else {
    const env = loadEnv();
    db = createDb(env.databaseUrl);
    const { executionService } = await import('./execution/service.js');
    const execution = executionService(db);
    if (process.argv[2] === 'worker') {
      const runtime = await execution.worker();
      const abort = new AbortController();
      const stop = () => abort.abort();
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      try { await runtime.worker.run(abort.signal); }
      finally { await runtime.close(); await closeDb(db); db = undefined; }
    } else {
      const app = buildApp({ env, db, closeDbOnClose: true, registerAdditionalRoutes: execution.register });
      const { registerConsole } = await import('./console.js');
      const consoleEnabled = await registerConsole(app);
      process.stdout.write(JSON.stringify({ event: 'console_static', enabled: consoleEnabled, mode: consoleEnabled ? 'same-origin' : 'api-only' }) + '\n');
      const stop = () => { void app.close(); };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      await app.listen({ host: env.host, port: env.port });
    }
  }
} catch (error) {
  if (db !== undefined) await closeDb(db).catch(() => undefined);
  const message = error instanceof Error && error.name === 'EnvConfigError' ? error.message : 'Service startup failed.';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
