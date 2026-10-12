import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { healthRouter } from './routes/health.js';
import { errorHandler } from './lib/errors.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FRONTEND_HTML = path.resolve(HERE, '..', 'ApexDialer_Working_MVP.html');

export function createApp(db) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  app.get('/', (req, res) => res.sendFile(FRONTEND_HTML));

  app.use('/api/health', healthRouter(db));

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'not_found', path: req.path });
  });

  app.use(errorHandler);
  return app;
}