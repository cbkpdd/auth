import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, randomBytes } from 'node:crypto';
import { randomToken, sha256, scryptHash, scryptVerify } from '../src/crypto/hash.js';
import { signRequest, verifyRequest } from '../src/crypto/hmac.js';
import { signJwt, verifyJwt } from '../src/crypto/jwt.js';
import { decryptPrivateKey, encryptPrivateKey, generateSigningKey } from '../src/crypto/keys.js';

test('randomToken is 256-bit base64url and unique', () => {
  const a = randomToken();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, randomToken());
  assert.equal(sha256(a), sha256(a));
});

test('scrypt hashes verify only the right secret', async () => {
  const stored = await scryptHash('s3cret');
  assert.match(stored, /^scrypt\$16384\$8\$1\$/);
  assert.equal(await scryptVerify('s3cret', stored), true);
  assert.equal(await scryptVerify('wrong', stored), false);
  assert.equal(await scryptVerify('s3cret', null), false);
});

test('HMAC accepts a fresh signature and either rotation secret', () => {
  const req = { method: 'POST', path: '/apps/register', body: '{"id":"marketing"}' };
  const { timestamp, signature } = signRequest({ secret: 'old', ...req });
  assert.deepEqual(verifyRequest({ secrets: ['new', 'old'], timestamp, signature, ...req }), { ok: true });
});

test('HMAC rejects tampering, wrong route and stale timestamps', () => {
  const req = { method: 'POST', path: '/apps/register', body: '{"id":"marketing"}' };
  const { timestamp, signature } = signRequest({ secret: 'k', ...req });
  const check = (over) => verifyRequest({ secrets: ['k'], timestamp, signature, ...req, ...over }).reason;
  assert.equal(check({ body: '{"id":"evil"}' }), 'bad_signature');
  assert.equal(check({ path: '/token' }), 'bad_signature');
  assert.equal(check({ now: Date.now() + 301_000 }), 'stale_timestamp');
  assert.equal(check({ timestamp: 'abc' }), 'bad_timestamp');
});

test('JWT round-trips and checks iss, aud and exp', async () => {
  const k = generateSigningKey();
  const privateKey = createPrivateKey(k.privatePem);
  const now = Math.floor(Date.now() / 1000);
  const token = signJwt({ iss: 'https://auth.kpdd.com', aud: 'account', sub: 'u1', exp: now + 600 }, { kid: k.kid, privateKey });
  const getKey = (kid) => (kid === k.kid ? k.publicJwk : undefined);
  const opts = { getKey, issuer: 'https://auth.kpdd.com', audience: 'account' };

  assert.equal((await verifyJwt(token, opts)).sub, 'u1');
  await assert.rejects(verifyJwt(token, { ...opts, audience: 'marketing' }), { code: 'bad_audience' });
  await assert.rejects(verifyJwt(token, { ...opts, issuer: 'https://evil' }), { code: 'bad_issuer' });
  await assert.rejects(verifyJwt(token, { ...opts, now: (now + 700) * 1000 }), { code: 'expired' });
  await assert.rejects(verifyJwt(token, { ...opts, getKey: () => undefined }), { code: 'unknown_kid' });
});

test('JWT rejects a forged payload and alg none', async () => {
  const k = generateSigningKey();
  const token = signJwt({ sub: 'u1', exp: 9999999999 }, { kid: k.kid, privateKey: createPrivateKey(k.privatePem) });
  const [h, , s] = token.split('.');
  const forged = `${h}.${Buffer.from(JSON.stringify({ sub: 'admin', exp: 9999999999 })).toString('base64url')}.${s}`;
  const getKey = () => k.publicJwk;
  await assert.rejects(verifyJwt(forged, { getKey }), { code: 'bad_signature' });

  const none = `${Buffer.from(JSON.stringify({ alg: 'none', kid: k.kid })).toString('base64url')}.${token.split('.')[1]}.`;
  await assert.rejects(verifyJwt(none, { getKey }), { code: 'unsupported_alg' });
  await assert.rejects(verifyJwt('a.b', { getKey }), { code: 'malformed' });
});

test('private keys encrypt and fail to decrypt under another master key', () => {
  const master = randomBytes(32);
  const { privatePem } = generateSigningKey();
  const enc = encryptPrivateKey(privatePem, master);
  assert.ok(!enc.includes('PRIVATE KEY'));
  assert.equal(decryptPrivateKey(enc, master), privatePem);
  assert.throws(() => decryptPrivateKey(enc, randomBytes(32)));
});
