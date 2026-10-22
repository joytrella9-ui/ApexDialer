import { describeVoiceStack, LIVE_PROVIDER_REQUIREMENTS } from '../providers/voiceStack.js';
import { EMPTY_MANDATORY_AUDIO } from './mandatoryAudio.js';

// =============================================================================
// READINESS REPORT (truthful, secret-free)
// =============================================================================
// Each check is one of:
//   ok       - satisfied
//   info     - a current state the operator should know about (not a blocker)
//   blocker  - must be resolved before live operation can be considered
//
// Credentials are reported only as present/missing by NAME. Values never appear.
// `readyForLive` is true only when no blocker remains AND live calling is
// authorized in configuration. In this build live calling is hard-disabled, so
// `readyForLive` is always false; the report says so explicitly.
// `demoReady` reports whether the offline simulation path is usable.

const LIVE_AUTH_KEYS = ['telephony', 'voice'];

export function buildReadinessReport(cfg, env = process.env, { dbOk = true } = {}) {
  const checks = [];
  const add = (id, status, message) => checks.push({ id, status, message });

  add('database', dbOk ? 'ok' : 'blocker', dbOk ? 'Database reachable.' : 'Database check failed.');

  add(
    'demo_mode',
    'info',
    cfg.demoMode ? 'Demo mode is ON: no live calls are placed by this application.' : 'Demo mode is OFF; live operation still requires the blockers below to be resolved.'
  );

  const liveAuthorized = LIVE_AUTH_KEYS.every((k) => cfg[k]?.liveEnabled === true);
  add(
    'live_calling',
    liveAuthorized ? 'ok' : 'blocker',
    liveAuthorized
      ? 'Live calling is enabled in configuration.'
      : 'Live calling is hard-disabled in this build (liveEnabled is forced false). It requires a deliberate code change and explicit authorization.'
  );

  add('recording', cfg.voice.recordingEnabled === true ? 'blocker' : 'ok', 'Call recording is disabled and cannot be enabled through configuration in this build.');

  const stack = describeVoiceStack(cfg.voice, env);
  if (stack.mode === 'simulation') {
    add('voice_provider', 'info', `Voice provider "${stack.provider}" is the offline simulation.`);
  } else {
    add(
      'voice_provider',
      'blocker',
      `Voice provider "${stack.provider}" is not usable (${stack.errors.join(', ') || stack.mode}). It is not registered in the live stack.`
    );
  }

  const required = LIVE_PROVIDER_REQUIREMENTS[cfg.voice.provider] ?? [];
  if (required.length) {
    const missing = required.filter((key) => !env[key] || String(env[key]).trim() === '');
    add(
      'provider_credentials',
      missing.length ? 'blocker' : 'ok',
      missing.length
        ? `Missing credential names: ${missing.join(', ')}.`
        : 'All required credential names are set (values not shown).'
    );
  } else {
    add('provider_credentials', 'ok', 'No external provider credentials required for the simulation.');
  }

  add(
    'public_base_url',
    cfg.publicBaseUrl ? 'ok' : 'blocker',
    cfg.publicBaseUrl ? 'Public HTTPS origin configured for webhook verification.' : 'APEX_PUBLIC_BASE_URL is not set. Provider webhooks cannot be verified against a public URL.'
  );

  add(
    'webhook_secret',
    cfg.voice.webhookSecret || cfg.telephony.webhookSecret ? 'ok' : 'info',
    cfg.voice.webhookSecret || cfg.telephony.webhookSecret ? 'A webhook secret is configured (value not shown).' : 'No webhook secret is configured; signed webhook routes are closed.'
  );

  add(
    'gpt_live_backend_model',
    cfg.voice.liveBackendModel ? 'ok' : 'blocker',
    cfg.voice.liveBackendModel ? 'GPT-Live backend model is configured.' : 'APEX_VOICE_LIVE_BACKEND_MODEL is not set. A GPT-Live session cannot be started without it.'
  );

  const mediaPrereqs = cfg.voice.enabled === true && Boolean(cfg.publicBaseUrl);
  add(
    'media_stream_endpoint',
    mediaPrereqs ? 'ok' : 'blocker',
    mediaPrereqs
      ? 'Media Streams WebSocket endpoint is mounted (voice enabled, public HTTPS origin set). It accepts token-authenticated streams only.'
      : 'Media Streams endpoint is not mounted: it requires APEX_VOICE_ENABLED=true and a public HTTPS origin in APEX_PUBLIC_BASE_URL.'
  );

  add(
    'live_call_path',
    'blocker',
    'No production route creates outbound calls, and no production AI connector is registered. The lifecycle coordinator is verified with mock transports and fake AI sessions only.'
  );

  add(
    'compliance_gate',
    cfg.compliance.requireComplianceProfile ? 'ok' : 'info',
    cfg.compliance.requireComplianceProfile
      ? 'Campaign compliance profile and consent gate are enforced.'
      : 'Compliance profile gate is relaxed (simulator only; demo mode with the fake provider).'
  );

  add('ai_connector', 'blocker', 'No production GPT-Live connector is configured. The AI session cannot open. Requires a server-side key, an approved backend model, and a connector verified against the live API.');
  add('provider_lookup', 'blocker', 'No provider lookup is configured. An ambiguous call creation can only be reconciled by hand in the provider console.');
  const mandatory = EMPTY_MANDATORY_AUDIO.describe();
  const mandatoryMissing = mandatory.filter((m) => !m.available).map((m) => m.key);
  add(
    'mandatory_audio',
    mandatoryMissing.length ? 'blocker' : 'ok',
    mandatoryMissing.length
      ? `No approved mandatory audio is configured for: ${mandatoryMissing.join(', ')}. Calls cannot play the disclosure, so they fail closed. Counsel must approve the wording and a recording.`
      : 'Approved mandatory audio is configured for every required key (frame data not shown).'
  );

  add('transcript_retention', 'info', `Transcript retention is ${cfg.compliance.transcriptRetentionDays} days by default; execution needs explicit confirmation.`);

  const blockers = checks.filter((c) => c.status === 'blocker').map((c) => c.id);
  return {
    readyForLive: liveAuthorized && blockers.length === 0,
    liveAuthorized,
    demoReady: cfg.demoMode === true && stack.mode === 'simulation' && dbOk,
    blockers,
    checks,
    notes: [
      'A passing readiness check is configuration evidence only. It is not a verified end-to-end call.',
      'Legal and compliance approval is required before any live use and is not established by this report.',
    ],
    secretsIncluded: false,
  };
}
