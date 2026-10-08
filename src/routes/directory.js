import { Router } from 'express';
import { HEADERS, verifyRequest } from '../crypto/hmac.js';
import { enqueueStaffChange } from '../directory/sync.js';

const EVENTS = new Set(['staff.created', 'staff.updated', 'staff.deactivated', 'staff.merged']);

// kpdd.com → auth: "this staff record changed". The body only names the record;
// the worker fetches it from the API, so a replayed or forged-but-signed event can
// at worst cause one extra fetch. Answers 202 once queued (docs/kpdd-api.md).
export function directoryRoutes({ config, db }) {
  const router = Router();

  router.post('/directory/sync', (req, res) => {
    if (!config.dashWebhookSecret) return res.status(503).json({ error: 'webhook_not_configured' });

    const check = verifyRequest({
      secrets: [config.dashWebhookSecret],
      timestamp: req.get(HEADERS.timestamp),
      signature: req.get(HEADERS.signature),
      method: 'POST',
      path: '/directory/sync',
      body: req.rawBody ?? '',
    });
    if (!check.ok) return res.status(401).json({ error: check.reason });

    const { event, dash_staff_id: id } = req.body ?? {};
    if (typeof id !== 'string' || !id || id.length > 64) return res.status(400).json({ error: 'bad_dash_staff_id' });
    // Unknown event names are queued too: every event means "fetch and apply".
    enqueueStaffChange(db, id);
    res.status(202).json({ queued: id, known_event: EVENTS.has(event) });
  });

  return router;
}
