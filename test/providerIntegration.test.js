import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { createDb } from '../src/db/db.js';
import { mergeConfig } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { normalizePublicBaseUrl, webhookUrl } from '../src/lib/webhookUrl.js';
import { signatureBase } from '../src/providers/twilio.js';
import { TwilioRestTransport, createTwilioRestTransport, TWILIO_STATUS_EVENTS } from '../src/providers/twilioRest.js';
import {
  LiveSession,
  attachLiveSocket,
  buildLiveSessionStart,
  connectLiveSocket,
  createLiveRealtimeFactory,
  encodeAudioAppend,
  parseLiveEvent,
  LIVE_TELEPHONY_FORMAT,
  MAX_AUDIO_CHUNK_BYTES,
} from '../src/providers/gptLive.js';
import { createVoiceOrchestrator } from '../src/services/voiceOrchestrator.js';
import { getVoiceSession } from '../src/services/voiceSessions.js';
import { syntheticDisclosureRegistry, playDisclosure } from '../test-support/orchestrationFixtures.js';
import { upsertComplianceProfile, setConsent } from '../src/services/complianceProfile.js';
import { MediaStreamSession } from '../src/providers/twilioMediaStream.js';
import { withServer as withServerRaw, raw } from '../test-support/helpers.js';

// Every test here is offline: injected fetch, fake sockets, or a loopback ws
// server. No test contacts Twilio or OpenAI, and no test uses real credentials.

const AUTH_TOKEN = 'test-auth-token-0123456789abcdef';
const ACCOUNT_SID = 'AC' + '1'.repeat(32);
const CALL_SID = 'CA' + 'a'.repeat(32);
const TWIML_URL = 'https://apex.example.com/twiml/1';
const CALLBACK_URL = 'https://apex.example.com/api/telephony/webhooks/twilio';
const LIVE_KEY = 'test-live-key-not-real-000000';

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (next === 'hang') {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }
    const { status = 201, body = {} } = next;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  fn.calls = calls;
  return fn;
}

function liveTransport(fetchImpl, extra = {}) {
  return new TwilioRestTransport({
    accountSid: ACCOUNT_SID,
    authToken: AUTH_TOKEN,
    liveEnabled: true,
    fetchImpl,
    timeoutMs: 200,
    sleep: async () => {},
    endRetryDelayMs: 0,
    ...extra,
  });
}

const createArgs = {
  to: '+15550123456',
  from: '+15550001111',
  twimlUrl: TWIML_URL,
  statusCallbackUrl: CALLBACK_URL,
};

// ---- Twilio REST: safety defaults ------------------------------------------

test('the configured Twilio transport refuses every operation and never calls fetch', async () => {
  const spy = fakeFetch([{ status: 201, body: { sid: CALL_SID, status: 'queued' } }]);
  const transport = createTwilioRestTransport({ accountSid: ACCOUNT_SID, authToken: AUTH_TOKEN, fetchImpl: spy });
  await assert.rejects(transport.createCall(createArgs), (err) => err.status === 400 && err.message === 'live_voice_disabled');
  await assert.rejects(transport.endCall(CALL_SID), (err) => err.message === 'live_voice_disabled');
  assert.equal(spy.calls.length, 0, 'no network call while live is disabled');
});

test('live enabled without credentials is refused before any network call', async () => {
  const spy = fakeFetch([]);
  const transport = new TwilioRestTransport({ liveEnabled: true, fetchImpl: spy });
  await assert.rejects(transport.createCall(createArgs), (err) => err.message === 'provider_not_configured');
  assert.equal(spy.calls.length, 0);
});

test('the transport never exposes its auth token through serialization or inspection', () => {
  const transport = liveTransport(fakeFetch([]));
  const json = JSON.stringify(transport);
  assert.ok(!json.includes(AUTH_TOKEN));
  assert.deepEqual(Object.keys(JSON.parse(json)).sort(), ['credentialsConfigured', 'liveEnabled', 'provider']);
  assert.equal(Object.keys(transport).includes('authToken'), false, 'token is not an enumerable property');
});

// ---- Twilio REST: create request ------------------------------------------

test('createCall sends the documented form request with Basic auth and status events', async () => {
  const spy = fakeFetch([{ status: 201, body: { sid: CALL_SID, status: 'queued' } }]);
  const result = await liveTransport(spy).createCall(createArgs);
  assert.deepEqual(result, { sid: CALL_SID, status: 'queued' });

  assert.equal(spy.calls.length, 1);
  const { url, init } = spy.calls[0];
  assert.equal(url, `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Calls.json`);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, `Basic ${Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64')}`);
  assert.equal(init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(init.redirect, 'error');

  const params = new URLSearchParams(init.body);
  assert.equal(params.get('To'), createArgs.to);
  assert.equal(params.get('From'), createArgs.from);
  assert.equal(params.get('Url'), TWIML_URL);
  assert.equal(params.get('StatusCallback'), CALLBACK_URL);
  assert.equal(params.get('StatusCallbackMethod'), 'POST');
  assert.deepEqual(params.getAll('StatusCallbackEvent'), [...TWILIO_STATUS_EVENTS]);
  assert.equal(params.get('Record'), 'false', 'recording is never requested');
  assert.equal(params.get('TimeLimit'), '600');
});

