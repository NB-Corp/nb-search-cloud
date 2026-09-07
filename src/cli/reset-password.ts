import { createDb, closeDb } from '../db/client.js';
import { withTransaction, queryOne } from '../db/transaction.js';
import { loadDatabaseUrl } from '../env.js';
import { hashPassword } from '../auth/password.js';
import { appError } from '../errors.js';
import { randomUUID } from 'node:crypto';

interface Args { tenant: string; username: string; passwordStdin: boolean }

function parseArgs(argv: string[]): Args {
  let tenant: string | undefined;
  let username: string | undefined;
  let passwordStdin = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--tenant') tenant = argv[++index];
    else if (arg === '--username') username = argv[++index];
    else if (arg === '--password-stdin') passwordStdin = true;
    else if (arg === '--password' || arg?.startsWith('--password=')) throw new Error('Password must not be supplied as an argument.');
    else if (arg !== undefined) throw new Error('Unknown argument.');
  }
  if (tenant === undefined || username === undefined) throw new Error('Usage: reset-password --tenant <slug> --username <name> [--password-stdin]');
  if (!passwordStdin && !process.stdin.isTTY) throw new Error('Use --password-stdin when providing a private pipe.');
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(tenant)) throw new Error('Invalid tenant slug.');
  if (!/^[a-z0-9._-]{1,64}$/.test(username)) throw new Error('Invalid username.');
  return { tenant, username, passwordStdin };
}

// Shared TTY implementation handles actual CR/LF, DEL/BS, Ctrl-C and always restores raw mode.
import { readAdminPassword as readPassword } from './password-input.js';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const passwordHash = await hashPassword(await readPassword());
  const db = createDb(loadDatabaseUrl());
  try {
    await withTransaction(db, async (client) => {
      const tenant = await queryOne<{ id: string }>(client, 'SELECT id FROM tenants WHERE slug=$1 FOR UPDATE', [args.tenant]);
      if (tenant === undefined) throw appError('NOT_FOUND');
      const user = await queryOne<{ id: string }>(client, 'SELECT id FROM users WHERE tenant_id=$1 AND username=$2 FOR UPDATE', [tenant.id, args.username]);
      if (user === undefined) throw appError('NOT_FOUND');
      await client.query('UPDATE users SET password_hash=$3,password_version=password_version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2', [tenant.id, user.id, passwordHash]);
      await client.query('UPDATE sessions SET revoked_at=now() WHERE tenant_id=$1 AND user_id=$2 AND revoked_at IS NULL', [tenant.id, user.id]);
      await client.query('INSERT INTO audit_events(id,tenant_id,actor_user_id,action,target_type,target_id,request_id,metadata) VALUES($1,$2,NULL,$3,$4,$5,$6,$7)', [randomUUID(), tenant.id, 'user.password.reset.offline', 'user', user.id, 'reset-password', JSON.stringify({ sessions_revoked: true })]);
    });
    process.stdout.write(`Password reset for ${args.username} in tenant ${args.tenant}.\n`);
  } finally {
    await closeDb(db);
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : 'Password reset failed.';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
