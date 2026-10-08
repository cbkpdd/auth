import { now } from '../db.js';
import { applyStaffRecord } from './apply.js';

const LAST_AS_OF = 'directory.last_as_of';
const DRAIN_ONE_BY_ONE_MAX = 20;

class DryRunRollback extends Error {}

const emptyReport = () => ({
  records: 0, created: 0, updated: 0, unchanged: 0, disabled: 0, merged: 0, reactivated: 0, skipped: 0,
  warnings: [],
});

function tally(report, { action, warnings }) {
  report.records++;
  report[action]++;
  report.warnings.push(...warnings);
}

// Lists staff from kpdd.com and applies every record.
//   full: true    → everything (first import); otherwise since the stored as_of.
//   dryRun: true  → all pages fetched first, applied in ONE transaction, then rolled
//                   back, so the report is exact and nothing is written.
// A real run commits page by page and stores as_of only after the last page, so an
// interrupted run simply repeats from the same point next time.
export async function syncDirectory({ db, client, full = false, dryRun = false }) {
  const since = full ? undefined : db.get('SELECT value FROM sync_state WHERE key = ?', [LAST_AS_OF])?.value;
  const report = { ...emptyReport(), mode: since ? 'incremental' : 'full', since: since ?? null, dryRun };
  let asOf;

  if (dryRun) {
    const records = [];
    for await (const page of client.pages({ updatedSince: since })) {
      records.push(...page.data);
      asOf = page.asOf;
    }
    try {
      db.tx(() => {
        for (const record of records) tally(report, applyStaffRecord(db, record));
        report.after = countUsers(db);
        throw new DryRunRollback();
      });
    } catch (err) {
      if (!(err instanceof DryRunRollback)) throw err;
    }
  } else {
    for await (const page of client.pages({ updatedSince: since })) {
      db.tx(() => {
        for (const record of page.data) tally(report, applyStaffRecord(db, record));
      });
      asOf = page.asOf;
    }
    if (asOf) setState(db, LAST_AS_OF, asOf);
    report.after = countUsers(db);
  }

  report.asOf = asOf ?? null;
  return report;
}

// Webhook side: remember which record changed; the worker fetches it later.
export function enqueueStaffChange(db, dashStaffId) {
  db.run(
    `INSERT INTO directory_queue (dash_staff_id) VALUES (?)
     ON CONFLICT (dash_staff_id) DO UPDATE SET queued_at = excluded.queued_at`,
    [dashStaffId],
  );
}

// Worker: up to 20 queued ids are fetched one by one; more than that runs one
// incremental sync instead, which keeps a burst under the API's rate limit.
export async function drainDirectoryQueue({ db, client }) {
  const queued = db.all('SELECT dash_staff_id, queued_at FROM directory_queue ORDER BY queued_at LIMIT ?', [DRAIN_ONE_BY_ONE_MAX + 1]);
  if (!queued.length) return { mode: 'idle', processed: 0 };

  if (queued.length > DRAIN_ONE_BY_ONE_MAX) {
    const startedAt = now();
    const report = await syncDirectory({ db, client });
    // Anything queued after the listing started may not be in it; keep those.
    db.run('DELETE FROM directory_queue WHERE queued_at <= ?', [startedAt]);
    return { mode: 'sync', processed: report.records, report };
  }

  let processed = 0;
  for (const { dash_staff_id: id, queued_at: queuedAt } of queued) {
    try {
      const record = await client.get(id);
      db.tx(() => {
        if (record) applyStaffRecord(db, record);
        // Only clear the row if no newer event arrived while we were fetching.
        db.run('DELETE FROM directory_queue WHERE dash_staff_id = ? AND queued_at = ?', [id, queuedAt]);
      });
      processed++;
    } catch (err) {
      db.run('UPDATE directory_queue SET attempts = attempts + 1, last_error = ? WHERE dash_staff_id = ?', [err.message, id]);
      if (err.status === 401 || err.status === 403 || err.status === 429) throw err; // stop the batch
    }
  }
  return { mode: 'one-by-one', processed };
}

function setState(db, key, value) {
  db.run(
    `INSERT INTO sync_state (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value],
  );
}

function countUsers(db) {
  return db.get(`SELECT count(*) AS users,
    sum(status = 'active') AS active,
    sum(status = 'active' AND tier = 'agent') AS agents,
    sum(status = 'active' AND tier = 'staff') AS staff,
    sum(status = 'active' AND email IS NULL) AS active_without_email
    FROM users`);
}
