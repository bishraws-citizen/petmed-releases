import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

/**
 * Password hashing with scrypt from the standard library — deliberately no new
 * dependency for something this sensitive.
 *
 * Stored as `scrypt$N$r$p$salt$hash`, so the cost parameters travel with each
 * hash and can be raised later without invalidating existing passwords.
 */
const PARAMS = { N: 16384, r: 8, p: 1, keyLength: 64 };

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 10) {
    throw new Error('A password must be at least 10 characters.');
  }
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, PARAMS.keyLength, {
    N: PARAMS.N, r: PARAMS.r, p: PARAMS.p, maxmem: 64 * 1024 * 1024,
  });
  return [
    'scrypt', PARAMS.N, PARAMS.r, PARAMS.p,
    salt.toString('base64'), derived.toString('base64'),
  ].join('$');
}

/**
 * Verifies a password against a stored hash.
 *
 * Always returns a boolean rather than throwing on a malformed hash, so a
 * corrupt or empty record fails closed instead of erroring in a way that might
 * be treated differently by a caller.
 */
export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string' || !stored) return false;

  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, n, r, p, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  if (salt.length === 0 || expected.length === 0) return false;

  try {
    const derived = await scrypt(password, salt, expected.length, {
      N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
    });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** A readable one-off password for seeding an account. */
export const generatePassword = () =>
  randomBytes(12).toString('base64url').replace(/[-_]/g, '').slice(0, 14);
