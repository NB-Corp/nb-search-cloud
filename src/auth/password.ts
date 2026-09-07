import { randomBytes, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto';
import { appError } from '../errors.js';

export const PASSWORD_SCRYPT_N = 131072;
export const PASSWORD_SCRYPT_R = 8;
export const PASSWORD_SCRYPT_P = 1;
export const PASSWORD_KEY_BYTES = 64;
export const PASSWORD_SALT_BYTES = 16;
const MAX_MEM = 256 * 1024 * 1024;
const MAX_PARALLEL = 2;
const MAX_WAITING = 16;

let active = 0;
const waiters: Array<() => void> = [];

function validatePassword(password: string): void {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128 || Buffer.byteLength(password, 'utf8') > 512) {
    throw appError('VALIDATION_FAILED', { fields: [{ path: 'password', code: 'PASSWORD_LENGTH' }] });
  }
}

function runScrypt(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(password, salt, PASSWORD_KEY_BYTES, {
      N: PASSWORD_SCRYPT_N,
      r: PASSWORD_SCRYPT_R,
      p: PASSWORD_SCRYPT_P,
      maxmem: MAX_MEM,
    }, (error, digest) => error === null ? resolve(digest) : reject(error));
  });
}

async function boundedScrypt(password: string, salt: Buffer): Promise<Buffer> {
  if (active >= MAX_PARALLEL) {
    if (waiters.length >= MAX_WAITING) throw appError('RATE_LIMITED');
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  active += 1;
  try {
    return await runScrypt(password, salt);
  } finally {
    active -= 1;
    waiters.shift()?.();
  }
}

function encode(salt: Buffer, digest: Buffer): string {
  return `scrypt$1$${PASSWORD_SCRYPT_N}$${PASSWORD_SCRYPT_R}$${PASSWORD_SCRYPT_P}$${salt.toString('base64')}$${digest.toString('base64')}`;
}

function parse(encoded: string): { salt: Buffer; digest: Buffer } | null {
  const parts = encoded.split('$');
  if (parts.length !== 7 || parts[0] !== 'scrypt' || parts[1] !== '1' || parts[2] !== String(PASSWORD_SCRYPT_N) || parts[3] !== String(PASSWORD_SCRYPT_R) || parts[4] !== String(PASSWORD_SCRYPT_P)) return null;
  try {
    const salt = Buffer.from(parts[5]!, 'base64');
    const digest = Buffer.from(parts[6]!, 'base64');
    if (salt.length !== PASSWORD_SALT_BYTES || digest.length !== PASSWORD_KEY_BYTES) return null;
    return { salt, digest };
  } catch {
    return null;
  }
}

export async function hashPassword(password: string): Promise<string> {
  validatePassword(password);
  const salt = randomBytes(PASSWORD_SALT_BYTES);
  const digest = await boundedScrypt(password, salt);
  return encode(salt, digest);
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  if (typeof password !== 'string' || typeof encoded !== 'string') return false;
  const parsed = parse(encoded);
  if (parsed === null) return false;
  const digest = await boundedScrypt(password, parsed.salt);
  return digest.length === parsed.digest.length && timingSafeEqual(digest, parsed.digest);
}

const DUMMY_HASH = 'scrypt$1$131072$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';
export async function verifyAgainstDummy(password: string): Promise<boolean> {
  if (typeof password !== 'string') return false;
  return verifyPassword(password, DUMMY_HASH);
}

export function passwordIsValid(password: string): boolean {
  try {
    validatePassword(password);
    return true;
  } catch {
    return false;
  }
}
