import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createDb, inSeconds } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { createKeyStore, retireOldKeys } from '../src/crypto/keys.js';
import { signJwt, verifyJwt } from '../src/crypto/jwt.js';

function freshDb() {
  const db = createDb(':memory:');
  migrate(db);
  return db;
}

test('migrations apply once and record themselves', () => {
  const db = createDb(':memory:');
  assert.deepEqual(migrate(db), ['001_init.sql']);
  assert.deepEqual(migrate(db), []);
  const tables = db.all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name);
  for (const t of ['users', 'sessions', 'refresh_tokens', 'signing_keys', 'directory_queue', 'sync_state']) {
    assert.ok(tables.includes(t), t);
  }
});

test('schema enforces foreign keys, case-insensitive email and scope format', () => {
  const db = freshDb();
  db.run('INSERT INTO users (id, email, name) VALUES (?, ?, ?)', [randomUUID(), 'Jane@KPDD.com', 'Jane']);
  assert.throws(() => db.run('INSERT INTO users (id, email, name) VALUES (?, ?, ?)', [randomUUID(), 'jane@kpdd.com', 'Dup']), /UNIQUE/);
  assert.throws(() => db.run("INSERT INTO identities (user_id, provider, provider_sub) VALUES ('nobody', 'google', 'x')"), /FOREIGN KEY/);
  assert.throws(() => db.run("INSERT INTO users (id, name, tier) VALUES ('u2', 'X', 'god')"), /CHECK/);

  db.run("INSERT INTO apps (id, name) VALUES ('marketing', 'Listing Marketing')");
  const scope = (s) => db.run("INSERT INTO scopes (app_id, scope, default_min_tier) VALUES ('marketing', ?, 'agent')", [s]);
  scope('marketing:post:draft');
  assert.throws(() => scope('marketing:post'), /CHECK/);
  assert.throws(() => scope('marketing:post:draft:extra'), /CHECK/);
  assert.throws(() => scope('Marketing:Post:Draft'), /CHECK/);
  assert.throws(() => db.run("INSERT INTO apps (id, name) VALUES ('Bad App', 'x')"), /CHECK/);
});

test('tx rolls back every write when one fails', () => {
  const db = freshDb();
  assert.throws(() => db.tx(() => {
    db.run("INSERT INTO users (id, email, name) VALUES ('u1', 'a@kpdd.com', 'A')");
    db.run("INSERT INTO users (id, email, name) VALUES ('u2', 'a@kpdd.com', 'B')");
  }));
  assert.equal(db.get('SELECT count(*) AS n FROM users').n, 0);
});

test('key store signs with the active key and keeps the old one in JWKS after rotation', async () => {
  const db = freshDb();
  const keys = createKeyStore({ db, masterKey: randomBytes(32) });
  assert.throws(() => keys.activeKey(), /No active signing key/);

  const first = keys.rotate();
  const token = signJwt({ sub: 'u1', exp: Math.floor(Date.now() / 1000) + 600 }, keys.activeKey());
  const second = keys.rotate();

  assert.equal(keys.activeKey().kid, second);
  assert.deepEqual(keys.publicJwks().keys.map((k) => k.kid), [second, first]);
  assert.equal((await verifyJwt(token, { getKey: keys.publicKey })).sub, 'u1');

  const stored = db.get('SELECT private_key_enc FROM signing_keys WHERE kid = ?', [first]).private_key_enc;
  assert.ok(!stored.includes('PRIVATE KEY'));
});

test('retiring drops old keys from JWKS only after the grace period', () => {
  const db = freshDb();
  const keys = createKeyStore({ db, masterKey: randomBytes(32) });
  const first = keys.rotate();
  keys.rotate();

  assert.equal(retireOldKeys(db), 0);
  db.run('UPDATE signing_keys SET rotated_at = ? WHERE kid = ?', [inSeconds(-7200), first]);
  assert.equal(retireOldKeys(db), 1);
  assert.equal(keys.publicJwks().keys.length, 1);
  assert.equal(keys.publicKey(first), undefined);
});
