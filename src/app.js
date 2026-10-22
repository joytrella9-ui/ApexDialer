import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, effectiveRequireComplianceProfile } from './config.js';
import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { leadsRouter } from './routes/leads.js';
import { callsRouter } from './routes/calls.js';
import { settingsRouter } from './routes/settings.js';
import { reportsRouter } from './routes/reports.js';
import { auditRouter } from './routes/audit.js';
import { telephonyRouter } from './routes/telephony.js';
import { campaignsRouter } from './routes/campaigns.js';
import { complianceRouter } from './routes/compliance.js';
import { voiceWebhookRouter, voiceRouter } from './routes/voice.js';
import { createStreamTokenStore } from './services/mediaStreamTokens.js';
import { createCallLifecycle } from './services/callLifecycle.js';
import { requireAuth } from './middleware/auth.js';
import { authorize } from './middleware/policy.js';
import { createMetrics } from './lib/metrics.js';
import { parseCookies, originGuard, securityHeaders, noStore } from './middleware/security.js';
import { errorHandler } from './lib/errors.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FRONTEND_HTML = path.resolve(HERE, '..', 'ApexDialer_App.html');

export function mergeConfig(overrides = {}) {
  // Destructure the known nested sections out of `overrides` so they are merged
  // exactly once (rather than being spread in via `...rest` and then overridden),
  // and so `telephony`/`voice` cannot be supplied twice. `...rest` still carries
  // any other top-level override (e.g. demoMode) through untouched.
  const { auth, compliance, calls, telephony, campaigns, ai, voice, ...rest } = overrides;
  const merged = {
    ...config,
    ...rest,
    auth: { ...config.auth, ...(auth ?? {}) },
    compliance: { ...config.compliance, ...(compliance ?? {}), recordingAllowed: false },
    calls: { ...config.calls, ...(calls ?? {}) },
    // `liveEnabled` is forced off after merging so no caller (env, test override,
    // or future config path) can silently turn on real outbound calling. Enabling
    // live telephony requires a deliberate code change plus real credentials.
    telephony: { ...config.telephony, ...(telephony ?? {}), liveEnabled: false },
    campaigns: { ...config.campaigns, ...(campaigns ?? {}) },
    ai: { ...config.ai, ...(ai ?? {}) },
    // Recording is likewise forced off: it can never be enabled through an
    // override, and stays false until a future explicit, code-reviewed path.
    voice: {
      ...config.voice,
      ...(voice ?? {}),
      liveEnabled: false,
      recordingEnabled: false,
    },
  };
  // Re-apply the compliance gate rule after overrides: relaxing it is only
  // possible in demo + fake-provider simulation, never in any other mode.
  merged.compliance.requireComplianceProfile = effectiveRequireComplianceProfile({
    requested: merged.compliance.requireComplianceProfile,
    demoMode: merged.demoMode,
    provider: merged.voice.provider,
    liveEnabled: merged.voice.liveEnabled,
  });
  return merged;
}

export function createApp(db, overrides = {}, options = {}) {
  const cfg = mergeConfig(overrides);
  const app = express();
  // Single-use Media Streams tokens, shared with the media endpoint via app.locals.
  const streamTokens = createStreamTokenStore();
  app.locals.streamTokens = streamTokens;
  const lifecycle = options.lifecycle ?? createCallLifecycle({ db, cfg });
  app.locals.lifecycle = lifecycle;
  app.disable('x-powered-by');
  const metrics = createMetrics();
  app.locals.metrics = metrics;
  app.use(metrics.middleware);
  app.use(securityHeaders);
  app.use(express.json({ limit: '256kb' }));
  app.use(express.text({ type: ['text/csv', 'text/plain'], limit: '2mb' }));
  app.use(parseCookies);

  app.get('/', (req, res) => res.sendFile(FRONTEND_HTML));

  app.use('/api', originGuard);
  app.use('/api', noStore);
  app.use('/api/health', healthRouter(db, cfg));
  app.use('/api/auth', authRouter(db, cfg));
  app.use(
    '/api/telephony',
    express.urlencoded({ extended: false, limit: '100kb' }),
    telephonyRouter(db, cfg)
  );
  // Voice provider callbacks are signature-verified and therefore mounted before
  // requireAuth (a provider cannot present a session cookie).
  app.use(
    '/api/voice/webhooks',
    express.urlencoded({ extended: false, limit: '100kb' }),
    voiceWebhookRouter(db, cfg, streamTokens, lifecycle)
  );

  app.use('/api', requireAuth(db));
  app.use('/api', authorize);
  app.use('/api/leads', leadsRouter(db));
  app.use('/api/calls', callsRouter(db, cfg));
  app.use('/api/campaigns', campaignsRouter(db, cfg));
  app.use('/api/compliance', complianceRouter(db, cfg));
  app.use('/api/reports', reportsRouter(db, cfg));
  app.use('/api/audit', auditRouter(db));
  app.use('/api/voice', voiceRouter(db, cfg));
  app.use('/api/settings', settingsRouter(db, cfg, metrics));

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'not_found', path: req.path });
  });

  app.use(errorHandler);
  return app;
}