test('invalid numbers and non-public or credentialed URLs are rejected before any network call', async () => {
  const spy = fakeFetch([]);
  const t = liveTransport(spy);
  await assert.rejects(t.createCall({ ...createArgs, to: '5550123456' }), (err) => err.status === 400 && err.details.field === 'to');
  await assert.rejects(t.createCall({ ...createArgs, from: 'abc' }), (err) => err.details.field === 'from');
  await assert.rejects(t.createCall({ ...createArgs, twimlUrl: 'http://apex.example.com/x' }), (err) => err.message === 'invalid_url');
  await assert.rejects(t.createCall({ ...createArgs, twimlUrl: 'https://localhost/x' }), (err) => err.message === 'invalid_url');
  await assert.rejects(t.createCall({ ...createArgs, statusCallbackUrl: 'https://10.0.0.5/cb' }), (err) => err.message === 'invalid_url');
  await assert.rejects(t.createCall({ ...createArgs, statusCallbackUrl: 'https://u:p@apex.example.com/cb' }), (err) => err.message === 'invalid_url');
  assert.equal(spy.calls.length, 0);
});

test('a timed-out create is NOT retried and is flagged ambiguous (the call may already exist)', async () => {
  const spy = fakeFetch(['hang', { status: 201, body: { sid: CALL_SID, status: 'queued' } }]);
  await assert.rejects(liveTransport(spy).createCall(createArgs), (err) => {
    return err.status === 502 && err.message === 'provider_timeout' && err.details.ambiguous === true;
  });
  assert.equal(spy.calls.length, 1, 'exactly one attempt');
});

test('a connection failure on create is flagged ambiguous and not retried', async () => {
  const spy = fakeFetch([new Error('ECONNRESET')]);
  await assert.rejects(liveTransport(spy).createCall(createArgs), (err) => err.message === 'provider_unavailable' && err.details.ambiguous === true);
  assert.equal(spy.calls.length, 1);
});

test('5xx and 429 on create are returned without retry; 5xx is flagged ambiguous', async () => {
  const fivexx = fakeFetch([{ status: 503, body: { code: 20500, message: 'upstream detail' } }]);
  await assert.rejects(liveTransport(fivexx).createCall(createArgs), (err) => err.details.ambiguous === true);
  assert.equal(fivexx.calls.length, 1);

  const limited = fakeFetch([{ status: 429, body: {} }]);
  await assert.rejects(liveTransport(limited).createCall(createArgs), (err) => err.message === 'provider_rate_limited' && err.details.ambiguous === false);
  assert.equal(limited.calls.length, 1);
});

test('Twilio error codes map to stable codes and the provider message never leaks', async () => {
  const secretish = 'LEAK-ME-PLEASE-do-not-surface';
  const spy = fakeFetch([{ status: 400, body: { code: 21211, message: secretish, more_info: 'https://example.com' } }]);
  await assert.rejects(liveTransport(spy).createCall(createArgs), (err) => {
    assert.equal(err.message, 'invalid_number');
    assert.ok(!JSON.stringify({ message: err.message, details: err.details }).includes(secretish));
    return err.status === 400;
  });
  assert.equal(spy.calls.length, 1);
});

test('a create response without a valid call sid is a bad provider response, flagged ambiguous', async () => {
  const spy = fakeFetch([{ status: 201, body: { sid: 'not-a-sid', status: 'queued' } }]);
  await assert.rejects(liveTransport(spy).createCall(createArgs), (err) => err.message === 'provider_bad_response' && err.details.ambiguous === true);
});

// ---- Twilio REST: end call -------------------------------------------------

test('endCall posts Status=completed to the call resource', async () => {
  const spy = fakeFetch([{ status: 200, body: { sid: CALL_SID, status: 'completed' } }]);
  const result = await liveTransport(spy).endCall(CALL_SID);
  assert.deepEqual(result, { sid: CALL_SID, status: 'completed' });
  assert.equal(spy.calls[0].url, `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Calls/${CALL_SID}.json`);
  assert.equal(new URLSearchParams(spy.calls[0].init.body).get('Status'), 'completed');
});

