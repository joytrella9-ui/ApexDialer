import { HttpError } from '../lib/errors.js';
import { verifyTwilioSignature } from './twilio.js';
import { VOICE_TERMINAL_STATUSES } from './fakeVoice.js';

// =============================================================================
// REAL-INTEGRATION INCREMENT - TELEPHONY ADAPTER (OFFLINE, NOT REGISTERED)
// =============================================================================
// This adapter implements the `telephony` capability of the voice contract for
// Twilio, but performs NO provider operations by itself: every network action is
// delegated to an injected `transport`. With the shipped default (no transport)
// it fails closed, so credentials alone can never place a call.
//
// It is deliberately NOT added to VOICE_STACKS in voiceStack.js, so it is not
// "implemented/registered" and the API reports Twilio as not-implemented/not-ready
// (see validateVoiceProviderConfig / describeVoiceStack). Wiring it live requires:
//   1. a real transport (Twilio REST + Media Streams) supplied at construction;
//   2. an explicit, separately-approved `liveEnabled` path;
//   3. a configured Twilio number (E.164) and public HTTPS webhook;
//   4. jurisdiction/consent disclosure decisions for the intended market.
export const TWILIO_ADAPTER_STATE = 'not_implemented';

// E.164 phone validation at the adapter boundary. A malformed `to`/`from` must
// never reach a transport (and thus a carrier). Twilio's `To`/`From` are E.164.
export const E164 = /^\+[1-9]\d{7,14}$/;

export function isE164(value) {
  return typeof value === 'string' && E164.test(value.trim());
}

// Twilio REST error codes mapped to stable internal codes. Provider error
// bodies/messages are untrusted and are NEVER surfaced; only a safe code and
// whether a retry is appropriate are returned.
const TWILIO_ERROR_MAP = Object.freeze({
  21211: { code: 'invalid_number', retryable: false },
  21214: { code: 'invalid_number', retryable: false },
  21610: { code: 'recipient_unsubscribed', retryable: false },
  21606: { code: 'from_number_not_allowed', retryable: false },
  21612: { code: 'from_number_not_allowed', retryable: false },
  13224: { code: 'provider_bad_twiml', retryable: false },
  20003: { code: 'provider_auth_failed', retryable: false },
  20429: { code: 'provider_rate_limited', retryable: true },
});

export function normalizeTwilioError(error) {
  const status = Number(error?.status ?? error?.response?.status ?? 0);
  const providerCode = Number(error?.code ?? 0);
  const mapped = TWILIO_ERROR_MAP[providerCode];
  if (mapped) return { ok: false, status: status || 502, code: mapped.code, retryable: mapped.retryable, providerCode };
  if (status === 429) return { ok: false, status: 429, code: 'provider_rate_limited', retryable: true, providerCode };
  if (status >= 500) return { ok: false, status: 502, code: 'provider_unavailable', retryable: true, providerCode };
  return { ok: false, status: status || 502, code: 'provider_error', retryable: false, providerCode };
}

// Twilio CallStatus values mapped into the internal voice status domain. Twilio
// reports status lowercase (e.g. `in-progress`); anything unmapped stays null and
// is journaled without changing call state.
export const TWILIO_VOICE_STATUS_MAP = Object.freeze({
  queued: 'starting',
  initiated: 'starting',
  ringing: 'ringing',
  'in-progress': 'in_progress',
  completed: 'ended',
  busy: 'ended',
  'no-answer': 'ended',
  canceled: 'ended',
  failed: 'failed',
});

// Normalize a raw Twilio status callback into the typed voice event contract
// shape (see contracts.js / providerEventSchema). Pure and offline.
export function normalizeTwilioVoiceEvent(raw = {}) {
  const sid = String(raw.CallSid ?? raw.sid ?? '').trim();
  const rawStatus = String(raw.CallStatus ?? raw.status ?? '').trim().toLowerCase();
  const status = TWILIO_VOICE_STATUS_MAP[rawStatus] ?? null;
  const eventId = String(raw.eventId ?? (sid && rawStatus ? `${sid}:${rawStatus}` : ''));
  return {
    provider: 'twilio',
    eventId,
    sid,
    status,
    rawStatus,
    terminal: status !== null && VOICE_TERMINAL_STATUSES.has(status),
    details: {},
  };
}

// Verify a Twilio webhook signature (HMAC-SHA1, base64) using the account auth
// token. Re-exported here so the voice webhook surface can share one entry point.
export function verifyTwilioVoiceWebhook({ url, params, signature, authToken }) {
  return verifyTwilioSignature({ url, params, signature, authToken });
}

export class TwilioTelephonyProvider {
  constructor({ transport = null, from = '' } = {}) {
    this.name = 'twilio';
    this.transport = transport;
    this.from = from;
  }

  startOutboundCall({ to = '', from = '', sessionId = null } = {}) {
    // Fail closed first: with no transport this adapter can never place a call,
    // regardless of the numbers supplied.
    if (!this.transport || typeof this.transport.createCall !== 'function') {
      throw new HttpError(400, 'live_voice_disabled');
    }
    if (!isE164(to)) throw new HttpError(400, 'invalid_phone', { field: 'to' });
    const callerId = from || this.from;
    if (!isE164(callerId)) throw new HttpError(400, 'invalid_phone', { field: 'from' });
    return this.transport.createCall({ to, from: callerId, sessionId });
  }

  endCall(sid, reason = '') {
    if (!this.transport || typeof this.transport.endCall !== 'function') {
      throw new HttpError(400, 'live_voice_disabled');
    }
    return this.transport.endCall(sid, reason);
  }

  getCall(sid) {
    return this.transport?.getCall?.(sid) ?? null;
  }

  normalizeEvent(raw) {
    return normalizeTwilioVoiceEvent(raw);
  }
}
