import { Router } from 'express';
import { config } from '../config.js';

export function healthRouter(db, cfg = config) {
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
      demoMode: cfg.demoMode,
      telephony: {
        provider: cfg.telephony.provider,
        enabled: cfg.telephony.enabled,
        liveEnabled: cfg.telephony.liveEnabled,
      },
      database: 'connected',
    });
  });

  return router;
}
