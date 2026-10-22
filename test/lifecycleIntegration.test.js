import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { createDb } from '../src/db/db.js';
import { createApp, mergeConfig } from '../src/app.js';
import { raw } from '../test-support/helpers.js';
import { HttpError } from '../src/lib/errors.js';
import { signatureBase } from '../src/providers/twilio.js';
import { MEDIA_PATH } from '../src/providers/mediaStreamServer.js';
import { createTwilioCallProvider } from '../src/services/outboundPlacement.js';
import { CallLifecycle, attachLifecycleMedia } from '../src/services/callLifecycle.js';
import { createLiveRealtimeFactory } from '../src/providers/gptLive.js';
import { syntheticDisclosureRegistry } from '../test-support/orchestrationFixtures.js';
import { EMPTY_MANDATORY_AUDIO, MANDATORY_MARK } from '../src/services/mandatoryAudio.js';
import { upsertComplianceProfile, setConsent, revokeConsent } from '../src/services/complianceProfile.js';

// Integration tests. Everything is local: a temporary in-memory database, a loopback
// HTTP/WebSocket server, a fake telephony transport, and a fake AI socket. A guard
// below rejects any non-loopback fetch. No test contacts Twilio or OpenAI, and the
// lead phone number is synthetic.

const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = (input, init) => {
    const host = new URL(typeof input === 'string' ? input : input.url).hostname;
    if (!['127.0.0.1', 'localhost'].includes(host)) throw new Error(`network access blocked in tests: ${host}`);
    return realFetch(input, init);
  };
});
after(() => {
  globalThis.fetch = realFetch;
});

const PUBLIC = 'https://apex.example.com';
const TWILIO_TOKEN = 'twilio-test-token-not-real';
const VOICE_SECRET = 'voice-test-secret-not-real';
const LEAD_PHONE = '+15550123456';
const CALL_SID = 'CA' + 'd'.repeat(32);
const STREAM_SID = 'MZ' + '1'.repeat(32);
const FRAME = Buffer.alloc(160, 0x7f).toString('base64'); // 20 ms of G.711 mu-law
const MODEL_FRAME = Buffer.alloc(160, 0x55).toString('base64');
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
  phone: LEAD_PHONE,
  channel: 'voice',
  purpose: 'sales',
  status: 'granted',
  evidence: 'synthetic evidence 2026-01-01',
  source: 'test',
  businessName: 'Acme',
  consentedAt: '2026-01-01T00:00:00Z',
};

const cfg = mergeConfig({
  publicBaseUrl: PUBLIC,
  voice: { enabled: true, webhookSecret: VOICE_SECRET, fromNumber: '+15550001111', liveBackendModel: 'backend-model-x' },
  telephony: { webhookSecret: TWILIO_TOKEN },
});

// ---- fakes ------------------------------------------------------------------------

// Fake provider transport: records every request; a script decides each create outcome.
function mockTransport(script = async () => ({ sid: CALL_SID, status: 'queued' })) {
  const t = {
    creates: [],
    ends: [],
    createCall(args) {
      t.creates.push(args);
      return script(args, t.creates.length);
    },
    endCall(sid) {
      t.ends.push(sid);
      return Promise.resolve({ sid, status: 'completed' });
    },
  };
  return t;
}

// Fake AI socket with the same surface as a ws WebSocket for the operations used here.
class FakeAiSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
    this.closed = false;
    this.closeArgs = null;
  }
  send(text) {
    if (this.readyState !== 1) throw new Error('socket not open');
    this.sent.push(JSON.parse(text));
  }
  on(event, fn) {
    return super.on(event, fn);
  }
  close(code, reason) {
    this.closed = true;
    this.closeArgs = { code, reason };
    this.readyState = 3;
    this.emit('close');
  }
  terminate() {
    this.close(1006, '');
  }
  deliver(obj) {
    this.emit('message', JSON.stringify(obj));
  }
  types() {
    return this.sent.map((m) => m.type);
  }
}

