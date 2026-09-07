import { describe, expect, it } from 'vitest';
import { hashPassword, passwordIsValid, verifyPassword } from '../../src/auth/password.js';

describe('password policy', () => {
  it('uses bounded versioned scrypt hashes and timing-safe verification', async () => {
    const password = 'correct horse battery staple';
    const encoded = await hashPassword(password);
    expect(encoded).toMatch(/^scrypt\$1\$131072\$8\$1\$[^$]+\$[^$]+$/);
    expect(await verifyPassword(password, encoded)).toBe(true);
    expect(await verifyPassword('incorrect horse battery staple', encoded)).toBe(false);
    expect(await verifyPassword(password, 'bcrypt$1$not-a-cloud-hash')).toBe(false);
  }, 30_000);

  it('rejects short, overlong, and oversized UTF-8 passwords', () => {
    expect(passwordIsValid('short')).toBe(false);
    expect(passwordIsValid('x'.repeat(129))).toBe(false);
    expect(passwordIsValid('你'.repeat(128))).toBe(true);
    expect(passwordIsValid('你'.repeat(200))).toBe(false);
    expect(passwordIsValid('valid-password-123')).toBe(true);
  });
});
