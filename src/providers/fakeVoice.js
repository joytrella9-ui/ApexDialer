import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';

// Offline voice provider used for Phase 0 of the real-time AI dialer. It places
// NO real call and processes NO audio: it only mints deterministic call ids and
// normalizes webhook events so the session lifecycle can be exercised end-to-end.
// A real adapter (Twilio Media Streams + an STT/LLM/TTS stack) would implement the
// same four-method contract and be selected by `createVoiceProvider`.
export const FAKE_VOICE_STATUS_MAP = Object.freeze({
  queued: 'starting',
  initiated: 'starting',
  ringing: 'ringing',
  answered: 'in_progress',
  'in-progress': 'in_progress',
  completed: 'ended',
  'stream-disconnected': 'ended',
  failed: 'failed',
});

export const VOICE_ACTIVE_STATUSES = new Set(['starting', 'ringing', 'in_progress']);
export const VOICE_TERMINAL_STATUSES = new Set(['ended', 'failed']);

// Signing base shared with the webhook verifier: full URL followed by each POST
// parameter sorted by key, concatenated as `key + value` (Twilio-shaped).
export function voiceSignatureBase(url, params) {
  const keys = Object.keys(params ?? {})
    .filter((k) => !Array.isArray(params[k]))
    .sort();
  return url + keys.map((k) => `${k}${params[k] ?? ''}`).join('');
}

// HMAC-SHA256, base64-encoded, compared in constant time.
export function verifyVoiceSignature({ url, params, signature, secret }) {
  if (typeof secret !== 'string' || secret === '') return false;
  if (typeof signature !== 'string' || signature === '') return false;
  const expected = createHmac('sha256', secret).update(voiceSignatureBase(url, params)).digest('base64');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class FakeVoiceProvider {
  constructor(cfg = {}) {
    this.name = 'fake';
    this.cfg = cfg;
    this.calls = new Map();
    // Deterministic failure injection: `voice: { failStart: true }` makes the next
    // (and, since a provider is created per session, every) outbound start throw.
    this.failStart = Boolean(cfg.failStart);
  }

  startOutboundCall({ to = '', from = '', sessionId = null } = {}) {
    if (this.failStart) {
      const err = new Error('provider_start_failed');
      err.code = 'provider_start_failed';
      throw err;
    }
    const sid = `FV${randomUUID().replace(/-/g, '')}`;
    this.calls.set(sid, { sid, to, from, sessionId, status: 'ringing', reason: '' });
    return { sid, status: 'ringing' };
  }

  endCall(sid, reason = '') {
    const record = this.calls.get(sid);
    if (record) {
      record.status = 'ended';
      record.reason = reason;
    }
    return { sid, status: 'ended', reason };
  }

  getCall(sid) {
    return this.calls.get(sid) ?? null;
  }

  // Normalizes a raw provider callback into the internal voice status domain.
  normalizeEvent(raw = {}) {
    const sid = String(raw.sid ?? raw.CallSid ?? '').trim();
    const rawStatus = String(raw.status ?? raw.CallStatus ?? '').trim();
    const status = FAKE_VOICE_STATUS_MAP[rawStatus] ?? null;
    return {
      sid,
      eventId: String(raw.eventId ?? `${sid}:${rawStatus}`),
      status,
      rawStatus,
      terminal: status !== null && VOICE_TERMINAL_STATUSES.has(status),
      details: raw.details ?? {},
    };
  }
}
