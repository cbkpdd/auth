import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

// Opaque tokens (refresh, session, auth code, magic link): 256 bits, base64url.
export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

// Lookup hash for high-entropy tokens. No salt needed: the input is random.
export function sha256(value) {
  return createHash('sha256').update(value).digest('base64url');
}

export function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// Registrant secrets. Format: scrypt$N$r$p$salt$hash so parameters can change later.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

export async function scryptHash(secret) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(secret, salt, SCRYPT.keylen, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

export async function scryptVerify(secret, stored) {
  if (!stored) return false;
  const [scheme, N, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = await scryptAsync(secret, Buffer.from(salt, 'base64url'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p),
  });
  return timingSafeEqual(actual, expected);
}