test('endCall retries transient failures (429/5xx/timeout) and stops on a permanent error', async () => {
  const transient = fakeFetch([{ status: 429, body: {} }, { status: 503, body: {} }, { status: 200, body: { status: 'completed' } }]);
  const ok = await liveTransport(transient).endCall(CALL_SID);
  assert.equal(ok.status, 'completed');
  assert.equal(transient.calls.length, 3);

  const permanent = fakeFetch([{ status: 404, body: { code: 20404 } }]);
  await assert.rejects(liveTransport(permanent).endCall(CALL_SID), (err) => err.status === 404);
  assert.equal(permanent.calls.length, 1, 'a permanent error is not retried');

  const exhausted = fakeFetch(['hang', 'hang', 'hang']);
  await assert.rejects(liveTransport(exhausted).endCall(CALL_SID), (err) => err.message === 'provider_timeout');
  assert.equal(exhausted.calls.length, 3, 'bounded: one attempt plus two retries');
});

test('endCall rejects a malformed call sid before any network call', async () => {
  const spy = fakeFetch([]);
  await assert.rejects(liveTransport(spy).endCall('../../etc'), (err) => err.message === 'invalid_call_sid');
  assert.equal(spy.calls.length, 0);
});

// ---- webhook public URL -----------------------------------------------------

test('APEX_PUBLIC_BASE_URL is validated: https origin only', () => {
  assert.equal(normalizePublicBaseUrl(''), '');
  assert.equal(normalizePublicBaseUrl('https://apex.example.com/'), 'https://apex.example.com');
  assert.throws(() => normalizePublicBaseUrl('http://apex.example.com'), /must use https/);
  assert.throws(() => normalizePublicBaseUrl('https://apex.example.com/path'), /origin only/);
  assert.throws(() => normalizePublicBaseUrl('https://u:p@apex.example.com'), /origin only/);
  assert.throws(() => normalizePublicBaseUrl('https://apex.example.com?x=1'), /origin only/);
  assert.throws(() => normalizePublicBaseUrl('not a url'), /absolute https URL/);
  assert.throws(() => loadConfig({ APEX_PUBLIC_BASE_URL: 'http://insecure.example.com' }), /must use https/);
  assert.equal(loadConfig({ APEX_PUBLIC_BASE_URL: 'https://apex.example.com' }).publicBaseUrl, 'https://apex.example.com');
  assert.equal(loadConfig({}).publicBaseUrl, '');
});

test('webhookUrl uses the configured public origin instead of the request Host header', () => {
  const req = { originalUrl: '/api/telephony/webhooks/twilio', protocol: 'http', get: () => 'internal:3210' };
  assert.equal(webhookUrl({ publicBaseUrl: 'https://apex.example.com' }, req), 'https://apex.example.com/api/telephony/webhooks/twilio');
  assert.equal(webhookUrl({ publicBaseUrl: '' }, req), 'http://internal:3210/api/telephony/webhooks/twilio');
});

function sign(url, params, token) {
  return createHmac('sha1', token).update(signatureBase(url, params)).digest('base64');
}

test('a Twilio callback signed for the public URL is accepted behind a proxy, and a local-URL signature is rejected', async () => {
  const SECRET = 'webhook-test-secret';
  const params = { CallSid: 'CAunknown000000000000000000000000', CallStatus: 'ringing' };
  const publicUrl = 'https://apex.example.com/api/telephony/webhooks/twilio';
  const cfg = { telephony: { enabled: true, webhookSecret: SECRET }, publicBaseUrl: 'https://apex.example.com' };
  await withServerRaw(
    async (base) => {
      const body = new URLSearchParams(params).toString();
      const good = await raw(base, 'POST', '/api/telephony/webhooks/twilio', {
        body,
        contentType: 'application/x-www-form-urlencoded',
        headers: { 'x-twilio-signature': sign(publicUrl, params, SECRET) },
      });
      assert.equal(good.status, 200, JSON.stringify(good.body));

      const local = await raw(base, 'POST', '/api/telephony/webhooks/twilio', {
        body,
        contentType: 'application/x-www-form-urlencoded',
        headers: { 'x-twilio-signature': sign(`${base}/api/telephony/webhooks/twilio`, params, SECRET) },
      });
      assert.equal(local.status, 401);
      assert.equal(local.body.error, 'invalid_signature');
    },
    undefined,
    cfg
  );
});

// ---- GPT-Live: protocol --------------------------------------------------------

