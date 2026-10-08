// Applies pending migrations to the database at DATABASE_PATH.
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';

const db = createDb(loadConfig().databasePath);
try {
  for (const file of migrate(db)) console.log(`applied ${file}`);
  console.log('migrations up to date');
} finally {
  db.close();
}