// ---- fixtures ------------------------------------------------------------------------

function zoneForLocalHour(hour) {
  const utcHour = new Date().getUTCHours();
  let offset = hour - utcHour;
  if (offset > 14) offset -= 24;
  if (offset < -12) offset += 24;
  return offset >= 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
}

function seedAttempt(db) {
  db.prepare(
    `INSERT INTO leads (name, phone, call_type, timezone, consent_status, consent_evidence, consent_source, consent_date, status)
     VALUES ('Synthetic Lead', ?, 'sales', ?, 'recorded', 'synthetic', 'test', '2026-01-01', 'pending')`
  ).run(LEAD_PHONE, zoneForLocalHour(12));
  const leadId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  db.prepare("INSERT INTO campaigns (name, status) VALUES ('Lifecycle Campaign', 'running')").run();
  const campaignId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  db.prepare("INSERT INTO campaign_leads (campaign_id, lead_id, status) VALUES (?, ?, 'dialing')").run(campaignId, leadId);
  db.prepare("INSERT INTO calls (lead_id, direction, status, call_type, started_at) VALUES (?, 'outbound', 'queued', 'sales', datetime('now'))").run(leadId);
  const callId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  db.prepare(
    "INSERT INTO voice_sessions (campaign_id, lead_id, call_id, provider, status, phase, started_at) VALUES (?, ?, ?, 'twilio', 'starting', 'greeting', datetime('now'))"
  ).run(campaignId, leadId, callId);
  const sessionId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  upsertComplianceProfile(db, campaignId, PROFILE);
  setConsent(db, CONSENT);
  return { campaignId, leadId, callId, sessionId };
}

