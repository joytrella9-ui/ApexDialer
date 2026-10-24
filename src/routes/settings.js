import { Router } from 'express';
import { describeVoiceStack } from '../providers/voiceStack.js';
import { buildReadinessReport } from '../services/readiness.js';
import { applyWorkspaceConfig, publicWorkspace, saveIntegrations } from '../services/workspace.js';
import { TwilioRestTransport } from '../providers/twilioRest.js';
import { HttpError } from '../lib/errors.js';

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
        integrations: publicWorkspace(db),
        readOnly: true,
        source: 'server',
      },
    });
  });

  router.get('/integrations', (req, res) => {
    res.json({ data: publicWorkspace(db) });
  });

  router.put('/integrations', (req, res) => {
    const data = saveIntegrations(db, req.body, req.auth.user.username);
    applyWorkspaceConfig(db, cfg);
    res.json({ data });
  });

  router.post('/integrations/test', async (req, res) => {
    applyWorkspaceConfig(db, cfg);
    const sid = cfg.telephony.accountSid || '';
    const token = cfg.telephony.authToken || '';
    if (!sid || !token) throw new HttpError(400, 'provider_not_configured');
    const transport = new TwilioRestTransport({
      accountSid: sid,
      authToken: token,
      liveEnabled: false,
    });
    const url = `${transport.baseUrl}/2010-04-01/Accounts/${sid}.json`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
      res.json({
        data: {
          ok: response.ok,
          status: response.status,
          message: response.ok
            ? 'Twilio accepted these credentials (account lookup succeeded). This does not place a call.'
            : 'Twilio rejected these credentials. Check the Account SID and Auth Token.',
        },
      });
    } catch {
      throw new HttpError(502, 'provider_unavailable');
    } finally {
      clearTimeout(timer);
    }
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
