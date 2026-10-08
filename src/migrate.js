import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(import.meta.dirname, '..', 'migrations');

// Applies migrations/NNN_*.sql in order, each in its own transaction, and records
// them in schema_migrations. Returns the names applied this run.
export function migrate(db, dir = DIR) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ) STRICT`);
  const applied = new Set(db.all('SELECT name FROM schema_migrations').map((r) => r.name));
  const files = readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();

  const ran = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    db.tx(() => {
      db.exec(readFileSync(join(dir, file), 'utf8'));
      db.run('INSERT INTO schema_migrations (name) VALUES (?)', [file]);
    });
    ran.push(file);
  }
  return ran;
}
