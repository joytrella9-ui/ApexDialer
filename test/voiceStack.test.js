import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDER_CAPABILITIES,
  assertVoiceStack,
  normalizeProviderEvent,
  listMissingMethods,
} from '../src/providers/contracts.js';
import {
  createVoiceStack,
  describeVoiceStack,
  validateVoiceProviderConfig,
} from '../src/providers/voiceStack.js';

test('the fake voice stack implements every capability contract', () => {
  const stack = createVoiceStack({ provider: 'fake', liveEnabled: false });
  assert.equal(assertVoiceStack(stack), stack);
  assert.deepEqual(Object.keys(stack).sort(), [...PROVIDER_CAPABILITIES].sort());
  for (const kind of PROVIDER_CAPABILITIES) {
    assert.equal(listMissingMethods(kind, stack[kind]).length, 0, `${kind} adapter is complete`);
  }
});

test('the fake stack drives a full turn deterministically and makes NO network calls', () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('network_forbidden_in_simulation');
  };
  try {
    const stack = createVoiceStack({ provider: 'fake', liveEnabled: false });

    const started = stack.telephony.startOutboundCall({ to: '+15550100', from: '' });
    assert.match(started.sid, /^FV/);
    assert.equal(started.status, 'ringing');

    const stream = stack.audio.openStream(started.sid);
    stream.push({ audio: 'AAAAAAAA' });
    assert.equal(stream.inbound.length, 1);

    stack.stt.pushUtterance('Yes, I am interested, tell me more');
    const heard = stack.stt.transcribe({ audio: stream.inbound[0].audio });
    assert.equal(heard.text, 'Yes, I am interested, tell me more');
    assert.equal(heard.confidence, 1);
    assert.equal(heard.audioBytes, 'AAAAAAAA'.length);

    const intent = stack.conversation.classify(heard.text);
    assert.equal(intent, 'interested');
    const reply = stack.conversation.reply(intent);
    assert.ok(reply.length > 0);

    const speech = stack.tts.synthesize(reply);
    assert.equal(speech.bytes, 0);
    assert.ok(speech.durationMs > 0);

    stream.send(speech);
    assert.equal(stream.drain().length, 1);
    assert.equal(stream.drain().length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('live mode is refused outright and unimplemented providers fail closed', () => {
  assert.throws(
    () => createVoiceStack({ provider: 'fake', liveEnabled: true }),
    (err) => err.status === 400 && err.message === 'live_voice_disabled'
  );
  assert.throws(
    () => createVoiceStack({ provider: 'twilio' }),
    (err) => err.status === 400 && err.message === 'voice_provider_not_implemented'
  );
  assert.throws(
    () => createVoiceStack({ provider: 'nope' }),
    (err) => err.status === 400 && err.message === 'unknown_voice_provider'
  );
});

const TWILIO_KEYS = [
  'APEX_TWILIO_ACCOUNT_SID',
  'APEX_TWILIO_AUTH_TOKEN',
  'APEX_TWILIO_FROM_NUMBER',
  'APEX_VOICE_WEBHOOK_SECRET',
];

test('provider config validation separates recognition, credentials, implementation and readiness', () => {
  assert.deepEqual(validateVoiceProviderConfig({ provider: 'fake' }), {
    provider: 'fake',
    recognized: true,
    implemented: true,
    credentialsPresent: true,
    missing: [],
    liveEnabled: false,
    live: false,
    ready: false,
    errors: [],
  });

  const unknown = validateVoiceProviderConfig({ provider: 'nope' });
  assert.equal(unknown.recognized, false);
  assert.equal(unknown.implemented, false);
  assert.equal(unknown.ready, false);
  assert.equal(unknown.errors[0].code, 'unknown_voice_provider');
});

test('an unimplemented provider is NOT ready when credentials are missing', () => {
  const check = validateVoiceProviderConfig({ provider: 'twilio' }, {});
  assert.equal(check.recognized, true);
  assert.equal(check.implemented, false);
  assert.equal(check.credentialsPresent, false);
  assert.equal(check.live, false);
  assert.equal(check.ready, false);
  assert.deepEqual(check.errors.map((e) => e.code), ['voice_provider_not_implemented']);
  assert.equal(check.missing.length, TWILIO_KEYS.length);
  assert.ok(check.missing.includes('APEX_TWILIO_AUTH_TOKEN'));
});

test('an unimplemented provider is STILL not ready even with every credential populated', () => {
  const env = Object.fromEntries(TWILIO_KEYS.map((key) => [key, 'dummy-not-a-real-secret']));
  const check = validateVoiceProviderConfig({ provider: 'twilio' }, env);
  assert.equal(check.recognized, true);
  assert.equal(check.implemented, false);
  assert.equal(check.credentialsPresent, true);
  assert.equal(check.missing.length, 0);
  assert.equal(check.live, false);
  assert.equal(check.ready, false);
  assert.deepEqual(check.errors.map((e) => e.code), ['voice_provider_not_implemented']);
  // Credential VALUES never appear anywhere in the diagnostic.
  assert.ok(!JSON.stringify(check).includes('dummy-not-a-real-secret'));
});

test('describeVoiceStack is secret-free, reports simulation for fake, and never-ready for twilio', () => {
  const described = describeVoiceStack({ provider: 'fake', liveEnabled: false, webhookSecret: 'super-secret' }, {});
  assert.equal(described.mode, 'simulation');
  assert.equal(described.implemented, true);
  assert.equal(described.ready, false);
  assert.equal(described.liveEnabled, false);
  assert.equal(described.provider, 'fake');
  assert.deepEqual(described.capabilities, ['telephony', 'audio', 'stt', 'tts', 'conversation']);
  assert.ok(!JSON.stringify(described).includes('super-secret'));

  const empty = describeVoiceStack({ provider: 'twilio' }, {});
  assert.equal(empty.mode, 'not_implemented');
  assert.equal(empty.implemented, false);
  assert.equal(empty.ready, false);
  assert.equal(empty.credentialsPresent, false);

  const env = Object.fromEntries(TWILIO_KEYS.map((key) => [key, 'dummy-not-a-real-secret']));
  const full = describeVoiceStack({ provider: 'twilio' }, env);
  assert.equal(full.mode, 'not_implemented');
  assert.equal(full.implemented, false);
  assert.equal(full.ready, false);
  assert.equal(full.credentialsPresent, true);
  assert.ok(!JSON.stringify(full).includes('dummy-not-a-real-secret'));
});

test('fake provider adapters contain no static network access', async () => {
  const { readFileSync } = await import('node:fs');
  const files = ['fakeVoice.js', 'fakeAudio.js', 'fakeStt.js', 'fakeTts.js', 'fakeConversation.js'];
  const forbidden = [/from 'node:https?'/, /from 'node:net'/, /from 'node:dgram'/, /from 'node:tls'/, /\bfetch\s*\(/];
  for (const file of files) {
    const source = readFileSync(new URL(`../src/providers/${file}`, import.meta.url), 'utf8');
    for (const re of forbidden) {
      assert.ok(!re.test(source), `${file} must not contain network access (${re})`);
    }
  }
});

test('provider event schema rejects oversized and malformed fields', () => {
  assert.throws(() =>
    normalizeProviderEvent({ provider: 'p', eventId: 'e', sid: 'x'.repeat(201), status: 'ringing' })
  );
  assert.throws(() =>
    normalizeProviderEvent({ provider: 'p', eventId: 'e'.repeat(201), sid: 's', status: 'ringing' })
  );
  assert.throws(() =>
    normalizeProviderEvent({ provider: 'p'.repeat(65), eventId: 'e', sid: 's', status: 'ringing' })
  );
});

test('provider events are validated at the boundary', () => {
  const event = normalizeProviderEvent({
    provider: 'fake-voice',
    eventId: 'FV1:ringing',
    sid: 'FV1',
    status: 'ringing',
    rawStatus: 'ringing',
    terminal: false,
    details: { ok: true },
  });
  assert.equal(event.status, 'ringing');
  assert.equal(event.terminal, false);

  assert.throws(() => normalizeProviderEvent({ provider: 'x' }));
  assert.throws(() =>
    normalizeProviderEvent({ provider: 'x', eventId: 'e', sid: 's', status: 'bogus' })
  );
});
