import { isIP } from 'node:net';

export interface DatabaseConnection {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl: false | { rejectUnauthorized: true };
  application_name?: string;
}

/** One interpretation for validation AND pg. Never pass the original URL to pg's second parser.
 * Only application_name and explicit sslmode=disable|verify-full are supported query options.
 * All other options (including encoded/cased/duplicate endpoint or identity overrides) fail closed. */
export function parseDatabaseConnection(value: string): DatabaseConnection {
  try {
    if (value !== value.trim() || /[\u0000-\u0020\u007f\\]/u.test(value) || value.includes('#')) throw new Error();
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error();
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const port = url.port === '' ? 5432 : Number(url.port);
    const user = decodeURIComponent(url.username), password = decodeURIComponent(url.password), database = decodeURIComponent(url.pathname.slice(1));
    // Explicit nonempty fields prevent pg's PGHOST/PGUSER/PGPASSWORD/PGDATABASE fallbacks.
    if (!host || !isIP(host) && !/^[a-z0-9_.-]+$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535 || !user || !password || !database || [host, user, password, database].some((part) => part.includes('\0'))) throw new Error();
    const result: DatabaseConnection = { host, port, user, password, database, ssl: false };
    const seen = new Set<string>();
    for (const [key, option] of url.searchParams) {
      if (seen.has(key)) throw new Error(); seen.add(key);
      if (key === 'application_name' && /^[A-Za-z0-9._-]{1,63}$/.test(option)) result.application_name = option;
      else if (key === 'sslmode' && ['disable', 'verify-full'].includes(option)) result.ssl = option === 'disable' ? false : { rejectUnauthorized: true };
      else throw new Error();
    }
    return result;
  } catch { throw new Error('INVALID_DATABASE_CONNECTION_URL'); }
}
export function sameDatabaseTarget(a: DatabaseConnection, b: DatabaseConnection): boolean {
  return a.host === b.host && a.port === b.port && a.database === b.database;
}
