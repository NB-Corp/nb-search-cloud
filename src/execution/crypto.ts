import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { appError } from '../errors.js';

export interface SecretSubject { tenantId: string; providerId: string; configId: string; version: number }
export interface EncryptedSecret { secret_key_id: string; nonce: Buffer; ciphertext: Buffer; auth_tag: Buffer }

/** No environment discovery, logging, or secret serialization. The caller supplies deployment configuration. */
export class SecretVault {
  private readonly key: Buffer;
  constructor(readonly keyId: string, base64Key: string) {
    const decoded = Buffer.from(base64Key, 'base64');
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId) || decoded.length !== 32 || decoded.toString('base64') !== base64Key) throw appError('UNAVAILABLE');
    this.key = decoded;
  }
  encrypt(subject: SecretSubject, value: string): EncryptedSecret {
    if (Buffer.byteLength(value, 'utf8') < 1 || Buffer.byteLength(value, 'utf8') > 8192 || /[\u0000-\u001f\u007f]/u.test(value)) throw appError('VALIDATION_FAILED');
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(aad(subject, this.keyId));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return { secret_key_id: this.keyId, nonce, ciphertext, auth_tag: cipher.getAuthTag() };
  }
  decrypt(subject: SecretSubject, value: EncryptedSecret): string {
    try {
      if (value.secret_key_id !== this.keyId || value.nonce.length !== 12 || value.auth_tag.length !== 16) throw new Error();
      const cipher = createDecipheriv('aes-256-gcm', this.key, value.nonce);
      cipher.setAAD(aad(subject, value.secret_key_id));
      cipher.setAuthTag(value.auth_tag);
      return Buffer.concat([cipher.update(value.ciphertext), cipher.final()]).toString('utf8');
    } catch { throw appError('UNAVAILABLE'); }
  }
}
function aad(subject: SecretSubject, keyId: string): Buffer {
  if (!Number.isSafeInteger(subject.version) || subject.version < 1) throw appError('UNAVAILABLE');
  return Buffer.from(JSON.stringify(['nb-search-cloud-provider-config', 1, subject.tenantId, subject.providerId, subject.configId, subject.version, keyId]), 'utf8');
}