test('session.start requires an explicit backend model and uses telephony G.711 audio', () => {
  assert.throws(() => buildLiveSessionStart({ backendModel: '' }), (err) => err.message === 'invalid_live_config');
  const msg = buildLiveSessionStart({ backendModel: 'backend-model-x', voice: 'marin', instructions: 'Hi' });
  assert.equal(msg.type, 'session.start');
  assert.deepEqual(msg.session.audio.format, LIVE_TELEPHONY_FORMAT);
  assert.equal(msg.session.audio.format.type, 'audio/pcmu');
  assert.equal(msg.session.audio.format.rate, 8000);
  assert.equal(msg.session.audio.output.voice, 'marin');
  assert.equal(msg.session.delegation.type, 'responses');
  assert.equal(msg.session.delegation.responses.model, 'backend-model-x');
  assert.equal(msg.session.delegation.responses.parallel_tool_calls, false);
  const names = msg.session.delegation.responses.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['approved_response', 'callback_request', 'end_call', 'keypad_routing', 'opt_out', 'transfer_request']);
  assert.ok(msg.session.delegation.responses.tools.every((t) => t.type === 'function'));
});

test('the session tool list cannot be widened beyond the server allowlist', () => {
  const tools = [
    { type: 'function', name: 'approved_response', parameters: {} },
    { type: 'function', name: 'wire_money', parameters: {} },
  ];
  const msg = buildLiveSessionStart({ backendModel: 'backend-model-x', tools });
  assert.deepEqual(msg.session.delegation.responses.tools.map((t) => t.name), ['approved_response']);
  assert.throws(
    () => buildLiveSessionStart({ backendModel: 'backend-model-x', tools: [{ type: 'function', name: 'wire_money' }] }),
    (err) => err.message === 'invalid_live_config'
  );
});

test('audio frames are validated: base64 only, non-empty, and at most one 120 ms chunk', () => {
  const frame160 = Buffer.alloc(160, 0xff).toString('base64');
  assert.equal(encodeAudioAppend(frame160).type, 'session.input_audio.append');
  const max = Buffer.alloc(MAX_AUDIO_CHUNK_BYTES, 1).toString('base64');
  assert.equal(encodeAudioAppend(max).audio, max);
  const tooBig = Buffer.alloc(MAX_AUDIO_CHUNK_BYTES + 1, 1).toString('base64');
  assert.throws(() => encodeAudioAppend(tooBig), (err) => err.message === 'audio_chunk_too_large');
  assert.throws(() => encodeAudioAppend(''), (err) => err.message === 'invalid_audio_payload');
  assert.throws(() => encodeAudioAppend('not base64!!'), (err) => err.message === 'invalid_audio_payload');
  assert.throws(() => encodeAudioAppend(42), (err) => err.message === 'invalid_audio_payload');
});

test('parseLiveEvent normalizes documented server events and extracts completed function calls only', () => {
  assert.equal(parseLiveEvent({ type: 'session.started', session: { id: 'sess_1' } }).type, 'session_ready');
  assert.deepEqual(parseLiveEvent({ type: 'session.output_audio.delta', delta: 'AAAA' }), {
    type: 'audio',
    eventId: '',
    delta: 'AAAA',
  });
  assert.equal(parseLiveEvent({ type: 'session.input_transcript.delta', delta: 'hi' }).role, 'lead');
  assert.equal(parseLiveEvent({ type: 'session.output_transcript.delta', delta: 'hi' }).role, 'ai');

  const call = parseLiveEvent({
    type: 'response.event',
    event_id: 'ev1',
    delegation_id: 'item_9',
    event: {
      type: 'response.output_item.done',
      item: { type: 'function_call', call_id: 'call_123', name: 'approved_response', arguments: '{"lineKey":"greeting"}' },
    },
  });
  assert.equal(call.type, 'tool_call');
  assert.equal(call.callId, 'call_123');
  assert.equal(call.allowed, true);
  assert.deepEqual(call.arguments, { lineKey: 'greeting' });
  assert.equal(call.delegationId, 'item_9');

  const badArgs = parseLiveEvent({
    type: 'response.event',
    event: { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'c2', name: 'end_call', arguments: '{bad' } },
  });
  assert.equal(badArgs.parseError, true);

  const unknownTool = parseLiveEvent({
    type: 'response.event',
    event: { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'c3', name: 'wire_money', arguments: '{}' } },
  });
  assert.equal(unknownTool.allowed, false);

  // A partially streamed function call is not an executable tool call.
  assert.equal(parseLiveEvent({ type: 'response.event', event: { type: 'response.function_call_arguments.delta' } }).type, 'backend_event');
  assert.equal(parseLiveEvent({ type: 'response.event', event: { type: 'response.created' } }).type, 'backend_event');
  assert.equal(parseLiveEvent({ type: 'something.new' }).type, 'ignored');
  assert.equal(parseLiveEvent({ type: 'error', error: { code: 'x', message: 'bad', client_event_id: 'e1' } }).clientEventId, 'e1');
  assert.equal(parseLiveEvent({ type: 'transport.failed', error: { code: 'sip_fail' } }).type, 'provider_error');
  assert.equal(parseLiveEvent({ type: 'session.closed' }).type, 'session_closed');
});

