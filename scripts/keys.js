// Manage signing keys.
//   npm run auth:keys              list keys
//   npm run auth:keys -- --create  create the first key, or rotate (new active, old retiring)
//   npm run auth:keys -- --retire  retire keys that stopped signing over an hour ago
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { createKeyStore, retireOldKeys } from '../src/crypto/keys.js';

const { values } = parseArgs({ options: { create: { type: 'boolean' }, retire: { type: 'boolean' } } });
const config = loadConfig({ require: values.create ? ['AUTH_MASTER_KEY'] : [] });
const db = createDb(config.databasePath);
migrate(db);

try {
  if (values.create) {
    console.log(`active signing key: ${createKeyStore({ db, masterKey: config.masterKey }).rotate()}`);
  } else if (values.retire) {
    console.log(`retired ${retireOldKeys(db)} key(s)`);
  } else {
    console.table(db.all('SELECT kid, status, created_at, rotated_at FROM signing_keys ORDER BY created_at DESC'));
  }
} finally {
  db.close();
}
