import { z } from 'zod';

// Typed interface contracts for the real-time voice dialer. The dialer is built
// against five small, swappable capabilities instead of a single monolithic
// provider so a real stack (e.g. Twilio Media Streams + STT + LLM + TTS) can be
// dropped in without touching session lifecycle, campaign, compliance, or
// call-history code. Only fully offline `fake` adapters ship today.
export const PROVIDER_CAPABILITIES = Object.freeze([
  'telephony',
  'audio',
  'stt',
  'tts',
  'conversation',
]);

// Canonical call statuses in the internal voice domain. Provider-specific
// statuses must be normalized to one of these at the adapter boundary.
export const VOICE_CALL_STATUSES = Object.freeze([
  'starting',
  'ringing',
  'in_progress',
  'ended',
  'failed',
]);

// Methods every adapter of a given capability must implement. Kept as data so the
// contract can be asserted and reported in tests and config diagnostics.
export const CAPABILITY_METHODS = Object.freeze({
  telephony: ['startOutboundCall', 'endCall', 'getCall', 'normalizeEvent'],
  audio: ['openStream'],
  stt: ['transcribe'],
  tts: ['synthesize'],
  conversation: ['opening', 'classify', 'reply'],
});

// A validated provider webhook event. Anything crossing the provider boundary is
// parsed through this schema so malformed or hostile payloads fail closed.
export const providerEventSchema = z.object({
  provider: z.string().trim().min(1).max(64),
  eventId: z.string().trim().min(1).max(200),
  sid: z.string().trim().min(1).max(200),
  status: z.enum(VOICE_CALL_STATUSES).nullable(),
  rawStatus: z.string().trim().max(200).default(''),
  terminal: z.boolean().default(false),
  details: z.record(z.any()).default({}),
});

export function normalizeProviderEvent(input) {
  return providerEventSchema.parse(input);
}

export function listMissingMethods(kind, adapter) {
  const methods = CAPABILITY_METHODS[kind] ?? [];
  if (!adapter || (typeof adapter !== 'object' && typeof adapter !== 'function')) {
    return [...methods];
  }
  return methods.filter((m) => typeof adapter[m] !== 'function');
}

export function assertCapability(kind, adapter) {
  const missing = listMissingMethods(kind, adapter);
  if (missing.length) {
    const err = new Error(`invalid_${kind}_adapter`);
    err.code = 'invalid_provider_adapter';
    err.details = { kind, missing };
    throw err;
  }
  return adapter;
}

// Asserts that an object implements every capability of the voice stack.
export function assertVoiceStack(stack) {
  for (const kind of PROVIDER_CAPABILITIES) {
    if (!stack || !stack[kind]) {
      const err = new Error(`missing_capability_${kind}`);
      err.code = 'invalid_provider_adapter';
      err.details = { kind, missing: [...(CAPABILITY_METHODS[kind] ?? [])] };
      throw err;
    }
    assertCapability(kind, stack[kind]);
  }
  return stack;
}