test('malformed, non-object, oversized, and unparseable server messages fail closed', () => {
  assert.throws(() => parseLiveEvent('{not json'), (err) => err.status === 400 && err.message === 'invalid_live_event');
  assert.throws(() => parseLiveEvent('[]'), (err) => err.message === 'invalid_live_event');
  assert.throws(() => parseLiveEvent({ no: 'type' }), (err) => err.message === 'invalid_live_event');
  assert.throws(() => parseLiveEvent('x'.repeat(300 * 1024)), (err) => err.message === 'oversized_live_event');
  const huge = JSON.stringify({ type: 'session.output_audio.delta', delta: 'A'.repeat(20000) });
  assert.equal(parseLiveEvent(huge).type, 'ignored', 'oversized audio frames are dropped, never truncated');
});

// ---- GPT-Live: lifecycle with a fake socket ---------------------------------------

function openSocket() {
  return {
    readyState: 1,
    sent: [],
    closed: false,
    closeArgs: null,
    send(msg) {
      this.sent.push(JSON.parse(msg));
    },
    close(code, reason) {
      this.closed = true;
      this.closeArgs = { code, reason };
    },
    handlers: {},
    on(event, fn) {
      this.handlers[event] = fn;
    },
  };
}

function sessionFor(socket, events, overrides = {}) {
  const sessionStart = buildLiveSessionStart({ backendModel: 'backend-model-x', instructions: 'Hi' });
  return new LiveSession({
    socket,
    sessionStart,
    onEvent: (e) => events.push(e),
    startTimeoutMs: 1000,
    closeTimeoutMs: 1000,
    ...overrides,
  });
}

test('LiveSession: start -> ready -> audio -> tool result -> graceful close', () => {
  const socket = openSocket();
  const events = [];
  const live = sessionFor(socket, events);
  assert.throws(() => live.appendAudio(Buffer.alloc(160).toString('base64')), (err) => err.message === 'live_not_ready');

  live.start();
  assert.equal(socket.sent[0].type, 'session.start', 'session.start is the first message');
  assert.equal(live.state, 'starting');
  assert.throws(() => live.start(), (err) => err.message === 'live_already_started');

  live.ingest({ type: 'session.started', session: { id: 'sess_9' } });
  assert.equal(live.state, 'ready');
  assert.equal(live.sessionId, 'sess_9');

  live.appendAudio(Buffer.alloc(160, 7).toString('base64'));
  assert.equal(socket.sent.at(-1).type, 'session.input_audio.append');

  live.submitToolOutput('call_1', { ok: true });
  assert.equal(socket.sent.at(-2).type, 'response.item.create');
  assert.equal(socket.sent.at(-2).item.call_id, 'call_1');
  assert.equal(socket.sent.at(-1).type, 'response.create');

  const dup = live.ingest({ type: 'session.output_audio.delta', event_id: 'a1', delta: 'AAAA' });
  assert.equal(dup.type, 'audio');
  assert.equal(live.ingest({ type: 'session.output_audio.delta', event_id: 'a1', delta: 'AAAA' }).reason, 'duplicate');

  live.close('operator_ended');
  assert.equal(socket.sent.at(-1).type, 'session.close');
  assert.equal(live.state, 'closing');
  live.ingest({ type: 'session.closed' });
  assert.equal(live.state, 'closed');
  assert.equal(live.complete, true);
  assert.equal(socket.closed, true);
  assert.equal(events.at(-1).type, 'live_socket_closed');
  assert.equal(events.at(-1).complete, true);
});

test('LiveSession writes fail closed when the socket is not open', () => {
  const socket = openSocket();
  const live = sessionFor(socket, []);
  live.start();
  live.ingest({ type: 'session.started', session: { id: 's' } });
  socket.readyState = 3; // CLOSED
  assert.throws(() => live.appendAudio(Buffer.alloc(160).toString('base64')), (err) => err.message === 'live_socket_unavailable');
  assert.throws(() => live.submitToolOutput('c', {}), (err) => err.message === 'live_socket_unavailable');
});

test('LiveSession: no session.started in time ends the session as incomplete', async () => {
  const socket = openSocket();
  const events = [];
  const live = sessionFor(socket, events, { startTimeoutMs: 20 });
  live.start();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(live.state, 'closed');
  assert.equal(live.reason, 'session_start_timeout');
  assert.equal(live.complete, false);
  assert.equal(socket.closed, true);
  assert.equal(events.at(-1).complete, false);
});

