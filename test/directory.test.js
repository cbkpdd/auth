import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, now } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { createStaffClient } from '../src/directory/client.js';
import { drainDirectoryQueue, syncDirectory } from '../src/directory/sync.js';
import { createApp } from '../src/app.js';
import { signRequest } from '../src/crypto/hmac.js';

const rec = (id, over = {}) => ({
  dash_staff_id: `guid-${id}`, email: `p${id}@kpdd.com`, name: `Person ${id}`, active: true, licensed: true,
  roles: ['SA'], title: 'Sales Associate', office: 'Columbus', mls_ids: [], merged_into: null,
  updated_at: '2026-10-08T12:00:00Z', ...over,
});

// A fake kpdd.com staff API over an array of records, following docs/kpdd-api.md.
function fakeApi(records, { asOf = '2026-10-08T12:00:00Z' } = {}) {
  const calls = [];
  const fetch = async (url) => {
    const u = new URL(url);
    calls.push(u.pathname + u.search);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const one = u.pathname.match(/^\/api\/staff\/(.+)$/);
    if (one) {
      const r = records.find((x) => x.dash_staff_id === decodeURIComponent(one[1]));
      return r ? json(r) : json({ error: 'not_found' }, 404);
    }
    const since = u.searchParams.get('updated_since');
    const limit = Number(u.searchParams.get('limit'));
    const start = Number(u.searchParams.get('cursor') ?? 0);
    const rows = records.filter((r) => !since || r.updated_at >= since);
    const data = rows.slice(start, start + limit);
    return json({ data, next_cursor: start + limit < rows.length ? String(start + limit) : null, as_of: asOf });
  };
  return { client: createStaffClient({ url: 'https://kpdd.test/api', key: 'k', fetch }), calls };
}

function freshDb() {
  const db = createDb(':memory:');
  migrate(db);
  return db;
}

const user = (db, id) => db.get('SELECT * FROM users WHERE dash_staff_id = ?', [`guid-${id}`]);

test('full import creates active people only, with tier, roles and team MLS IDs', async () => {
  const db = freshDb();
  const team = { mls: 'CBOR', mls_id: 'TEAM1' };
  const { client } = fakeApi([
    rec(1, { mls_ids: [{ mls: 'CBOR', mls_id: 'A1' }, team] }),
    rec(2, { mls_ids: [team] }),
    rec(3, { licensed: false, roles: ['BK'] }),
    rec(4, { active: false, licensed: false, roles: [] }),
    rec(5, { email: null, roles: ['BR'] }),
  ]);
  const report = await syncDirectory({ db, client });

  assert.deepEqual([report.created, report.skipped, report.records], [4, 1, 5]);
  assert.equal(user(db, 1).tier, 'agent');
  assert.equal(user(db, 3).tier, 'staff');
  assert.deepEqual(JSON.parse(user(db, 3).dash_roles), ['BK']);
  assert.equal(user(db, 4), undefined);
  assert.equal(user(db, 5).email, null);
  assert.deepEqual(report.warnings, [{ dash_staff_id: 'guid-5', code: 'no_email' }]);
  assert.equal(db.get("SELECT count(*) AS n FROM user_mls_ids WHERE mls_id = 'TEAM1'").n, 2);
  assert.equal(db.get("SELECT value FROM sync_state WHERE key = 'directory.last_as_of'").value, '2026-10-08T12:00:00Z');
});

test('dry run reports exact counts and writes nothing', async () => {
  const db = freshDb();
  const { client } = fakeApi([rec(1), rec(2), rec(3, { active: false })]);
  const report = await syncDirectory({ db, client, dryRun: true });

  assert.equal(report.created, 2);
  assert.equal(report.after.active, 2);
  assert.equal(db.get('SELECT count(*) AS n FROM users').n, 0);
  assert.equal(db.get('SELECT count(*) AS n FROM sync_state').n, 0);
  assert.equal(db.get('SELECT count(*) AS n FROM audit_log').n, 0);
});

