import { Router } from 'express';
import { describeVoiceStack } from '../providers/voiceStack.js';
import { buildReadinessReport } from '../services/readiness.js';

// Read-only view of the effective server configuration. These values are
// controlled by environment variables / the running process, never by the
// browser, so this route only ever reads. It never exposes secrets: only
// provider names, flags, and the names of any missing config keys.
export function settingsRouter(db, cfg, metrics = null) {
  const router = Router();

  // Admin-only request counters and process memory (see policy.js). Counts only.
  router.get('/metrics', (req, res) => {
    if (!metrics) return res.status(404).json({ error: 'metrics_disabled' });
    res.json({ data: metrics.snapshot() });
  });

  router.get('/', (req, res) => {
    res.json({
      data: {
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
        compliance: {
          callWindowStart: cfg.compliance.callWindowStart,
          callWindowEnd: cfg.compliance.callWindowEnd,
          requireComplianceProfile: cfg.compliance.requireComplianceProfile,
          recordingAllowed: false,
          transcriptRetentionDays: cfg.compliance.transcriptRetentionDays,
        },
        auth: { sessionTtlHours: cfg.auth.sessionTtlHours },
        calls: { maxAttemptMinutes: cfg.calls.maxAttemptMinutes },
        readOnly: true,
        source: 'server',
      },
    });
  });

  // Truthful readiness: what blocks live operation, and what is merely informational.
  // Authenticated (mounted after requireAuth) and secret-free.
  router.get('/readiness', (req, res) => {
    let dbOk = false;
    try {
      dbOk = db.prepare('SELECT 1 AS ok').get()?.ok === 1;
    } catch {
      dbOk = false;
    }
    res.json({ data: buildReadinessReport(cfg, process.env, { dbOk }) });
  });

  return router;
}