test('LiveSession: a session.closed that never arrives is recorded as incomplete finalization', async () => {
  const socket = openSocket();
  const events = [];
  const live = sessionFor(socket, events, { closeTimeoutMs: 20 });
  live.start();
  live.ingest({ type: 'session.started', session: { id: 's' } });
  live.close('operator_ended');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(live.state, 'closed');
  assert.equal(live.reason, 'close_timeout');
  assert.equal(events.at(-1).complete, false);
});

test('LiveSession: a provider error during start closes the session; a dropped socket is reported', () => {
  const socket = openSocket();
  const events = [];
  const live = sessionFor(socket, events);
  live.start();
  live.ingest({ type: 'error', error: { code: 'bad_config' } });
  assert.equal(live.state, 'closed');
  assert.equal(events.at(-1).reason, 'provider_error_at_start');

  const socket2 = openSocket();
  const events2 = [];
  const live2 = sessionFor(socket2, events2);
  live2.start();
  live2.ingest({ type: 'session.started', session: { id: 's' } });
  live2.onSocketClosed();
  assert.equal(events2.at(-1).type, 'live_socket_closed');
  assert.equal(events2.at(-1).complete, false);
});

test('LiveSession is never constructed from an invalid start message', () => {
  assert.throws(() => new LiveSession({ sessionStart: { type: 'session.update' } }), (err) => err.message === 'invalid_live_config');
});

// ---- orchestrator wired to a GPT-Live session ---------------------------------

const PROFILE = {
  businessName: 'Acme',
  legalIdentity: 'Acme LLC',
  consentPurpose: 'sales',
  consentBasis: 'express_written',
  aiDisclosure: 'This call is handled by an automated assistant.',
  allowedCountries: ['US'],
  retentionDays: 30,
};
const CONSENT = {
  phone: '+15550123456',
  channel: 'voice',
  purpose: 'sales',
  status: 'granted',
  evidence: 'signed form 2026-01-01',
  source: 'web-form',
  businessName: 'Acme',
  consentedAt: '2026-01-01T00:00:00Z',
};

function zoneForLocalHour(hour) {
  const utcHour = new Date().getUTCHours();
  let offset = hour - utcHour;
  if (offset > 14) offset -= 24;
  if (offset < -12) offset += 24;
  return offset >= 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
}

function seedEligible(db) {
  db.prepare(
    `INSERT INTO leads (name, phone, call_type, timezone, consent_status, consent_evidence, consent_source, consent_date, status)
     VALUES ('Live Lead', '+15550123456', 'sales', ?, 'recorded', 'signed form', 'web-form', '2026-01-01', 'pending')`
  ).run(zoneForLocalHour(12));
  const leadId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  db.prepare("INSERT INTO campaigns (name, status) VALUES ('Live Campaign', 'running')").run();
  const campaignId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  db.prepare("INSERT INTO campaign_leads (campaign_id, lead_id, status) VALUES (?, ?, 'dialing')").run(campaignId, leadId);
  upsertComplianceProfile(db, campaignId, PROFILE);
  setConsent(db, CONSENT);
  return { campaignId, leadId };
}

function liveCfg(extra = {}) {
  return mergeConfig({ voice: { liveBackendModel: 'backend-model-x', ...extra } });
}

test('createLiveRealtimeFactory refuses to build without an explicit backend model', () => {
  assert.throws(() => createLiveRealtimeFactory(mergeConfig({}).voice), (err) => err.message === 'invalid_live_config');
});

