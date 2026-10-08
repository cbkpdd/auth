import { createPublicKey, sign, verify } from 'node:crypto';

// Minimal JWS compact serialization for EdDSA (Ed25519) only. Anything else in the
// header is rejected, so there is no "alg: none" or algorithm-confusion path.
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

export function signJwt(claims, { kid, privateKey }) {
  const header = { alg: 'EdDSA', typ: 'JWT', kid };
  const input = `${b64(header)}.${b64(claims)}`;
  const sig = sign(null, Buffer.from(input), privateKey).toString('base64url');
  return `${input}.${sig}`;
}

export class JwtError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function decodePart(part) {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    throw new JwtError('malformed');
  }
}

// `getKey(kid)` returns a public JWK or KeyObject, or nothing for an unknown kid.
// Checks signature, then iss, aud, exp and nbf with `leeway` seconds of clock skew.
export async function verifyJwt(token, { getKey, issuer, audience, now = Date.now(), leeway = 30 }) {
  if (typeof token !== 'string') throw new JwtError('malformed');
  const parts = token.split('.');
  if (parts.length !== 3) throw new JwtError('malformed');

  const header = decodePart(parts[0]);
  if (header.alg !== 'EdDSA' || typeof header.kid !== 'string') throw new JwtError('unsupported_alg');

  const jwk = await getKey(header.kid);
  if (!jwk) throw new JwtError('unknown_kid');
  const key = jwk.type === 'public' ? jwk : createPublicKey({ key: jwk, format: 'jwk' });

  const valid = verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
  if (!valid) throw new JwtError('bad_signature');

  const claims = decodePart(parts[1]);
  const t = Math.floor(now / 1000);
  if (issuer !== undefined && claims.iss !== issuer) throw new JwtError('bad_issuer');
  if (audience !== undefined) {
    const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!auds.includes(audience)) throw new JwtError('bad_audience');
  }
  if (typeof claims.exp !== 'number' || t > claims.exp + leeway) throw new JwtError('expired');
  if (typeof claims.nbf === 'number' && t + leeway < claims.nbf) throw new JwtError('not_yet_valid');
  return claims;
}
