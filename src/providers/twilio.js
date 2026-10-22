import { createHmac, timingSafeEqual } from 'node:crypto';

// Sandbox provider mapping. This is NOT live telephony: status callbacks are
// verified against a shared secret and recorded into provider_events, so the
// state machine and recording pipeline can be exercised end-to-end without
// ever placing a real call.
export const TWILIO_STATUS_MAP = Object.freeze({
  initiated: 'in_progress',
  ringing: 'in_progress',
  'in-progress': 'in_progress',
  queued: 'in_progress',
  completed: 'completed',
  busy: 'completed',
  'no-answer': 'completed',
  failed: 'completed',
  canceled: 'completed',
});

export const TWILIO_TERMINAL_STATUSES = new Set([
  'completed',
  'busy',
  'no-answer',
  'failed',
  'canceled',
]);

export const INTERNAL_TERMINAL_STATUSES = new Set(['completed', 'aborted']);

// Twilio builds the validated string as: full URL (with query string) followed
// by each POST parameter sorted by key, concatenated as `key + value`.
export function signatureBase(url, params) {
  const keys = Object.keys(params ?? {})
    .filter((k) => !Array.isArray(params[k]))
    .sort();
  return url + keys.map((k) => `${k}${params[k] ?? ''}`).join('');
}

export function verifyTwilioSignature({ url, params, signature, authToken }) {
  if (typeof authToken !== 'string' || authToken === '') return false;
  if (typeof signature !== 'string' || signature === '') return false;
  const expected = createHmac('sha1', authToken)
    .update(signatureBase(url, params))
    .digest('base64');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}