import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { randomToken } from './hash.js';
import { inSeconds, now } from '../db.js';

// Private halves are stored AES-256-GCM encrypted under AUTH_MASTER_KEY.
// Format: v1.<iv>.<tag>.<ciphertext>, all base64url.
export function encryptPrivateKey(pem, masterKey) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  const ct = Buffer.concat([cipher.update(pem, 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), ct].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}

export function decryptPrivateKey(stored, masterKey) {
  const [version, iv, tag, ct] = stored.split('.');
  if (version !== 'v1') throw new Error(`Unknown private key format: ${version}`);
  const decipher = createDecipheriv('aes-256-gcm', masterKey, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}

export function generateSigningKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const kid = randomToken(12);
  const publicJwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'EdDSA', use: 'sig' };
  return { kid, publicJwk, privatePem: privateKey.export({ format: 'pem', type: 'pkcs8' }) };
}

// Key store over the signing_keys table. The active key signs; active and retiring
// keys are published in JWKS so tokens signed before a rotation still verify.
export function createKeyStore({ db, masterKey }) {
  let cached;

  function activeKey() {
    if (cached) return cached;
    const row = db.get("SELECT kid, private_key_enc FROM signing_keys WHERE status = 'active'");
    if (!row) throw new Error('No active signing key. Run: npm run auth:keys -- --create');
    cached = { kid: row.kid, privateKey: createPrivateKey(decryptPrivateKey(row.private_key_enc, masterKey)) };
    return cached;
  }

  function publicJwks() {
    const rows = db.all(
      "SELECT public_jwk FROM signing_keys WHERE status IN ('active', 'retiring') ORDER BY created_at DESC",
    );
    return { keys: rows.map((r) => JSON.parse(r.public_jwk)) };
  }

  function publicKey(kid) {
    const row = db.get(
      "SELECT public_jwk FROM signing_keys WHERE kid = ? AND status IN ('active', 'retiring')",
      [kid],
    );
    return row ? createPublicKey({ key: JSON.parse(row.public_jwk), format: 'jwk' }) : undefined;
  }

  // Inserts a new active key and moves the old one to retiring, in one transaction.
  function rotate() {
    const key = generateSigningKey();
    db.tx(() => {
      db.run("UPDATE signing_keys SET status = 'retiring', rotated_at = ? WHERE status = 'active'", [now()]);
      db.run(
        'INSERT INTO signing_keys (kid, public_jwk, private_key_enc) VALUES (?, ?, ?)',
        [key.kid, JSON.stringify(key.publicJwk), encryptPrivateKey(key.privatePem, masterKey)],
      );
    });
    cached = undefined;
    return key.kid;
  }

  return { activeKey, publicJwks, publicKey, rotate };
}

// Access and service tokens live 10 minutes; an hour after rotation leaves plenty of margin.
export function retireOldKeys(db, olderThanSeconds = 3600) {
  return db.run(
    "UPDATE signing_keys SET status = 'retired' WHERE status = 'retiring' AND rotated_at < ?",
    [inSeconds(-olderThanSeconds)],
  ).changes;
}
