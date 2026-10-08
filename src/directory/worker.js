import { drainDirectoryQueue, syncDirectory } from './sync.js';

const DRAIN_EVERY_MS = 5_000;
const SYNC_EVERY_MS = 24 * 60 * 60 * 1000;

// Runs inside the server: drains webhook events every few seconds and runs the
// nightly incremental sync. One job at a time; a 429 or key error waits for the
// next tick instead of spinning.
export function startDirectoryWorker({ db, client, log = console }) {
  let busy = false;
  const run = (name, job) => async () => {
    if (busy) return;
    busy = true;
    try {
      const result = await job();
      if (result?.processed) log.log(`directory ${name}: ${result.processed} record(s)`);
    } catch (err) {
      log.error(`directory ${name} failed: ${err.message}`);
    } finally {
      busy = false;
    }
  };

  const drain = setInterval(run('drain', () => drainDirectoryQueue({ db, client })), DRAIN_EVERY_MS);
  const nightly = setInterval(run('sync', async () => {
    const r = await syncDirectory({ db, client });
    return { processed: r.records };
  }), SYNC_EVERY_MS);
  drain.unref();
  nightly.unref();
  return () => { clearInterval(drain); clearInterval(nightly); };
}
