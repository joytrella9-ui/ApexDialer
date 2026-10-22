import { Router } from 'express';
import { config } from '../config.js';
import { describeVoiceStack } from '../providers/voiceStack.js';

function dbOk(db) {
  try {
    return db.prepare('SELECT 1 AS ok').get()?.ok === 1;
  } catch {
    return false;
  }
}

export function healthRouter(db, cfg = config) {
  const router = Router();

  router.get('/', (req, res) => {
    const ok = dbOk(db);
    res.status(ok ? 200 : 503).json({
      ok,
      service: 'apexdialer-api',
      database: ok ? 'ok' : 'error',
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
      voice: {
        provider: cfg.voice.provider,
        enabled: cfg.voice.enabled,
        liveEnabled: cfg.voice.liveEnabled,
        recordingEnabled: cfg.voice.recordingEnabled,
        stack: describeVoiceStack(cfg.voice),
      },
      // Real outbound calling is always off in this foundation; a campaign must
      // additionally carry a complete compliance profile before any live call.
      dialer: {
        liveCalling: false,
        provider: cfg.voice.provider,
        complianceProfileRequired: cfg.compliance.requireComplianceProfile,
        recordingAllowed: false,
      },
      database: dbOk(db) ? 'connected' : 'error',
    });
  });

  return router;
}
