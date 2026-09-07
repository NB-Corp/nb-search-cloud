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
  if (tenant === undefined || username === undefined) throw new Error('Usage: bootstrap-admin --tenant <slug> --username <name> [--password-stdin]');
  if (!passwordStdin && !process.stdin.isTTY) throw new Error('Use --password-stdin when providing a private pipe.');
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(tenant)) throw new Error('Invalid tenant slug.');
  if (!/^[a-z0-9._-]{1,64}$/.test(username)) throw new Error('Invalid username.');
  return { tenant, username, passwordStdin };
}

import { readAdminPassword as readPasswordFromStdin } from './password-input.js';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const password = await readPasswordFromStdin();
  const passwordHash = await hashPassword(password);
  const db = createDb(loadDatabaseUrl());
  try {
    await withTransaction(db, async (client) => {
      const existing = await queryOne<{ id: string }>(client, 'SELECT id FROM tenants WHERE slug=$1 FOR UPDATE', [args.tenant]);
      if (existing !== undefined) throw appError('ALREADY_EXISTS');
      const tenantId = randomUUID();
      const userId = randomUUID();
      await client.query('INSERT INTO tenants(id,slug,name,status) VALUES($1,$2,$3,\'active\')', [tenantId, args.tenant, args.tenant]);
      await client.query('INSERT INTO users(id,tenant_id,username,display_name,role,status,password_hash,password_version,restrict_public_groups) VALUES($1,$2,$3,$4,\'admin\',\'active\',$5,1,false)', [userId, tenantId, args.username, args.username, passwordHash]);
      await client.query('INSERT INTO audit_events(id,tenant_id,actor_user_id,action,target_type,target_id,request_id,metadata) VALUES($1,$2,NULL,$3,$4,$5,$6,$7)', [randomUUID(), tenantId, 'bootstrap.admin.create', 'user', userId, 'bootstrap', JSON.stringify({ username: args.username })]);
    });
    process.stdout.write(`Created administrator ${args.username} in tenant ${args.tenant}.\n`);
  } finally {
    await closeDb(db);
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : 'Bootstrap failed.';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
