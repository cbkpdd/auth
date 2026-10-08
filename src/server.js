import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { migrate } from './migrate.js';
import { createKeyStore } from './crypto/keys.js';
import { createApp } from './app.js';

const config = loadConfig({ require: ['AUTH_ISSUER', 'AUTH_MASTER_KEY'] });
const db = createDb(config.databasePath);
for (const file of migrate(db)) console.log(`applied ${file}`);
const keys = createKeyStore({ db, masterKey: config.masterKey });

keys.activeKey(); // fail at boot, not on the first sign-in, if no key exists
createApp({ config, db, keys }).listen(config.port, () => {
  console.log(`kpdd-auth listening on :${config.port} as ${config.issuer}`);
});