test('orchestrator + GPT-Live: session starts on answer, tools get answers, and a dropped socket ends the call', () => {
  const db = createDb(':memory:');
  try {
    const { campaignId, leadId } = seedEligible(db);
    const cfg = liveCfg();
    const mediaSocket = openSocket();
    const liveSocket = openSocket();
    const orch = createVoiceOrchestrator(db, {
      cfg,
      mediaStreamFactory: ({ socket }) => new MediaStreamSession({ socket }),
      realtimeFactory: createLiveRealtimeFactory(cfg.voice, { startTimeoutMs: 1000, closeTimeoutMs: 1000 }),
      mandatoryAudio: syntheticDisclosureRegistry(),
    });
    const call = orch.start({ campaignId, leadId, mediaSocket, realtimeSocket: liveSocket });
    call.providerEvent({ sid: call.session.providerCallSid, status: 'in_progress', eventId: 'ans-1' });
    assert.equal(liveSocket.sent.length, 0, 'no model session before the disclosure mark');
    playDisclosure(call);
    assert.equal(liveSocket.sent[0].type, 'session.start');
    assert.equal(call.realtime.state, 'starting');

    call.onRealtime({ type: 'session.started', session: { id: 'live_1' } });
    assert.equal(call.realtime.state, 'ready');

    // Telephony caller audio goes to the model unchanged (G.711 frames).
    call.onMedia({ event: 'media', streamSid: `SS${call.sessionId}`, media: { payload: Buffer.alloc(160, 9).toString('base64') } });
    assert.equal(liveSocket.sent.at(-1).type, 'session.input_audio.append');

    // Model audio returns to the caller.
    call.onRealtime({ type: 'session.output_audio.delta', delta: 'BBBB' });
    assert.equal(mediaSocket.sent.at(-1).event, 'media');

    // A permitted backend tool gets an answer; the call stays live.
    const ok = call.onRealtime({
      type: 'response.event',
      event: { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'c-ok', name: 'approved_response', arguments: '{"lineKey":"reprompt"}' } },
    });
    assert.equal(ok.ok, true);
    const answer = liveSocket.sent.find((m) => m.type === 'response.item.create' && m.item.call_id === 'c-ok');
    assert.ok(answer, 'the function result is returned to the model');
    assert.equal(call.state, 'active');

    // A disallowed tool is rejected AND still answered, so the backend is not stuck.
    const rejected = call.onRealtime({
      type: 'response.event',
      event: { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'c-bad', name: 'wire_money', arguments: '{}' } },
    });
    assert.equal(rejected.rejected, 'tool_not_allowed');
    assert.ok(liveSocket.sent.some((m) => m.type === 'response.item.create' && m.item.call_id === 'c-bad'));

    // The provider drops the connection without finishing: the call ends safely.
    call.realtime.onSocketClosed();
    assert.equal(call.state, 'ended');
    const stored = getVoiceSession(db, call.sessionId);
    assert.equal(stored.status, 'ended');
    assert.equal(stored.outcome, 'unanswered');
    assert.equal(db.prepare('SELECT status FROM campaign_leads WHERE lead_id = ?').get(leadId).status, 'queued');
  } finally {
    db.close();
  }
});

test('orchestrator + GPT-Live: end_call hangs up and does not try to reply on a closed session', () => {
  const db = createDb(':memory:');
  try {
    const { campaignId, leadId } = seedEligible(db);
    const cfg = liveCfg();
    const liveSocket = openSocket();
    const orch = createVoiceOrchestrator(db, {
      cfg,
      mediaStreamFactory: ({ socket }) => new MediaStreamSession({ socket }),
      realtimeFactory: createLiveRealtimeFactory(cfg.voice, { startTimeoutMs: 1000, closeTimeoutMs: 1000 }),
      mandatoryAudio: syntheticDisclosureRegistry(),
    });
    const call = orch.start({ campaignId, leadId, mediaSocket: openSocket(), realtimeSocket: liveSocket });
    call.providerEvent({ sid: call.session.providerCallSid, status: 'in_progress', eventId: 'ans-2' });
    playDisclosure(call);
    call.onRealtime({ type: 'session.started', session: { id: 'live_2' } });
    const before = liveSocket.sent.length;
    const result = call.onRealtime({
      type: 'response.event',
      event: { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'c-end', name: 'end_call', arguments: '{}' } },
    });
    assert.equal(result.end, true);
    assert.equal(call.state, 'ended');
    assert.ok(!liveSocket.sent.slice(before).some((m) => m.type === 'response.item.create'), 'no reply after the call ended');
    assert.equal(liveSocket.sent.at(-1).type, 'session.close', 'the live session is closed gracefully');
  } finally {
    db.close();
  }
});

// ---- real ws transport against a loopback server (no external network) -------

async function startLoopbackServer(behavior) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, verifyClient: behavior.verifyClient });
  await new Promise((resolve) => wss.once('listening', resolve));
  const seen = { headers: null, first: null, messages: [] };
  wss.on('connection', (ws, req) => {
    seen.headers = req.headers;
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      seen.messages.push(msg);
      if (seen.first === null) seen.first = msg.type;
      behavior.onMessage(ws, msg);
    });
  });
  const url = `ws://127.0.0.1:${wss.address().port}/`;
  return { wss, url, seen, close: () => new Promise((resolve) => wss.close(resolve)) };
}

test('connectLiveSocket refuses insecure URLs and short keys before connecting', async () => {
  await assert.rejects(connectLiveSocket({ apiKey: LIVE_KEY, url: 'ws://example.com/x' }), (err) => err.message === 'insecure_live_url');
  await assert.rejects(connectLiveSocket({ apiKey: 'short', url: 'wss://api.openai.com/v1/live/sessions' }), (err) => err.message === 'provider_not_configured');
});

