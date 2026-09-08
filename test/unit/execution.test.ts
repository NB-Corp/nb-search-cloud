import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SecretVault } from '../../src/execution/crypto.js';
import { canonicalContent } from '../../src/execution/idempotency.js';
import { operation, resolveChannelOperation } from '../../src/execution/catalog.js';
import { resolveProviderOperation } from '@nb-corp/nb-search';
import { publicUrl } from '../../src/egress/address.js';
import { planTimeoutMaximum, resolvePlanTimeout } from '../../src/execution/plans.js';
import type { Json } from '../../src/execution/types.js';

const s = (query: Json, extra: Record<string, Json> = {}) => canonicalContent('search', { action: 'run', execution: 'async', idempotency_key: 'k1', query, ...extra });
const f = (extra: Record<string, Json> = {}) => canonicalContent('fetch', { action: 'run', execution: 'async', idempotency_key: 'k1', source: { kind: 'url', url: 'https://example.com/' }, ...extra });

describe('execution primitives (no SDK or provider invocation)', () => {
  it('encrypts once per nonce and authenticates every subject/version component', () => {
    const vault = new SecretVault('test-v1', randomBytes(32).toString('base64'));
    const subject = { tenantId: randomUUID(), providerId: randomUUID(), configId: randomUUID(), version: 1 };
    const a = vault.encrypt(subject, 'fake-provider-canary-not-a-credential');
    const b = vault.encrypt(subject, 'fake-provider-canary-not-a-credential');
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.ciphertext.toString()).not.toContain('fake-provider-canary');
    expect(vault.decrypt(subject, a)).toBe('fake-provider-canary-not-a-credential');
    for (const changed of [{ ...subject, tenantId: randomUUID() }, { ...subject, providerId: randomUUID() }, { ...subject, configId: randomUUID() }, { ...subject, version: 2 }]) expect(() => vault.decrypt(changed, a)).toThrow('Service unavailable.');
    expect(() => vault.decrypt(subject, { ...a, auth_tag: Buffer.alloc(16) })).toThrow('Service unavailable.');
    expect(() => vault.decrypt(subject, { ...a, secret_key_id: 'other' })).toThrow('Service unavailable.');
    expect(() => new SecretVault('test', 'not-a-key')).toThrow('Service unavailable.');
  });
  it('has exact compact wire bytes independently of first-plan defaults', () => {
    expect(s('q').toString()).toBe('{"action":"run","execution":"async","query":["q"]}');
    expect(s('q').equals(s(['q']))).toBe(true);
    expect(s(['a', 'b']).equals(s(['b', 'a']))).toBe(false);
    for (const extra of [{ max_results: 10 }, { timeout_ms: 30000 }]) expect(s('q').equals(s('q', extra))).toBe(false);
    expect(s('q', { lane: 'exa.search' }).equals(s('q', { lanes: ['exa.search'] }))).toBe(false);
    expect(s('q', { preset: 'p' }).equals(s('q', { lanes: ['exa.search'] }))).toBe(false);
    expect(s(['q', 'q']).equals(s('q'))).toBe(false);
    expect(s('é').equals(s('e\u0301'))).toBe(false);
    expect(f().toString()).toBe('{"action":"run","execution":"async","representation":"markdown","source":{"kind":"url","url":"https://example.com/"}}');
    expect(f().equals(f({ representation: 'markdown' }))).toBe(true);
    expect(f().equals(f({ representation: 'text' }))).toBe(false);
  });
  it('admits only audited operation identities and deterministic endpoint paths', () => {
    expect(operation('exa', 'search').kind).toBe('search');
    expect(() => operation('exa', 'synthesis')).toThrow();
    expect(() => operation('direct-http', 'fetch')).toThrow();
    for (const [provider, op, options] of [['exa', 'search', { search_path: '/custom' }], ['exa', 'contents', {}], ['grok-multi-agent', 'research', { api_mode: 'messages' }]] as const) {
      const base = 'https://provider.example/api';
      expect(resolveChannelOperation(provider, op, base, options)).toEqual(resolveProviderOperation(provider, op, { provider_id: provider, enabled: true, base_url: base, options }));
    }
    // Network policy is Cloud's concern; adapter URL and option semantics are SDK's.
    expect(() => publicUrl('https://user:pass@provider.example')).toThrow();
    expect(() => publicUrl('http://provider.example')).toThrow();
  });
  it('uses GMA operation identity for async timeout defaults while keeping sync and fetch caps', () => {
    const gma = { provider_id: 'grok-multi-agent' as const, operation_id: 'research' as const };
    const exa = { provider_id: 'exa' as const, operation_id: 'search' as const };
    expect(resolvePlanTimeout('search', 'async', [gma], undefined)).toBe(600_000);
    expect(resolvePlanTimeout('search', 'sync', [gma], undefined)).toBe(120_000);
    expect(resolvePlanTimeout('search', 'async', [exa], undefined)).toBe(30_000);
    expect(resolvePlanTimeout('fetch', 'sync', [gma], undefined)).toBe(60_000);
    expect(resolvePlanTimeout('search', 'async', [gma], 7_000)).toBe(7_000);
    expect(planTimeoutMaximum('search', 'async')).toBe(3_600_000);
    expect(planTimeoutMaximum('search', 'sync')).toBe(120_000);
    expect(planTimeoutMaximum('fetch', 'sync')).toBe(120_000);
  });
});