test('second run is incremental from the stored as_of and leaves unchanged records alone', async () => {
  const db = freshDb();
  const records = [rec(1), rec(2)];
  await syncDirectory({ db, client: fakeApi(records).client });

  records[1] = rec(2, { name: 'Renamed', updated_at: '2026-10-09T08:00:00Z' });
  const { client, calls } = fakeApi(records, { asOf: '2026-10-09T09:00:00Z' });
  const report = await syncDirectory({ db, client });

  assert.match(calls[0], /updated_since=2026-10-08T12%3A00%3A00Z/);
  assert.equal(report.mode, 'incremental');
  // updated_since is inclusive, so record 1 (stamped exactly at as_of) comes back and is left alone.
  assert.deepEqual([report.records, report.updated, report.unchanged], [2, 1, 1]);
  assert.equal(db.get("SELECT count(*) AS n FROM audit_log WHERE target = ?", [user(db, 1).id]).n, 1);
  assert.equal(user(db, 2).name, 'Renamed');
});

test('a departure disables the user and revokes sessions and refresh tokens together', async () => {
  const db = freshDb();
  const records = [rec(1)];
  await syncDirectory({ db, client: fakeApi(records).client });
  const u = user(db, 1);
  db.run("INSERT INTO apps (id, name, status) VALUES ('account', 'Account', 'active')");
  db.run("INSERT INTO sessions (id, token_hash, user_id, expires_at) VALUES ('s1', 'h1', ?, '2099-01-01T00:00:00Z')", [u.id]);
  db.run("INSERT INTO refresh_tokens (id, session_id, app_id, family_id, token_hash, expires_at) VALUES ('r1', 's1', 'account', 'f1', 'rh1', '2099-01-01T00:00:00Z')");

  records[0] = rec(1, { active: false, licensed: false, roles: [] });
  const report = await syncDirectory({ db, client: fakeApi(records).client, full: true });

  assert.equal(report.disabled, 1);
  assert.equal(user(db, 1).status, 'disabled');
  assert.ok(db.get("SELECT revoked_at FROM sessions WHERE id = 's1'").revoked_at);
  assert.ok(db.get("SELECT revoked_at FROM refresh_tokens WHERE id = 'r1'").revoked_at);
  assert.equal(db.get("SELECT count(*) AS n FROM audit_log WHERE action = 'user.disabled'").n, 1);
});

test('a merge disables the loser and moves its sign-in identities to the survivor', async () => {
  const db = freshDb();
  const records = [rec(1), rec(2, { email: 'p2-old@kpdd.com' })];
  await syncDirectory({ db, client: fakeApi(records).client });
  db.run("INSERT INTO identities (user_id, provider, provider_sub) VALUES (?, 'google', 'g-2')", [user(db, 2).id]);

  records[1] = rec(2, { active: false, merged_into: 'guid-1', email: 'p2-old@kpdd.com' });
  const report = await syncDirectory({ db, client: fakeApi(records).client, full: true });

  assert.equal(report.merged, 1);
  assert.equal(user(db, 2).status, 'disabled');
  assert.equal(db.get("SELECT user_id FROM identities WHERE provider_sub = 'g-2'").user_id, user(db, 1).id);
});

test('a tier set in the panel survives sync; a dash tier follows licensed', async () => {
  const db = freshDb();
  const records = [rec(1), rec(2)];
  await syncDirectory({ db, client: fakeApi(records).client });
  db.run("UPDATE users SET tier = 'director', tier_source = 'panel' WHERE dash_staff_id = 'guid-1'");

  records[0] = rec(1, { licensed: false, roles: ['OM'] });
  records[1] = rec(2, { licensed: false, roles: ['BK'] });
  await syncDirectory({ db, client: fakeApi(records).client, full: true });

  assert.equal(user(db, 1).tier, 'director');
  assert.equal(user(db, 2).tier, 'staff');
});

