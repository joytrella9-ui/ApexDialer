import { Router } from 'express';

// Read-only view of the effective server configuration. These values are
// controlled by environment variables / the running process, never by the
// browser, so this route only ever reads.
export function settingsRouter(db, cfg) {
  const router = Router();

  router.get('/', (req, res) => {
    res.json({
      data: {
        demoMode: cfg.demoMode,
        telephony: {
          provider: cfg.telephony.provider,
          enabled: cfg.telephony.enabled,
          liveEnabled: cfg.telephony.liveEnabled,
        },
        compliance: {
          callWindowStart: cfg.compliance.callWindowStart,
          callWindowEnd: cfg.compliance.callWindowEnd,
        },
        auth: { sessionTtlHours: cfg.auth.sessionTtlHours },
        calls: { maxAttemptMinutes: cfg.calls.maxAttemptMinutes },
        readOnly: true,
        source: 'server',
      },
    });
  });

  return router;
}
