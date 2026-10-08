// Sync users from the kpdd.com staff API (docs/kpdd-api.md).
//   npm run auth:import-dash -- --dry-run   report what would change, write nothing
//   npm run auth:import-dash                 incremental since the last run (full on the first)
//   npm run auth:import-dash -- --full       re-read every record
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { createStaffClient } from '../src/directory/client.js';
import { syncDirectory } from '../src/directory/sync.js';

const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean' }, full: { type: 'boolean' } } });
const config = loadConfig({ require: ['KPDD_API_URL', 'KPDD_API_KEY'] });
const db = createDb(config.databasePath);
migrate(db);

try {
  const report = await syncDirectory({
    db,
    client: createStaffClient(config.kpddApi),
    full: values.full,
    dryRun: values['dry-run'],
  });
  const { warnings, after, ...counts } = report;
  console.log(report.dryRun ? 'DRY RUN: nothing was written\n' : '');
  console.table(counts);
  console.log('users after this run:');
  console.table(after);
  const byCode = Object.groupBy(warnings, (w) => w.code);
  for (const [code, list] of Object.entries(byCode)) {
    console.log(`warning ${code}: ${list.length} (dash_staff_id ${list.map((w) => w.dash_staff_id).join(', ')})`);
  }
} finally {
  db.close();
}
