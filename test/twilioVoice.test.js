import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCapability } from '../src/providers/contracts.js';
import {
  TwilioTelephonyProvider,
  normalizeTwilioVoiceEvent,
  normalizeTwilioError,
  isE164,
  TWILIO_ADAPTER_STATE,
} from '../src/providers/twilioVoice.js';

test('the Twilio telephony adapter satisfies the telephony capability contract', () => {
  const provider = new TwilioTelephonyProvider();
  assert.doesNotThrow(() => assertCapability('telephony', provider));
  assert.equal(TWILIO_ADAPTER_STATE, 'not_implemented');
});

test('the Twilio adapter fails closed and makes NO network call without a transport', () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('network_forbidden_in_offline_adapter');
  };
  try {
    const provider = new TwilioTelephonyProvider();
    assert.throws(
      () => provider.startOutboundCall({ to: '+15550100' }),
      (err) => err.status === 400 && err.message === 'live_voice_disabled'
    );
    assert.throws(
      () => provider.endCall('CA1'),
      (err) => err.status === 400 && err.message === 'live_voice_disabled'
    );
    assert.equal(provider.getCall('CA1'), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('the Twilio adapter delegates provider operations to an injected transport', () => {
  const calls = [];
  const transport = {
    createCall: ({ to, from, sessionId }) => {
      calls.push({ to, from, sessionId });
      return { sid: 'CA_test', status: 'ringing' };
    },
    endCall: (sid, reason) => ({ sid, status: 'ended', reason }),
    getCall: (sid) => ({ sid, status: 'ringing' }),
  };
  const provider = new TwilioTelephonyProvider({ transport, from: '+15550000' });

  const started = provider.startOutboundCall({ to: '+15550111', sessionId: 7 });
  assert.equal(started.sid, 'CA_test');
  assert.deepEqual(calls, [{ to: '+15550111', from: '+15550000', sessionId: 7 }]);

  assert.equal(provider.endCall('CA_test', 'done').status, 'ended');
  assert.equal(provider.getCall('CA_test').status, 'ringing');
});

test('Twilio status callbacks normalize into the internal voice status domain', () => {
  const cases = {
    queued: 'starting',
    initiated: 'starting',
    ringing: 'ringing',
    'in-progress': 'in_progress',
    completed: 'ended',
    busy: 'ended',
    'no-answer': 'ended',
    canceled: 'ended',
    failed: 'failed',
  };
  for (const [rawStatus, expected] of Object.entries(cases)) {
    const event = normalizeTwilioVoiceEvent({ CallSid: 'CA1', CallStatus: rawStatus });
    assert.equal(event.status, expected, rawStatus);
    assert.equal(event.provider, 'twilio');
    assert.equal(event.rawStatus, rawStatus);
    assert.equal(event.sid, 'CA1');
    assert.equal(event.eventId, `CA1:${rawStatus}`);
  }

  const stale = normalizeTwilioVoiceEvent({ CallSid: 'CA1', CallStatus: 'stale' });
  assert.equal(stale.status, null);
  assert.equal(stale.terminal, false);

  assert.equal(normalizeTwilioVoiceEvent({ CallSid: 'CA1', CallStatus: 'completed' }).terminal, true);
  assert.equal(normalizeTwilioVoiceEvent({ CallSid: 'CA1', CallStatus: 'failed' }).terminal, true);
});

test('E.164 validation rejects malformed numbers before any transport is touched', () => {
  assert.equal(isE164('+15550111'), true);
  assert.equal(isE164('+442071838750'), true);
  assert.equal(isE164('5550111'), false);
  assert.equal(isE164('+05550111'), false);
  assert.equal(isE164('+1 555 0111'), false);
  assert.equal(isE164(''), false);
  assert.equal(isE164(undefined), false);

  const transport = { createCall: () => ({ sid: 'CA1', status: 'ringing' }) };
  const provider = new TwilioTelephonyProvider({ transport, from: '+15550000' });
  assert.throws(
    () => provider.startOutboundCall({ to: '5550111' }),
    (err) => err.status === 400 && err.message === 'invalid_phone'
  );
});

test('Twilio REST errors normalize to stable, safe internal codes', () => {
  assert.deepEqual(normalizeTwilioError({ status: 400, code: 21211 }), {
    ok: false,
    status: 400,
    code: 'invalid_number',
    retryable: false,
    providerCode: 21211,
  });
  assert.equal(normalizeTwilioError({ status: 400, code: 21610 }).code, 'recipient_unsubscribed');
  assert.equal(normalizeTwilioError({ status: 401, code: 20003 }).code, 'provider_auth_failed');
  assert.equal(normalizeTwilioError({ status: 429 }).retryable, true);
  assert.equal(normalizeTwilioError({ status: 503 }).code, 'provider_unavailable');
  assert.equal(normalizeTwilioError({ status: 503 }).retryable, true);
  assert.equal(normalizeTwilioError({ status: 400, code: 99999 }).code, 'provider_error');
  // The raw provider message is never surfaced.
  const withMessage = normalizeTwilioError({ status: 400, code: 21211, message: 'secret internal detail' });
  assert.ok(!JSON.stringify(withMessage).includes('secret internal detail'));
});
