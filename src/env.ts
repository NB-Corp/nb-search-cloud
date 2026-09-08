import { URL } from 'node:url';
import { parseDatabaseConnection } from './db/connection.js';

export type CookieMode = 'loopback' | 'production';

export interface CloudEnv {
  databaseUrl: string;
  publicOrigin: string;
  cookieMode: CookieMode;
  host: string;
  port: number;
  nodeEnv: string;
  loginIpLimit: number;
  loginAccountLimit: number;
}

export class EnvConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvConfigError';
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function required(source: NodeJS.ProcessEnv, key: string): string {
  const value = source[key];
  if (value === undefined || value.length === 0) throw new EnvConfigError(`Missing required environment variable: ${key}`);
  return value;
}

function parseOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new EnvConfigError('PUBLIC_ORIGIN must be an absolute HTTP(S) origin');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== '' && parsed.pathname !== '/')) {
    throw new EnvConfigError('PUBLIC_ORIGIN must be an absolute HTTP(S) origin');
  }
  return parsed.origin;
}

export function loadDatabaseUrl(source: NodeJS.ProcessEnv = process.env): string {
  const value = required(source, 'DATABASE_URL');
  try { parseDatabaseConnection(value); }
  catch { throw new EnvConfigError('DATABASE_URL requires explicit PostgreSQL credentials and target; only application_name and sslmode=disable|verify-full query options are supported.'); }
  return value;
}

function parsePositiveInt(source: NodeJS.ProcessEnv, key: string, fallback: number, max: number): number {
  const raw = source[key];
  if (raw === undefined || raw === '') return fallback;
  if (!/^[0-9]+$/.test(raw)) throw new EnvConfigError(`${key} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new EnvConfigError(`${key} is outside the allowed range`);
  return value;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): CloudEnv {
  const databaseUrl = loadDatabaseUrl(source);
  const publicOrigin = parseOrigin(required(source, 'PUBLIC_ORIGIN'));
  const modeRaw = required(source, 'COOKIE_MODE');
  if (modeRaw !== 'loopback' && modeRaw !== 'production') throw new EnvConfigError('COOKIE_MODE must be loopback or production');
  const originUrl = new URL(publicOrigin);
  if (modeRaw === 'loopback' && (!LOOPBACK_HOSTS.has(originUrl.hostname) || originUrl.protocol !== 'http:')) {
    throw new EnvConfigError('COOKIE_MODE=loopback requires an HTTP loopback PUBLIC_ORIGIN');
  }
  if (modeRaw === 'production' && originUrl.protocol !== 'https:') {
    throw new EnvConfigError('COOKIE_MODE=production requires an HTTPS PUBLIC_ORIGIN');
  }
  const host = source['HOST'] ?? (modeRaw === 'loopback' ? '127.0.0.1' : '0.0.0.0');
  // Cookie trust follows the browser origin, not the container's internal bind address.
  // Operators exposing loopback mode through Docker must publish only to host loopback.
  const port = parsePositiveInt(source, 'PORT', 3000, 65535);
  return {
    databaseUrl,
    publicOrigin,
    cookieMode: modeRaw,
    host,
    port,
    nodeEnv: source['NODE_ENV'] ?? 'development',
    loginIpLimit: parsePositiveInt(source, 'LOGIN_IP_LIMIT', 20, 1000),
    loginAccountLimit: parsePositiveInt(source, 'LOGIN_ACCOUNT_LIMIT', 10, 1000),
  };
}

export function cookieName(env: Pick<CloudEnv, 'cookieMode'>): string {
  return env.cookieMode === 'production' ? '__Host-nbcloud_session' : 'nbcloud_session';
}
