import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { leadsRouter } from './routes/leads.js';
import { requireAuth } from './middleware/auth.js';
import { parseCookies, originGuard } from './middleware/security.js';
import { errorHandler } from './lib/errors.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FRONTEND_HTML = path.resolve(HERE, '..', 'ApexDialer_App.html');

function mergeConfig(overrides) {
  return {
    ...config,
    ...overrides,
    auth: { ...config.auth, ...(overrides.auth ?? {}) },
    compliance: { ...config.compliance, ...(overrides.compliance ?? {}) },
    telephony: { ...config.telephony, ...(overrides.telephony ?? {}) },
  };
}

export function createApp(db, overrides = {}) {
  const cfg = mergeConfig(overrides);
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.use(express.text({ type: ['text/csv', 'text/plain'], limit: '2mb' }));
  app.use(parseCookies);

  app.get('/', (req, res) => res.sendFile(FRONTEND_HTML));

  app.use('/api', originGuard);
  app.use('/api/health', healthRouter(db));
  app.use('/api/auth', authRouter(db, cfg));

  app.use('/api', requireAuth(db));
  app.use('/api/leads', leadsRouter(db));

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'not_found', path: req.path });
  });

  app.use(errorHandler);
  return app;
}