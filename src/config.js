import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizePublicBaseUrl } from './lib/webhookUrl.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(HERE, '..');

function truthy(value, dflt = true) {
  if (value === undefined || value === null || value === '') return dflt;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function positiveNumber(value, dflt) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

// The profile/consent gate may only be relaxed for the offline simulator: demo mode
// on AND the in-process fake provider AND live calling off. In any other mode the
// gate is forced on, so no env var or override can silently disable consent checks.
export function effectiveRequireComplianceProfile({ requested = true, demoMode = true, provider = 'fake', liveEnabled = false } = {}) {
  const simulatorOnly = demoMode === true && provider === 'fake' && liveEnabled !== true;
  return simulatorOnly ? Boolean(requested) : true;
}

export function loadConfig(env = process.env) {
  const demoMode = truthy(env.APEX_DEMO_MODE, true);
  const sessionTtlHours = positiveNumber(env.APEX_SESSION_TTL_HOURS, 12);
  const voiceProvider = env.APEX_VOICE_PROVIDER || 'fake';
  const hosted = Boolean(env.RENDER);
  return {
    host: env.HOST || (hosted ? '0.0.0.0' : '127.0.0.1'),
    port: Number(env.PORT || 3210),
    demoMode,
    trustProxy: hosted || truthy(env.APEX_TRUST_PROXY, false),
    // Origin (https) that providers call. Used to verify webhook signatures.
    publicBaseUrl: normalizePublicBaseUrl(env.APEX_PUBLIC_BASE_URL || env.RENDER_EXTERNAL_URL),
    dbPath: env.APEX_DB_PATH
      ? path.resolve(env.APEX_DB_PATH)
      : path.join(PROJECT_ROOT, 'data', 'apexdialer.db'),
    telephony: {
      provider: env.APEX_TWILIO_PROVIDER || null,
      enabled: truthy(env.APEX_TWILIO_ENABLED, false),
      liveEnabled: false,
      webhookSecret: env.APEX_TWILIO_WEBHOOK_SECRET || '',
    },
    compliance: {
      callWindowStart: env.APEX_CALL_WINDOW_START || '08:00',
      callWindowEnd: env.APEX_CALL_WINDOW_END || '21:00',
      // Fail closed: a real outbound (sales) call requires a campaign compliance
      // profile (business identity + AI disclosure + consent basis) before it can
      // be eligible. The lead's jurisdiction is NEVER inferred from the phone
      // number; countries are operator-declared in the profile and legal review is
      // required per market. Recording stays off and is hardcoded false.
      requireComplianceProfile: effectiveRequireComplianceProfile({
        requested: truthy(env.APEX_REQUIRE_COMPLIANCE_PROFILE, true),
        demoMode,
        provider: voiceProvider,
      }),
      recordingAllowed: false,
      transcriptRetentionDays: positiveNumber(env.APEX_TRANSCRIPT_RETENTION_DAYS, 30),
    },
    calls: {
      maxAttemptMinutes: positiveNumber(env.APEX_MAX_ATTEMPT_MINUTES, 240),
    },
    campaigns: {
      defaultMaxAttempts: positiveNumber(env.APEX_CAMPAIGN_MAX_ATTEMPTS, 3),
      defaultRetryDelayMinutes: positiveNumber(env.APEX_CAMPAIGN_RETRY_DELAY_MINUTES, 60),
      defaultConcurrency: positiveNumber(env.APEX_CAMPAIGN_CONCURRENCY, 1),
      defaultPacingPerMinute: positiveNumber(env.APEX_CAMPAIGN_PACING_PER_MINUTE, 30),
      maxConcurrency: positiveNumber(env.APEX_CAMPAIGN_MAX_CONCURRENCY, 5),
      // The background runner is OFF by default: campaigns advance only when an
      // operator ticks them (or, explicitly, when this is enabled). This keeps the
      // "nothing auto-dials" guarantee even though the engine supports automation.
      runnerEnabled: truthy(env.APEX_CAMPAIGN_RUNNER, false),
      runnerIntervalMs: positiveNumber(env.APEX_CAMPAIGN_RUNNER_INTERVAL_MS, 15000),
    },
    // AI conversation is simulated and offline by default: no external model is
    // contacted and no audio is processed. Enabling this flag does not place calls.
    ai: {
      enabled: truthy(env.APEX_AI_ENABLED, false),
      simulated: true,
      maxTurns: positiveNumber(env.APEX_AI_MAX_TURNS, 8),
    },
    // Real-time voice dialer (Phase 0: simulated media/agent). DISABLED by default
    // and never places a real call. `liveEnabled` is hardcoded false; only the
    // offline "fake" provider is available until a real adapter is added.
    voice: {
      enabled: truthy(env.APEX_VOICE_ENABLED, false),
      provider: voiceProvider,
      liveEnabled: false,
      businessName: env.APEX_VOICE_BUSINESS_NAME || 'ApexDialer Demo',
      purpose: env.APEX_VOICE_PURPOSE || 'follow up on your recent inquiry',
      // Caller ID for outbound legs (E.164). Distinct from the transfer destination.
      fromNumber: (env.APEX_VOICE_FROM_NUMBER || '').trim(),
      transferNumber: env.APEX_VOICE_TRANSFER_NUMBER || '',
      maxTurns: positiveNumber(env.APEX_VOICE_MAX_TURNS, 8),
      maxSilenceRetries: positiveNumber(env.APEX_VOICE_MAX_SILENCE_RETRIES, 2),
      maxInvalid: positiveNumber(env.APEX_VOICE_MAX_INVALID, 2),
      // Bounds for the auditable AI tool loop (Step 4): a session may not emit
      // unbounded tool calls, and no call may run past `maxCallSeconds`.
      maxToolCalls: positiveNumber(env.APEX_VOICE_MAX_TOOL_CALLS, 12),
      maxCallSeconds: positiveNumber(env.APEX_VOICE_MAX_CALL_SECONDS, 600),
      // Real-time provider selection/formatting for the (unregistered) real
      // adapters. These names are inert until a live stack is deliberately wired.
      realtimeModel: env.APEX_VOICE_REALTIME_MODEL || 'gpt-realtime',
      realtimeVoice: env.APEX_VOICE_REALTIME_VOICE || 'alloy',
      // GPT-Live (primary WebSocket) settings. The backend model has NO default: the
      // Responses backend that runs tool work must be chosen deliberately.
      liveModel: env.APEX_VOICE_LIVE_MODEL || 'gpt-live-1',
      liveVoice: env.APEX_VOICE_LIVE_VOICE || 'marin',
      liveBackendModel: (env.APEX_VOICE_LIVE_BACKEND_MODEL || '').trim(),
      aiDisclosure:
        env.APEX_VOICE_AI_DISCLOSURE || 'This call is handled by an automated assistant.',
      // Recording is disabled by default and never enabled by this foundation.
      recordingEnabled: false,
      webhookSecret: env.APEX_VOICE_WEBHOOK_SECRET || '',
    },
    auth: {
      sessionTtlHours,
      bcryptRounds: positiveNumber(env.APEX_BCRYPT_ROUNDS, 10),
      cookieName: 'apexdialer_session',
      cookieSecure: truthy(env.APEX_COOKIE_SECURE, hosted),
      loginWindowMs: positiveNumber(env.APEX_LOGIN_WINDOW_MS, 15 * 60 * 1000),
      loginMaxPerIp: positiveNumber(env.APEX_LOGIN_MAX_PER_IP, 20),
      loginFailureMax: positiveNumber(env.APEX_LOGIN_FAILURE_MAX, 5),
      setupWindowMs: positiveNumber(env.APEX_SETUP_WINDOW_MS, 60 * 60 * 1000),
      setupMax: positiveNumber(env.APEX_SETUP_MAX, 10),
      publicSignup: truthy(env.APEX_PUBLIC_SIGNUP, true),
    },
  };
}

export const config = loadConfig();