test('real ws: authenticated connect, session.start first, audio round trip, graceful close', async () => {
  const server = await startLoopbackServer({
    onMessage(ws, msg) {
      if (msg.type === 'session.start') {
        ws.send(JSON.stringify({ type: 'session.started', session: { id: 'live_loop' } }));
      } else if (msg.type === 'session.input_audio.append') {
        ws.send(JSON.stringify({ type: 'session.output_audio.delta', delta: msg.audio }));
      } else if (msg.type === 'session.close') {
        ws.send(JSON.stringify({ type: 'session.closed', usage: {} }));
      }
    },
  });
  const events = [];
  try {
    const socket = await connectLiveSocket({ apiKey: LIVE_KEY, url: server.url, allowLoopbackForTests: true, timeoutMs: 2000 });
    assert.equal(server.seen.headers.authorization, `Bearer ${LIVE_KEY}`, 'key sent only as a bearer header');
    const live = new LiveSession({
      socket,
      sessionStart: buildLiveSessionStart({ backendModel: 'backend-model-x' }),
      onEvent: (e) => events.push(e),
      startTimeoutMs: 2000,
      closeTimeoutMs: 2000,
    });
    const received = [];
    attachLiveSocket(socket, live);
    socket.on('message', (d) => received.push(JSON.parse(d.toString())));
    live.start();
    await waitFor(() => live.state === 'ready');
    assert.equal(server.seen.first, 'session.start');

    const frame = Buffer.alloc(160, 0x7f).toString('base64');
    live.appendAudio(frame);
    await waitFor(() => received.some((m) => m.type === 'session.output_audio.delta'));
    assert.equal(received.find((m) => m.type === 'session.output_audio.delta').delta, frame);

    live.close('operator_ended');
    await waitFor(() => live.state === 'closed');
    assert.equal(live.complete, true);
    assert.equal(events.at(-1).type, 'live_socket_closed');
    assert.equal(events.at(-1).complete, true);
  } finally {
    await server.close();
  }
});

test('real ws: a server that never answers session.start is cut off by the start timeout', async () => {
  const server = await startLoopbackServer({ onMessage() {} });
  const events = [];
  try {
    const socket = await connectLiveSocket({ apiKey: LIVE_KEY, url: server.url, allowLoopbackForTests: true, timeoutMs: 2000 });
    const live = new LiveSession({
      socket,
      sessionStart: buildLiveSessionStart({ backendModel: 'backend-model-x' }),
      onEvent: (e) => events.push(e),
      startTimeoutMs: 80,
    });
    attachLiveSocket(socket, live);
    live.start();
    await waitFor(() => live.state === 'closed', 2000);
    assert.equal(live.reason, 'session_start_timeout');
    assert.equal(events.at(-1).complete, false);
  } finally {
    await server.close();
  }
});

test('real ws: a rejected key (HTTP 401 at upgrade) is reported without echoing the key', async () => {
  const server = await startLoopbackServer({ verifyClient: (_info, cb) => cb(false, 401, 'Unauthorized'), onMessage() {} });
  try {
    await assert.rejects(
      connectLiveSocket({ apiKey: LIVE_KEY, url: server.url, allowLoopbackForTests: true, timeoutMs: 2000 }),
      (err) => {
        assert.equal(err.message, 'live_connect_rejected');
        assert.equal(err.details.status, 401);
        assert.ok(!JSON.stringify(err).includes(LIVE_KEY));
        return true;
      }
    );
  } finally {
    await server.close();
  }
});

test('real ws: a connection to a closed port fails promptly with a stable code', async () => {
  const probe = await startLoopbackServer({ onMessage() {} });
  const url = probe.url;
  await probe.close();
  await assert.rejects(
    connectLiveSocket({ apiKey: LIVE_KEY, url, allowLoopbackForTests: true, timeoutMs: 2000 }),
    (err) => err.message === 'live_connect_failed' && !JSON.stringify(err).includes(LIVE_KEY)
  );
});

async function waitFor(predicate, ms = 2000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('the real-transport modules do not reach the network at import time', async () => {
  const { readFileSync } = await import('node:fs');
  for (const file of ['../src/providers/twilioRest.js', '../src/providers/gptLive.js']) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.ok(!/^\s*(await\s+)?fetch\(/m.test(src), `${file} must not call fetch at module top level`);
    assert.ok(!/new WebSocket\(/.test(src.split('export function connectLiveSocket')[0]), `${file} must not open a socket at import`);
  }
});

test('no real transport is registered in the live voice stack', async () => {
  const { VOICE_STACKS, describeVoiceStack } = await import('../src/providers/voiceStack.js');
  assert.deepEqual(Object.keys(VOICE_STACKS), ['fake']);
  const described = describeVoiceStack(mergeConfig({ voice: { provider: 'twilio' } }).voice, {});
  assert.equal(described.ready, false);
  assert.equal(described.liveEnabled, false);
});
