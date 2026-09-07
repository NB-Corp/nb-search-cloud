import { describe, expect, it } from 'vitest';
import { hashAccessKey, issueAccessKey } from '../../src/auth/api-key.js';

describe('API key boundary', () => {
  it('issues one high entropy token and only a digest/prefix for storage', () => {
    const issued = issueAccessKey();
    expect(issued.accessKey).toMatch(/^nbc_[A-Za-z0-9_-]{43}$/);
    expect(issued.prefix).toBe(issued.accessKey.slice(0, 12));
    expect(issued.hash).toHaveLength(32);
    expect(hashAccessKey(issued.accessKey)).toEqual(issued.hash);
    expect(issued.accessKey).not.toContain(issued.hash.toString('hex'));
  });
});