test('an email moves from a disabled user; an active holder keeps it and the newcomer is reported', async () => {
  const db = freshDb();
  const records = [rec(1, { email: 'shared@kpdd.com' })];
  await syncDirectory({ db, client: fakeApi(records).client });

  // Rehire under a new Dash record while the old one is inactive: the email moves.
  records[0] = rec(1, { email: 'shared@kpdd.com', active: false });
  records.push(rec(2, { email: 'shared@kpdd.com' }));
  await syncDirectory({ db, client: fakeApi(records).client, full: true });
  assert.equal(user(db, 2).email, 'shared@kpdd.com');
  assert.equal(user(db, 1).email, null);

  // Two active records claiming one email: the first holder keeps it.
  records.push(rec(3, { email: 'shared@kpdd.com' }));
  const report = await syncDirectory({ db, client: fakeApi(records).client, full: true });
  assert.equal(user(db, 3).email, null);
  assert.deepEqual(report.warnings, [{ dash_staff_id: 'guid-3', code: 'email_in_use' }]);
});

test('client waits out a 429 and stops on a key error without retrying', async () => {
  let n = 0;
  const waits = [];
  const fetch429 = async () => (++n === 1
    ? new Response('{}', { status: 429, headers: { 'retry-after': '7' } })
    : new Response(JSON.stringify({ data: [], next_cursor: null, as_of: 'x' }), { status: 200 }));
  const c1 = createStaffClient({ url: 'u', key: 'k', fetch: fetch429, wait: async (ms) => waits.push(ms) });
  for await (const _ of c1.pages()) { /* drain */ }
  assert.deepEqual(waits, [7000]);

  let calls = 0;
  const fetch403 = async () => { calls++; return new Response(JSON.stringify({ error: 'insufficient_scope' }), { status: 403 }); };
  const c2 = createStaffClient({ url: 'u', key: 'k', fetch: fetch403, wait: async () => {} });
  await assert.rejects(c2.get('x'), { status: 403, message: /insufficient_scope/ });
  assert.equal(calls, 1);
});

test('queue drains one by one up to 20, and switches to one sync above that', async () => {
  const db = freshDb();
  const records = Array.from({ length: 25 }, (_, i) => rec(i));
  const queue = (ids) => ids.forEach((i) => db.run('INSERT INTO directory_queue (dash_staff_id, queued_at) VALUES (?, ?)', [`guid-${i}`, now()]));

  queue([0, 1, 2]);
  const small = fakeApi(records);
  const r1 = await drainDirectoryQueue({ db, client: small.client });
  assert.deepEqual([r1.mode, r1.processed, small.calls.length], ['one-by-one', 3, 3]);

  queue(Array.from({ length: 25 }, (_, i) => i));
  const big = fakeApi(records);
  const r2 = await drainDirectoryQueue({ db, client: big.client });
  assert.equal(r2.mode, 'sync');
  assert.equal(big.calls.length, 1);
  assert.equal(db.get('SELECT count(*) AS n FROM directory_queue').n, 0);
  assert.equal(db.get('SELECT count(*) AS n FROM users').n, 25);
});

test('webhook queues a signed event with 202 and rejects bad or missing signatures', async () => {
  const db = freshDb();
  const config = { issuer: 'https://auth.kpdd.com', dashWebhookSecret: 'whsec' };
  const server = createApp({ config, db, keys: { publicJwks: () => ({ keys: [] }) } }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}/directory/sync`;
  const body = JSON.stringify({ event: 'staff.updated', dash_staff_id: 'guid-9', occurred_at: '2026-10-08T14:02:11Z' });
  const post = (headers) => fetch(url, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });

  try {
    const { timestamp, signature } = signRequest({ secret: 'whsec', method: 'POST', path: '/directory/sync', body });
    assert.equal((await post({ 'x-kpdd-timestamp': timestamp, 'x-kpdd-signature': signature })).status, 202);
    assert.equal(db.get('SELECT dash_staff_id FROM directory_queue').dash_staff_id, 'guid-9');

    const forged = signRequest({ secret: 'wrong', method: 'POST', path: '/directory/sync', body });
    assert.equal((await post({ 'x-kpdd-timestamp': forged.timestamp, 'x-kpdd-signature': forged.signature })).status, 401);
    assert.equal((await post({})).status, 401);
  } finally {
    server.close();
  }
});
