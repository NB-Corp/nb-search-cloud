import { describe, expect, it } from 'vitest';
import { cookieName, EnvConfigError, loadEnv } from '../../src/env.js';

describe('environment and cookie boundaries', () => {
  const base = {
    DATABASE_URL: 'postgres://app:pw@127.0.0.1:55432/nbcloud_test_env',
    PUBLIC_ORIGIN: 'http://127.0.0.1:3000',
    COOKIE_MODE: 'loopback',
  };

  it('requires explicit database, origin, and cookie mode', () => {
    expect(() => loadEnv({ ...base, DATABASE_URL: undefined })).toThrow(EnvConfigError);
    expect(() => loadEnv({ ...base, PUBLIC_ORIGIN: undefined })).toThrow(EnvConfigError);
    expect(() => loadEnv({ ...base, COOKIE_MODE: undefined })).toThrow(EnvConfigError);
  });

  it('keeps loopback cookies non-secure and production cookies host-only secure', () => {
    expect(cookieName({ cookieMode: 'loopback' })).toBe('nbcloud_session');
    expect(cookieName({ cookieMode: 'production' })).toBe('__Host-nbcloud_session');
    const production = loadEnv({ ...base, PUBLIC_ORIGIN: 'https://cloud.example.test', COOKIE_MODE: 'production' });
    expect(production.cookieMode).toBe('production');
    expect(() => loadEnv({ ...base, COOKIE_MODE: 'production' })).toThrow(EnvConfigError);
  });
});
