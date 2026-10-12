import { Router } from 'express';

function setting(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function healthRouter(db) {
  const router = Router();

  router.get('/', (req, res) => {
    res.json({
      ok: true,
      service: 'apexdialer-api',
      time: new Date().toISOString(),
    });
  });

  router.get('/config', (req, res) => {
    res.json({
      demoMode: setting(db, 'demo_mode') !== 'false',
      telephony: {
        provider: setting(db, 'telephony_provider'),
        enabled: false,
        liveEnabled: setting(db, 'live_enabled') === 'true',
      },
      database: 'connected',
    });
  });

  return router;
}