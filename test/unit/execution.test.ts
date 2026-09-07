import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SecretVault } from '../../src/execution/crypto.js';
import { canonicalContent } from '../../src/execution/idempotency.js';
import { endpoint, operation, providerBase, providerOptions } from '../../src/execution/catalog.js';
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
    const base = providerBase('exa', 'https://provider.example/api');
    expect(endpoint(base, 'exa', 'search', {})).toBe('https://provider.example/api/search');
    expect(endpoint(base, 'exa', 'contents', {})).toBe('https://provider.example/api/contents');
    expect(endpoint('https://provider.example/v1', 'grok-multi-agent', 'research', { api_mode: 'messages' })).toBe('https://provider.example/v1/messages');
    expect(() => endpoint('https://provider.example/v1/responses', 'grok-multi-agent', 'research', { api_mode: 'messages' })).toThrow();
    expect(() => providerOptions('exa', { search_path: '/private' })).toThrow();
    expect(() => providerBase('exa', 'https://user:pass@provider.example')).toThrow();
    expect(() => providerBase('exa', 'http://provider.example')).toThrow();
  });
});
