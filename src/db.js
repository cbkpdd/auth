import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// One connection per process (the service runs as a single instance). Calls are
// synchronous; tx() wraps several writes so they land together, e.g. disabling a
// user and revoking their sessions. Params: positional array or a named object.
export function createDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA synchronous = NORMAL;
  `);

  const statements = new Map();
  const stmt = (sql) => {
    let s = statements.get(sql);
    if (!s) statements.set(sql, (s = db.prepare(sql)));
    return s;
  };
  const args = (params) => (params === undefined ? [] : Array.isArray(params) ? params : [params]);

  return {
    get: (sql, params) => stmt(sql).get(...args(params)),
    all: (sql, params) => stmt(sql).all(...args(params)),
    run: (sql, params) => stmt(sql).run(...args(params)),
    exec: (sql) => db.exec(sql),

    // Nested calls join the outer transaction.
    tx(fn) {
      if (db.isTransaction) return fn();
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },

    close: () => db.close(),
  };
}

export const now = () => new Date().toISOString();
export const inSeconds = (s) => new Date(Date.now() + s * 1000).toISOString();
