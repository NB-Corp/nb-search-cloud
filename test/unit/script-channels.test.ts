import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { ScriptChannels } from '../../src/execution/script-channels.js';
import { loadEnv } from '../../src/env.js';
it('resolves only operator manifest modules, keeps paths out of catalog, and merges JSON params without executing modules', async () => {
  const home = await mkdtemp(resolve(tmpdir(), 'cloud-script-manifest-'));
  try {
    await writeFile(resolve(home, 'fixture.mjs'), "throw Error('must not import during configuration');");
    const path = resolve(home, 'manifest.json');
    await writeFile(path, JSON.stringify({ channels: [{ id: 'notes', label: 'Notes', module: './fixture.mjs', params: { collection: 'public', nested: { a: 1 } } }] }));
    const registry = new ScriptChannels(path);
    expect(registry.list()).toEqual([{ id: 'notes', label: 'Notes' }]);
    expect(registry.resolve({ channel_id: 'notes', params: { collection: 'local' } })).toEqual({ options: { module: resolve(home, 'fixture.mjs'), params: { collection: 'local', nested: { a: 1 } } }, endpoints: [] });
    expect(() => registry.options({ channel_id: 'missing' })).toThrow();
    expect(() => registry.options({ channel_id: 'notes', module: './evil.mjs' })).toThrow();
    expect(() => registry.options({ channel_id: 'notes', endpoints: ['https://example.com'] })).toThrow();
    expect(() => new ScriptChannels(resolve(home, 'missing.json'))).toThrow('SCRIPT_CHANNEL_MANIFEST_INVALID');
  } finally { await rm(home, { recursive: true, force: true }); }
});
it('separates container bind address from loopback cookie origin', () => {
  const source = { DATABASE_URL: 'postgres://runtime:fake-password@db:5432/cloud', PUBLIC_ORIGIN: 'http://127.0.0.1:18380', COOKIE_MODE: 'loopback', HOST: '0.0.0.0' };
  expect(loadEnv(source).host).toBe('0.0.0.0');
  expect(() => loadEnv({ ...source, PUBLIC_ORIGIN: 'http://public.example' })).toThrow();
});
