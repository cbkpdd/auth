import { createHmac } from 'node:crypto';
import { safeEqual, sha256 } from './hash.js';

// Signs app-to-auth calls (/apps/register, /token, /revoke, /introspect) and the
// Dash webhook. The signature covers the timestamp, method, path and body hash,
// so a captured request can't be replayed later or pointed at another route.
export const HEADERS = {
  app: 'x-kpdd-app',
  timestamp: 'x-kpdd-timestamp',
  signature: 'x-kpdd-signature',
};

export const MAX_SKEW_SECONDS = 300;

export function canonical({ timestamp, method, path, body = '' }) {
  return [timestamp, method.toUpperCase(), path, sha256(body)].join('\n');
}

export function signRequest({ secret, timestamp = Math.floor(Date.now() / 1000), method, path, body = '' }) {
  const signature = createHmac('sha256', secret).update(canonical({ timestamp, method, path, body })).digest('base64url');
  return { timestamp: String(timestamp), signature };
}

// Returns { ok: true } or { ok: false, reason }. `secrets` may hold the current and
// previous secret during a rotation overlap.
export function verifyRequest({ secrets, timestamp, signature, method, path, body = '', now = Date.now() }) {
  const ts = Number(timestamp);
  if (!Number.isInteger(ts)) return { ok: false, reason: 'bad_timestamp' };
  if (Math.abs(now / 1000 - ts) > MAX_SKEW_SECONDS) return { ok: false, reason: 'stale_timestamp' };
  if (!signature) return { ok: false, reason: 'missing_signature' };

  const message = canonical({ timestamp: ts, method, path, body });
  for (const secret of secrets.filter(Boolean)) {
    const expected = createHmac('sha256', secret).update(message).digest('base64url');
    if (safeEqual(expected, signature)) return { ok: true };
  }
  return { ok: false, reason: 'bad_signature' };
}