async function stack(opts = {}) {
  const db = createDb(':memory:');
  const transport = opts.transport ?? mockTransport();
  const provider = opts.noProvider ? null : createTwilioCallProvider({ transport, publicBaseUrl: PUBLIC });
  const ai = opts.ai ?? new FakeAiSocket();
  const aiCalls = { n: 0 };
  const lifecycle = new CallLifecycle({
    db,
    cfg,
    provider,
    aiConnector: async () => {
      aiCalls.n += 1;
      if (opts.aiFail) throw new Error('connect refused');
      return ai;
    },
    realtimeFactory: createLiveRealtimeFactory(cfg.voice, { startTimeoutMs: 2000, closeTimeoutMs: 2000 }),
    mandatoryAudio: opts.mandatoryAudio ?? syntheticDisclosureRegistry(),
    markTimeoutMs: opts.markTimeoutMs ?? 2000,
    streamWaitMs: 2000,
    answerTimeoutMs: opts.answerTimeoutMs ?? 60000,
    lookup: opts.lookup ?? null,
  });
  const app = createApp(db, cfg, { lifecycle });
  const http = app.listen(0, '127.0.0.1');
  await new Promise((r) => http.once('listening', r));
  const endpoint = attachLifecycleMedia(http, lifecycle, app.locals.streamTokens);
  const port = http.address().port;
  const seed = seedAttempt(db);
  return {
    db,
    lifecycle,
    transport,
    ai,
    aiCalls,
    seed,
    base: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}${MEDIA_PATH}`,
    async close() {
      try {
        lifecycle.shutdown();
      } catch {
        // already torn down
      }
      endpoint.close();
      http.closeAllConnections?.();
      await new Promise((r) => http.close(r));
      db.close();
    },
  };
}

const sign = (path, params) =>
  createHmac('sha1', TWILIO_TOKEN).update(signatureBase(`${PUBLIC}${path}`, params)).digest('base64');

async function post(env, path, params, { signature } = {}) {
  return raw(env.base, 'POST', path, {
    body: new URLSearchParams(params).toString(),
    contentType: 'application/x-www-form-urlencoded',
    headers: { 'x-twilio-signature': signature ?? sign(path, params) },
  });
}

const statusCb = (env, rawStatus) => post(env, '/api/voice/webhooks/twilio/status', { CallSid: CALL_SID, CallStatus: rawStatus });

async function fetchTwiml(env, sessionId) {
  const res = await post(env, `/api/voice/webhooks/twiml/${sessionId}`, { CallSid: CALL_SID });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const token = /<Parameter name="token" value="([^"]+)"/.exec(String(res.body))?.[1];
  assert.ok(token, 'TwiML carries a stream token');
  return token;
}

function openStream(env) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(env.wsUrl);
    const q = { items: [], waiters: [], closed: null, closeWaiters: [] };
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      const i = q.waiters.findIndex((w) => w.pred(m));
      if (i >= 0) q.waiters.splice(i, 1)[0].resolve(m);
      else q.items.push(m);
    });
    ws.once('close', (code, reason) => {
      q.closed = { code, reason: reason.toString() };
      for (const w of q.closeWaiters.splice(0)) w(q.closed);
    });
    q.next = (pred, ms = 3000) => {
      const i = q.items.findIndex(pred);
      if (i >= 0) return Promise.resolve(q.items.splice(i, 1)[0]);
      return new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('timed out waiting for stream message')), ms);
        q.waiters.push({ pred, resolve: (m) => { clearTimeout(t); res(m); } });
      });
    };
    q.closedAfter = (ms = 3000) =>
      q.closed
        ? Promise.resolve(q.closed)
        : new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error('stream did not close')), ms);
            q.closeWaiters.push((c) => { clearTimeout(t); res(c); });
          });
    q.send = (obj) => ws.send(JSON.stringify(obj));
    ws.once('open', () => resolve(q));
    ws.once('error', reject);
  });
}

const startMsg = (token, callSid = CALL_SID) => ({
  event: 'start',
  sequenceNumber: '1',
  streamSid: STREAM_SID,
  start: {
    accountSid: 'AC' + '2'.repeat(32),
    streamSid: STREAM_SID,
    callSid,
    tracks: ['inbound'],
    customParameters: { token },
    mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
  },
});
const mediaMsg = (payload) => ({ event: 'media', streamSid: STREAM_SID, media: { track: 'inbound', chunk: '1', timestamp: '5', payload } });

// Open a stream carrying a token. Returns the queue once the socket is open.
async function connectStream(env, token, callSid = CALL_SID) {
  const q = await openStream(env);
  q.send({ event: 'connected', protocol: 'Call', version: '1.0.0' });
  q.send(startMsg(token, callSid));
  return q;
}

// Connect and report how the server closed it (for rejected streams).
async function attemptStream(env, token, callSid = CALL_SID) {
  const q = await openStream(env);
  q.send({ event: 'connected', protocol: 'Call', version: '1.0.0' });
  q.send(startMsg(token, callSid));
  return q.closedAfter();
}

async function waitFor(pred, ms = 3000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const sessionRow = (env, id) => env.db.prepare('SELECT * FROM voice_sessions WHERE id = ?').get(id);
const leadStatus = (env) =>
  env.db.prepare('SELECT status FROM campaign_leads WHERE lead_id = ?').get(env.seed.leadId).status;

const fc = (callId, name, args = '{}') => ({
  type: 'response.event',
  event_id: 'e-' + callId,
  event: { type: 'response.output_item.done', item: { type: 'function_call', call_id: callId, name, arguments: args } },
});

async function replyFor(env, callId) {
  await waitFor(() => env.ai.sent.some((m) => m.type === 'response.item.create' && m.item?.call_id === callId));
  const msg = env.ai.sent.find((m) => m.type === 'response.item.create' && m.item?.call_id === callId);
  return JSON.parse(msg.item.output);
}

// Drive a call to live: placed, ringing, answered, stream bound, disclosure echoed,
// AI session started. Returns the stream queue.
async function goLive(env) {
  const { sessionId } = env.seed;
  await env.lifecycle.place({ sessionId });
  const token = await fetchTwiml(env, sessionId);
  assert.equal((await statusCb(env, 'ringing')).body.data.type, 'applied');
  assert.equal((await statusCb(env, 'in-progress')).body.data.status, 'in_progress');
  const q = await connectStream(env, token);
  await q.next((m) => m.event === 'mark' && m.mark?.name === MANDATORY_MARK);
  assert.equal(env.aiCalls.n, 0, 'no AI connection before the disclosure mark is echoed');
  q.send({ event: 'mark', streamSid: STREAM_SID, mark: { name: MANDATORY_MARK } });
  await waitFor(() => env.ai.sent.length > 0);
  env.ai.deliver({ type: 'session.started', session: { id: 'live_1' } });
  return { q, sessionId };
}

// ---- tests -----------------------------------------------------------------------------

test('happy path: placement, answer, stream, disclosure, mark echo, AI session, audio both ways, carrier stop', async () => {
  const env = await stack();
  try {
    const { q, sessionId } = await goLive(env);

    // Exact provider create request: caller ID from settings, public https URLs only.
    const args = env.transport.creates[0];
    assert.equal(args.to, LEAD_PHONE);
    assert.equal(args.from, '+15550001111');
    assert.equal(args.twimlUrl, `${PUBLIC}/api/voice/webhooks/twiml/${sessionId}`);
    assert.equal(args.statusCallbackUrl, `${PUBLIC}/api/voice/webhooks/twilio/status`);

    // The disclosure audio went out as Media Streams media frames before the mark.
    assert.equal(q.items.filter((m) => m.event === 'media').length, 4);

    // The AI session is configured for G.711 mu-law at 8 kHz, the same codec as the
    // Media Streams payloads. The adapter's session.start is the first model message.
    assert.equal(env.ai.sent[0].type, 'session.start');
    assert.deepEqual(env.ai.sent[0].session.audio.format, { type: 'audio/pcmu', rate: 8000 });

    // Caller audio reaches the model unchanged.
    q.send(mediaMsg(FRAME));
    await waitFor(() => env.ai.sent.some((m) => m.type === 'session.input_audio.append'));
    assert.equal(env.ai.sent.find((m) => m.type === 'session.input_audio.append').audio, FRAME);

    // Model audio returns to the carrier unchanged.
    env.ai.deliver({ type: 'session.output_audio.delta', delta: MODEL_FRAME });
    const out = await q.next((m) => m.event === 'media' && m.media?.payload === MODEL_FRAME);
    assert.equal(out.streamSid, STREAM_SID);

    // Carrier stop ends the call once: AI gets session.close, then closes after session.closed.
    q.send({ event: 'stop', streamSid: STREAM_SID, stop: { accountSid: 'AC' + '2'.repeat(32), callSid: CALL_SID } });
    await waitFor(() => env.ai.types().includes('session.close'));
    env.ai.deliver({ type: 'session.closed', usage: {} });
    await waitFor(() => env.ai.closed);

    const row = sessionRow(env, sessionId);
    assert.equal(row.status, 'ended');
    assert.equal(row.outcome, 'unanswered');
    assert.equal(row.disconnect_reason, 'stream_stopped');
    assert.equal(leadStatus(env), 'queued');
    assert.equal(env.lifecycle.recordCount(), 0, 'the record is released on termination');
  } finally {
    await env.close();
  }
});

test('the stream may connect while ringing; disclosure starts only when the answer arrives', async () => {
  const env = await stack();
  try {
    const { sessionId } = env.seed;
    await env.lifecycle.place({ sessionId });
    const token = await fetchTwiml(env, sessionId);
    const q = await connectStream(env, token);
    await waitFor(() => env.lifecycle.recordFor(sessionId)?.media);
    const rec = env.lifecycle.recordFor(sessionId);
    assert.equal(rec.call.disclosure.state, 'pending');
    assert.equal(q.items.length, 0, 'nothing is played before the answer');

    await statusCb(env, 'ringing');
    await statusCb(env, 'in-progress');
    await q.next((m) => m.event === 'mark' && m.mark?.name === MANDATORY_MARK);
    assert.equal(rec.call.disclosure.state, 'awaiting_mark');
    assert.equal(env.aiCalls.n, 0);
  } finally {
    await env.close();
  }
});

test('callbacks before binding are ignored, and duplicate callbacks are absorbed once', async () => {
  const env = await stack();
  try {
    // Before placement the SID is not bound: the callback matches no session.
    const early = await statusCb(env, 'in-progress');
    assert.equal(early.status, 200);
    assert.equal(early.body.data.reason, 'session_not_found');
    assert.equal(sessionRow(env, env.seed.sessionId).status, 'starting');

    await env.lifecycle.place({ sessionId: env.seed.sessionId });
    const first = await statusCb(env, 'ringing');
    assert.equal(first.body.data.type, 'applied');
    const dup = await statusCb(env, 'ringing');
    assert.equal(dup.body.data.reason, 'duplicate');
    assert.equal(env.db.prepare("SELECT COUNT(*) AS c FROM provider_events WHERE provider = 'twilio' AND event_type = 'ringing'").get().c, 1);
  } finally {
    await env.close();
  }
});

test('ambiguous create: never retried, the lead is not requeued, and reconciliation is refused without a lookup', async () => {
  const transport = mockTransport(async () => {
    throw new HttpError(502, 'provider_timeout', { retryable: true, timeout: true, ambiguous: true });
  });
  const env = await stack({ transport });
  try {
    const { sessionId } = env.seed;
    await assert.rejects(env.lifecycle.place({ sessionId }), (e) => e.status === 502 && e.message === 'provider_create_ambiguous' && e.details.reconcile === true);
    await assert.rejects(env.lifecycle.place({ sessionId }), (e) => e.status === 409 && e.message === 'attempt_already_claimed');
    assert.equal(transport.creates.length, 1, 'exactly one provider create request');
    assert.equal(sessionRow(env, sessionId).disconnect_reason, 'ambiguous_create');
    assert.equal(env.db.prepare('SELECT last_outcome FROM campaign_leads WHERE lead_id = ?').get(env.seed.leadId).last_outcome, 'ambiguous');
    assert.equal(leadStatus(env), 'failed');
    await assert.rejects(env.lifecycle.reconcileAmbiguous({ sessionId }), (e) => e.status === 503 && e.message === 'reconciliation_unavailable');
  } finally {
    await env.close();
  }
});

test('reconciliation with a provider lookup reports the finding and changes nothing', async () => {
  let found = { sid: CALL_SID };
  const transport = mockTransport(async () => {
    throw new HttpError(502, 'provider_unavailable', { ambiguous: true });
  });
  const env = await stack({ transport, lookup: async () => found });
  try {
    const { sessionId } = env.seed;
    await assert.rejects(env.lifecycle.place({ sessionId }), (e) => e.message === 'provider_create_ambiguous');
    const hit = await env.lifecycle.reconcileAmbiguous({ sessionId, username: 'operator' });
    assert.deepEqual(hit, { found: true, sid: CALL_SID });
    found = null;
    const miss = await env.lifecycle.reconcileAmbiguous({ sessionId, username: 'operator' });
    assert.equal(miss.found, false);
    assert.equal(sessionRow(env, sessionId).status, 'failed', 'reconciliation never reopens a session');
    assert.equal(transport.creates.length, 1, 'reconciliation never places a call');
  } finally {
    await env.close();
  }
});

test('concurrent placements for one session: exactly one provider request', async () => {
  const env = await stack();
  try {
    const { sessionId } = env.seed;
    const a = env.lifecycle.place({ sessionId });
    const b = env.lifecycle.place({ sessionId });
    await assert.rejects(b, (e) => e.status === 409);
    await a;
    assert.equal(env.transport.creates.length, 1);
  } finally {
    await env.close();
  }
});

test('placement without a configured provider fails closed before anything is claimed', async () => {
  const env = await stack({ noProvider: true });
  try {
    await assert.rejects(env.lifecycle.place({ sessionId: env.seed.sessionId }), (e) => e.status === 503 && e.message === 'provider_not_configured');
    assert.equal(sessionRow(env, env.seed.sessionId).status, 'starting');
    assert.equal(env.lifecycle.recordCount(), 0);
  } finally {
    await env.close();
  }
});

test('no approved disclosure audio: the call ends at the stream, and no AI connection is ever made', async () => {
  const env = await stack({ mandatoryAudio: EMPTY_MANDATORY_AUDIO });
  try {
    const { sessionId } = env.seed;
    await env.lifecycle.place({ sessionId });
    const token = await fetchTwiml(env, sessionId);
    await statusCb(env, 'ringing');
    await statusCb(env, 'in-progress');
    const q = await connectStream(env, token);
    await waitFor(() => sessionRow(env, sessionId).status === 'ended');
    assert.equal(sessionRow(env, sessionId).disconnect_reason, 'disclosure_unavailable');
    assert.equal(env.aiCalls.n, 0);
    assert.equal(env.ai.sent.length, 0);
    assert.equal(q.items.filter((m) => m.event === 'media').length, 0, 'no audio was sent');
  } finally {
    await env.close();
  }
});

test('an AI connection failure ends the call after the disclosure, and nothing reaches the model', async () => {
  const env = await stack({ aiFail: true });
  try {
    const { sessionId } = env.seed;
    await env.lifecycle.place({ sessionId });
    const token = await fetchTwiml(env, sessionId);
    await statusCb(env, 'ringing');
    await statusCb(env, 'in-progress');
    const q = await connectStream(env, token);
    await q.next((m) => m.event === 'mark' && m.mark?.name === MANDATORY_MARK);
    q.send({ event: 'mark', streamSid: STREAM_SID, mark: { name: MANDATORY_MARK } });
    await waitFor(() => sessionRow(env, sessionId).status === 'ended');
    assert.equal(sessionRow(env, sessionId).disconnect_reason, 'ai_connect_failed');
    assert.equal(env.aiCalls.n, 1, 'one connection attempt, no retry');
    assert.equal(env.ai.sent.length, 0);
  } finally {
    await env.close();
  }
});

test('a model error ends the call safely and records the reason', async () => {
  const env = await stack();
  try {
    const { sessionId } = await goLive(env);
    env.ai.deliver({ type: 'error', error: { code: 'server_error', message: 'upstream failure' } });
    await waitFor(() => sessionRow(env, sessionId).status === 'ended');
    assert.equal(sessionRow(env, sessionId).disconnect_reason, 'provider_error');
    assert.ok(env.ai.types().includes('session.close') || env.ai.closed, 'the model session is released');
  } finally {
    await env.close();
  }
});

test('tool authorization: allowlisted tools reply, revoked consent blocks speech, unknown tools are refused, end_call still ends', async () => {
  const env = await stack();
  try {
    const { q, sessionId } = await goLive(env);
    void q;
    env.ai.deliver(fc('c1', 'approved_response', '{"lineKey":"reprompt"}'));
    assert.equal((await replyFor(env, 'c1')).ok, true);

    revokeConsent(env.db, { phone: LEAD_PHONE, channel: 'voice', purpose: 'sales' });
    env.ai.deliver(fc('c2', 'approved_response', '{"lineKey":"reprompt"}'));
    const blocked = await replyFor(env, 'c2');
    assert.equal(blocked.ok, false);
    assert.equal(blocked.rejected, 'eligibility_revoked');

    env.ai.deliver(fc('c3', 'wire_money', '{}'));
    assert.equal((await replyFor(env, 'c3')).rejected, 'tool_not_allowed');

    env.ai.deliver(fc('c4', 'end_call', '{}'));
    await waitFor(() => sessionRow(env, sessionId).status === 'ended');
    assert.equal(sessionRow(env, sessionId).disconnect_reason, 'tool:end_call');
  } finally {
    await env.close();
  }
});

test('a model that never receives the disclosure mark is cut off at the mark deadline', async () => {
  const env = await stack({ markTimeoutMs: 30 });
  try {
    const { sessionId } = env.seed;
    await env.lifecycle.place({ sessionId });
    const token = await fetchTwiml(env, sessionId);
    await statusCb(env, 'ringing');
    await statusCb(env, 'in-progress');
    const q = await connectStream(env, token);
    await q.next((m) => m.event === 'mark' && m.mark?.name === MANDATORY_MARK);
    await waitFor(() => {
      env.lifecycle.tick();
      return sessionRow(env, sessionId).status === 'ended';
    });
    assert.equal(sessionRow(env, sessionId).disconnect_reason, 'disclosure_timeout');
    assert.equal(env.aiCalls.n, 0);
  } finally {
    await env.close();
  }
});

test('an unanswered call is cancelled at the answer timeout, with one provider cancel and no retry', async () => {
  const env = await stack({ answerTimeoutMs: 20 });
  try {
    const { sessionId } = env.seed;
    await env.lifecycle.place({ sessionId });
    await waitFor(() => {
      env.lifecycle.tick();
      return sessionRow(env, sessionId).status === 'ended';
    });
    assert.equal(sessionRow(env, sessionId).disconnect_reason, 'answer_timeout');
    await waitFor(() => env.transport.ends.length >= 1);
    assert.deepEqual(env.transport.ends, [CALL_SID]);
    assert.equal(env.transport.creates.length, 1);
  } finally {
    await env.close();
  }
});

test('stream binding: wrong Call SID, replayed token, and a second stream for one session are all refused', async () => {
  const env = await stack();
  try {
    const { sessionId } = env.seed;
    await env.lifecycle.place({ sessionId });

    const t1 = await fetchTwiml(env, sessionId);
    const wrong = await attemptStream(env, t1, 'CA' + 'f'.repeat(32));
    assert.deepEqual([wrong.code, wrong.reason], [1008, 'stale_session']);
    const replay = await attemptStream(env, t1, CALL_SID);
    assert.deepEqual([replay.code, replay.reason], [1008, 'unauthorized']);

    const t2 = await fetchTwiml(env, sessionId);
    await connectStream(env, t2);
    await waitFor(() => env.lifecycle.recordFor(sessionId)?.media);

    const t3 = await fetchTwiml(env, sessionId);
    const second = await attemptStream(env, t3, CALL_SID);
    assert.deepEqual([second.code, second.reason], [1008, 'duplicate_binding'], 'the endpoint binding check refuses a second live stream');
  } finally {
    await env.close();
  }
});

test('repeated hangups and terminal callbacks are idempotent: one end, one close, one audit entry', async () => {
  const env = await stack();
  try {
    const { sessionId } = await goLive(env);
    const first = await statusCb(env, 'completed');
    assert.equal(first.body.data.status, 'ended');
    const second = await statusCb(env, 'completed');
    assert.equal(second.body.data.reason, 'session_terminal');
    await waitFor(() => env.ai.types().includes('session.close'));
    assert.equal(env.ai.types().filter((t) => t === 'session.close').length, 1);
    assert.equal(env.db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'voice_session_ended' AND entity_id = ?").get(String(sessionId)).c, 1);
    assert.equal(env.lifecycle.recordCount(), 0);
  } finally {
    await env.close();
  }
});

test('a provider completion while the disclosure is pending ends the call without any AI connection', async () => {
  const env = await stack();
  try {
    const { sessionId } = env.seed;
    await env.lifecycle.place({ sessionId });
    const token = await fetchTwiml(env, sessionId);
    await statusCb(env, 'ringing');
    await statusCb(env, 'in-progress');
    await connectStream(env, token);
    await waitFor(() => env.lifecycle.recordFor(sessionId)?.call.disclosure.state === 'awaiting_mark');
    await statusCb(env, 'completed');
    assert.equal(sessionRow(env, sessionId).status, 'ended');
    assert.equal(env.aiCalls.n, 0);
  } finally {
    await env.close();
  }
});
