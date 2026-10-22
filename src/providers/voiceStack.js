import { config } from '../config.js';
import { HttpError } from '../lib/errors.js';
import { createVoiceProvider } from './voice.js';
import { FakeAudioProvider } from './fakeAudio.js';
import { FakeSttProvider } from './fakeStt.js';
import { FakeTtsProvider } from './fakeTts.js';
import { FakeConversationProvider } from './fakeConversation.js';
import { PROVIDER_CAPABILITIES, assertVoiceStack } from './contracts.js';

// Only fully offline adapters are registered. Adding a real stack means
// implementing the five capability interfaces and is gated behind `liveEnabled`,
// which config (and mergeConfig) force to false.
export const VOICE_STACKS = Object.freeze({
  fake: () => ({
    telephony: createVoiceProvider({ provider: 'fake', liveEnabled: false }),
    audio: new FakeAudioProvider(),
    stt: new FakeSttProvider(),
    tts: new FakeTtsProvider(),
    conversation: new FakeConversationProvider(),
  }),
});

// Environment variables a real provider must have before it could place live
// calls. Only names are stored here (never values) so selection can fail closed
// with an actionable message and nothing sensitive is ever logged or returned.
export const LIVE_PROVIDER_REQUIREMENTS = Object.freeze({
  twilio: [
    'APEX_TWILIO_ACCOUNT_SID',
    'APEX_TWILIO_AUTH_TOKEN',
    'APEX_TWILIO_FROM_NUMBER',
    'APEX_VOICE_WEBHOOK_SECRET',
  ],
});

// Validate provider selection without constructing anything. Returns a safe,
// secret-free diagnostic. Four independent facts are reported separately so a
// provider is never mistaken for ready just because credentials happen to exist:
//   recognized         - we know the provider name
//   implemented        - an adapter/stack is actually registered for it
//   credentialsPresent - every required credential is set (names only, no values)
//   liveEnabled/ready  - live calling is on / the stack can place real calls
// Live calling requires an implemented adapter AND deliberate enablement. Because
// `liveEnabled` is hardcoded off and no real adapter is registered, both are
// always false today — even when Twilio credentials are fully populated.
export function validateVoiceProviderConfig(cfg = config.voice, env = process.env) {
  const name = String(cfg.provider ?? 'fake').trim() || 'fake';
  const implemented = Object.prototype.hasOwnProperty.call(VOICE_STACKS, name);
  const recognizedReal = Object.prototype.hasOwnProperty.call(LIVE_PROVIDER_REQUIREMENTS, name);
  const recognized = implemented || recognizedReal;
  const required = recognizedReal ? LIVE_PROVIDER_REQUIREMENTS[name] : [];
  const missing = required.filter((key) => !env[key] || String(env[key]).trim() === '');
  const credentialsPresent = missing.length === 0;

  const errors = [];
  if (!recognized) {
    errors.push({ code: 'unknown_voice_provider', provider: name });
  } else if (!implemented) {
    errors.push({ code: 'voice_provider_not_implemented', provider: name });
  }

  return {
    provider: name,
    recognized,
    implemented,
    credentialsPresent,
    missing,
    liveEnabled: false,
    live: false,
    ready: false,
    errors,
  };
}

// Build the full five-capability voice stack. Fails closed: live mode is refused
// outright and unknown providers are rejected rather than silently falling back.
export function createVoiceStack(cfg = config.voice) {
  const name = String(cfg.provider ?? 'fake').trim() || 'fake';
  if (cfg.liveEnabled) throw new HttpError(400, 'live_voice_disabled');
  const build = VOICE_STACKS[name];
  if (!build) {
    const recognizedReal = Object.prototype.hasOwnProperty.call(LIVE_PROVIDER_REQUIREMENTS, name);
    throw new HttpError(400, recognizedReal ? 'voice_provider_not_implemented' : 'unknown_voice_provider', {
      provider: name,
    });
  }
  return assertVoiceStack(build());
}

// Safe, serializable description of the configured stack for health/settings.
// Never includes credentials or other secrets. `ready` is false until a real
// adapter is implemented AND live calling is deliberately enabled.
export function describeVoiceStack(cfg = config.voice, env = process.env) {
  const check = validateVoiceProviderConfig(cfg, env);
  let mode = 'simulation';
  if (!check.recognized) mode = 'unknown';
  else if (!check.implemented) mode = 'not_implemented';
  return {
    provider: check.provider,
    mode,
    recognized: check.recognized,
    implemented: check.implemented,
    credentialsPresent: check.credentialsPresent,
    liveEnabled: false,
    ready: false,
    capabilities: [...PROVIDER_CAPABILITIES],
    missingConfig: check.missing,
    errors: check.errors.map((e) => e.code),
  };
}
