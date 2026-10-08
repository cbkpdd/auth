import express from 'express';
import cookieParser from 'cookie-parser';
import { wellKnownRoutes } from './routes/wellknown.js';

// Builds the Express app from its dependencies so tests can pass in fakes.
export function createApp({ config, keys }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');

  // Keep the raw body: HMAC signatures are computed over the exact bytes sent.
  app.use(express.json({ limit: '100kb', verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));
  app.use(cookieParser());

  app.use(wellKnownRoutes({ config, keys }));

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(err.status ?? 500).json({ error: err.expose ? err.message : 'server_error' });
  });
  return app;
}
