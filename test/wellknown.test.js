import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

async function withServer(app, fn) {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

const config = { issuer: 'https://auth.kpdd.com' };
const keys = { publicJwks: () => ({ keys: [{ kty: 'OKP', crv: 'Ed25519', x: 'abc', kid: 'k1' }] }) };

test('discovery document points at this issuer', async () => {
  await withServer(createApp({ config, keys }), async (base) => {
    const body = await (await fetch(`${base}/.well-known/kpdd-auth`)).json();
    assert.equal(body.issuer, 'https://auth.kpdd.com');
    assert.equal(body.jwks_uri, 'https://auth.kpdd.com/.well-known/jwks.json');
    assert.deepEqual(body.code_challenge_methods_supported, ['S256']);
  });
});

test('JWKS serves the key store and unknown routes 404', async () => {
  await withServer(createApp({ config, keys }), async (base) => {
    const res = await fetch(`${base}/.well-known/jwks.json`);
    assert.equal((await res.json()).keys[0].kid, 'k1');
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  });
});
