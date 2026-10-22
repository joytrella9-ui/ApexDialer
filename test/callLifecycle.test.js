import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import WebSocket from 'ws';
import { createDb } from '../src/db/db.js';
import { createApp, mergeConfig } from '../src/app.js';
import { raw } from '../test-support/helpers.js';
import { HttpError } from '../src/lib/errors.js';
import { signatureBase } from '../src/providers/twilio.js';
import { upsertComplianceProfile, setConsent, revokeConsent } from '../src/services/complianceProfile.js';
import { placeOutboundCall, createTwilioCallProvider, sentinelFor } from '../src/services/outboundPlacement.js';
import { attachMediaStreamServer, MEDIA_PATH } from '../src/providers/mediaStreamServer.js';
import { createStreamTokenStore } from '../src/services/mediaStreamTokens.js';
import { createMandatoryAudioRegistry, EMPTY_MANDATORY_AUDIO, MANDATORY_MARK } from '../src/services/mandatoryAudio.js';
import { buildReadinessReport } from '../src/services/readiness.js';
import { MediaStreamSession } from '../src/providers/twilioMediaStream.js';
import { getVoiceSession } from '../src/services/voiceSessions.js';
import { createVoiceOrchestrator } from '../src/services/voiceOrchestrator.js';
import { syntheticDisclosureRegistry, playDisclosure } from '../test-support/orchestrationFixtures.js';

// ---- offline guard: no non-loopback network during this file --------------------
// The HTTP helpers use loopback. Any other destination is a test failure.
const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
      throw new Error(`network access blocked in tests: ${url.hostname}`);
    }
    return realFetch(input, init);
  };
});
after(() => {
  globalThis.fetch = realFetch;
});

// ---- fixtures -------------------------------------------------------------------------

const PUBLIC = 'https://apex.example.com';
const TWILIO_TOKEN = 'twilio-test-token-not-real';
const VOICE_SECRET = 'voice-test-secret-not-real';
const LEAD_PHONE = '+15550123456';
const CALL_SID = 'CA' + 'd'.repeat(32);
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

function zoneForLocalHour(hour) {
  const utcHour = new Date().getUTCHours();
  let offset = hour - utcHour;
  if (offset > 14) offset -= 24;
  if (offset < -12) offset += 24;
  return offset >= 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
}

// Eligible campaign + lead + dialing campaign_lead + a session in 'starting' with no SID.
function seedAttempt(db, { eligible = true } = {}) {
  db.prepare(
    `INSERT INTO leads (name, phone, call_type, timezone, consent_status, consent_evidence, consent_source, consent_date, status)
     VALUES ('Synthetic Lead', ?, 'sales', ?, 'recorded', 'synthetic', 'test', '2026-01-01', 'pending')`
  ).run(LEAD_PHONE, zoneForLocalHour(12));
  const leadId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  db.prepare("INSERT INTO campaigns (name, status) VALUES ('Lifecycle Campaign', 'running')").run();
  const campaignId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  db.prepare("INSERT INTO campaign_leads (campaign_id, lead_id, status) VALUES (?, ?, 'dialing')").run(campaignId, leadId);
  db.prepare(
    "INSERT INTO calls (lead_id, direction, status, call_type, started_at) VALUES (?, 'outbound', 'queued', 'sales', datetime('now'))"
  ).run(leadId);
  const callId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  db.prepare(
    "INSERT INTO voice_sessions (campaign_id, lead_id, call_id, provider, status, phase, started_at) VALUES (?, ?, ?, 'twilio', 'starting', 'greeting', datetime('now'))"
  ).run(campaignId, leadId, callId);
  const sessionId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  if (eligible) {
    upsertComplianceProfile(db, campaignId, PROFILE);
    setConsent(db, CONSENT);
  }
  return { campaignId, leadId, callId, sessionId };
}

function mockTransport(create = async () => ({ sid: CALL_SID, status: 'queued' })) {
  const t = {
    creates: [],
    ends: [],
    createCall(args) {
      t.creates.push(args);
      return create(args, t.creates.length);
    },
    endCall(sid) {
      t.ends.push(sid);
      return Promise.resolve({ sid, status: 'completed' });
    },
  };
  return t;
}

const cfg = mergeConfig({
  publicBaseUrl: PUBLIC,
  voice: { enabled: true, webhookSecret: VOICE_SECRET, fromNumber: '+15550001111' },
  telephony: { webhookSecret: TWILIO_TOKEN },
});

function sessionRow(db, id) {
  return db.prepare('SELECT * FROM voice_sessions WHERE id = ?').get(id);
}
function leadRow(db, id) {
  return db.prepare('SELECT status FROM campaign_leads WHERE lead_id = ?').get(id);
}

// ---- placement: happy path and exactly-once --------------------------------------------

test('placement claims the session, calls the provider once with public https URLs, and records the Call SID', async () => {
  const db = createDb(':memory:');
  try {
    const { sessionId } = seedAttempt(db);
    const transport = mockTransport();
    const provider = createTwilioCallProvider({ transport, publicBaseUrl: PUBLIC });
    const session = await placeOutboundCall(db, { sessionId, provider, cfg });
    assert.equal(transport.creates.length, 1);
    const args = transport.creates[0];
    assert.equal(args.to, LEAD_PHONE);
    assert.equal(args.from, '+15550001111', 'caller ID comes from the caller-ID setting');
    assert.equal(args.twimlUrl, `${PUBLIC}/api/voice/webhooks/twiml/${sessionId}`);
    assert.equal(args.statusCallbackUrl, `${PUBLIC}/api/voice/webhooks/twilio/status`);
    assert.equal(session.status, 'ringing');
    assert.equal(sessionRow(db, sessionId).provider_call_sid, CALL_SID);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'outbound_call_placed'").get().c, 1);
  } finally {
    db.close();
  }
});

test('a concurrent second placement for the same session is refused and never reaches the provider', async () => {
  const db = createDb(':memory:');
  try {
    const { sessionId } = seedAttempt(db);
    let release;
    const transport = mockTransport(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ sid: CALL_SID, status: 'queued' });
        })
    );
    const provider = createTwilioCallProvider({ transport, publicBaseUrl: PUBLIC });
    const first = placeOutboundCall(db, { sessionId, provider, cfg });
    const second = placeOutboundCall(db, { sessionId, provider, cfg });
    await assert.rejects(second, (err) => err.status === 409 && err.message === 'attempt_already_claimed');
    assert.equal(transport.creates.length, 1, 'exactly one provider call');
    release();
    await first;
    assert.equal(sessionRow(db, sessionId).provider_call_sid, CALL_SID);
  } finally {
    db.close();
  }
});

test('placement refuses a session that is not in the starting state, with no provider call', async () => {
  const db = createDb(':memory:');
  try {
    const { sessionId } = seedAttempt(db);
    db.prepare("UPDATE voice_sessions SET status = 'ended' WHERE id = ?").run(sessionId);
    const transport = mockTransport();
    const provider = createTwilioCallProvider({ transport, publicBaseUrl: PUBLIC });
    await assert.rejects(placeOutboundCall(db, { sessionId, provider, cfg }), (err) => err.status === 409 && err.message === 'invalid_transition');
    assert.equal(transport.creates.length, 0);
  } finally {
    db.close();
  }
});

// ---- placement: ambiguous outcomes are never retried ---------------------------------------

test('an ambiguous create timeout fails the session, does not requeue the lead, and is never retried', async () => {
  const db = createDb(':memory:');
  try {
    const { sessionId, campaignId, leadId } = seedAttempt(db);
    const transport = mockTransport(async () => {
      throw new HttpError(502, 'provider_timeout', { retryable: true, timeout: true, ambiguous: true });
    });
    const provider = createTwilioCallProvider({ transport, publicBaseUrl: PUBLIC });
    await assert.rejects(placeOutboundCall(db, { sessionId, provider, cfg }), (err) => {
      return err.status === 502 && err.message === 'provider_create_ambiguous' && err.details.reconcile === true;
    });
    const row = sessionRow(db, sessionId);
    assert.equal(row.status, 'failed');
    assert.equal(row.disconnect_reason, 'ambiguous_create');
    assert.equal(row.provider_call_sid, sentinelFor(sessionId), 'the sentinel is kept so nothing matches it');
    assert.equal(leadRow(db, leadId).status, 'failed', 'an ambiguous outcome does not requeue the lead');
    const cl = db.prepare('SELECT last_outcome FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').get(campaignId, leadId);
    assert.equal(cl.last_outcome, 'ambiguous');

    // Any follow-up attempt on the same session is refused without touching the provider.
    await assert.rejects(placeOutboundCall(db, { sessionId, provider, cfg }), (err) => err.status === 409);
    assert.equal(transport.creates.length, 1, 'no automatic retry, no second call');
  } finally {
    db.close();
  }
});

test('a malformed create response is treated as ambiguous, not as a successful call', async () => {
  const db = createDb(':memory:');
  try {
    const { sessionId, leadId } = seedAttempt(db);
    const transport = mockTransport(async () => ({ sid: 'not-a-sid', status: 'queued' }));
    const provider = createTwilioCallProvider({ transport, publicBaseUrl: PUBLIC });
    await assert.rejects(placeOutboundCall(db, { sessionId, provider, cfg }), (err) => err.message === 'provider_create_ambiguous');
    assert.equal(sessionRow(db, sessionId).status, 'failed');
    assert.equal(leadRow(db, leadId).status, 'failed');
  } finally {
    db.close();
  }
});

test('a definitive rejection creates no call, releases the claim, and lets the normal retry policy apply', async () => {
  const db = createDb(':memory:');
  try {
    const { sessionId, leadId } = seedAttempt(db);
    const transport = mockTransport(async () => {
      throw new HttpError(400, 'invalid_number', { retryable: false });
    });
    const provider = createTwilioCallProvider({ transport, publicBaseUrl: PUBLIC });
    await assert.rejects(placeOutboundCall(db, { sessionId, provider, cfg }), (err) => err.message === 'provider_start_failed');
    const row = sessionRow(db, sessionId);
    assert.equal(row.status, 'failed');
    assert.equal(row.provider_call_sid, '', 'claim released');
    assert.equal(leadRow(db, leadId).status, 'queued', 'definitive failure is retryable under campaign policy');
  } finally {
    db.close();
  }
});

// ---- placement: eligibility is revalidated at the point of dialing ----------------------------

test('consent revoked after the session was created blocks placement before any provider call', async () => {
  const db = createDb(':memory:');
  try {
    const { sessionId, leadId } = seedAttempt(db);
    revokeConsent(db, { phone: LEAD_PHONE, channel: 'voice', purpose: 'sales' });
    const transport = mockTransport();
    const provider = createTwilioCallProvider({ transport, publicBaseUrl: PUBLIC });
    await assert.rejects(placeOutboundCall(db, { sessionId, provider, cfg }), (err) => err.status === 409 && err.message === 'not_eligible');
    assert.equal(transport.creates.length, 0);
    assert.equal(sessionRow(db, sessionId).disconnect_reason, 'not_eligible_at_placement');
    assert.equal(leadRow(db, leadId).status, 'queued');
  } finally {
    db.close();
  }
});

test('an ineligible lead (no profile) is never placed', async () => {
  const db = createDb(':memory:');
  try {
    const { sessionId } = seedAttempt(db, { eligible: false });
    const transport = mockTransport();
    const provider = createTwilioCallProvider({ transport, publicBaseUrl: PUBLIC });
    await assert.rejects(placeOutboundCall(db, { sessionId, provider, cfg }), (err) => err.status === 409);
    assert.equal(transport.creates.length, 0);
  } finally {
    db.close();
  }
});

test('the provider adapter refuses a non-public or non-https origin at construction', () => {
  const transport = mockTransport();
  assert.throws(() => createTwilioCallProvider({ transport, publicBaseUrl: 'http://apex.example.com' }), (err) => err.message === 'invalid_url');
  assert.throws(() => createTwilioCallProvider({ transport, publicBaseUrl: 'https://localhost:3210' }), (err) => err.message === 'invalid_url');
  assert.throws(() => createTwilioCallProvider({ transport: null, publicBaseUrl: PUBLIC }), /transport required/);
});

test('placement without a configured provider fails closed', async () => {
  const db = createDb(':memory:');
  try {
    const { sessionId } = seedAttempt(db);
    await assert.rejects(placeOutboundCall(db, { sessionId, provider: null, cfg }), (err) => err.status === 503);
    assert.equal(sessionRow(db, sessionId).status, 'starting', 'nothing was claimed');
  } finally {
    db.close();
  }
});

// ---- Twilio status webhook ---------------------------------------------------------------------

function sign(url, params) {
  return createHmac('sha1', TWILIO_TOKEN).update(signatureBase(url, params)).digest('base64');
}

async function postStatus(base, params, { signature } = {}) {
  const path = '/api/voice/webhooks/twilio/status';
  const body = new URLSearchParams(params).toString();
  return raw(base, 'POST', path, {
    body,
    contentType: 'application/x-www-form-urlencoded',
    headers: { 'x-twilio-signature': signature ?? sign(`${PUBLIC}${path}`, params) },
  });
}

async function withLifecycleServer(fn) {
  const db = createDb(':memory:');
  const app = createApp(db, cfg);
  const http = app.listen(0, '127.0.0.1');
  await new Promise((r) => http.once('listening', r));
  try {
    const base = `http://127.0.0.1:${http.address().port}`;
    const seeded = seedAttempt(db);
    const transport = mockTransport();
    const provider = createTwilioCallProvider({ transport, publicBaseUrl: PUBLIC });
    await placeOutboundCall(db, { sessionId: seeded.sessionId, provider, cfg });
    return await fn({ base, db, ...seeded });
  } finally {
    http.closeAllConnections?.();
    await new Promise((r) => http.close(r));
    db.close();
  }
}

test('status webhook: invalid or unsigned requests are rejected before any state change', async () => {
  await withLifecycleServer(async ({ base, db, sessionId }) => {
    const params = { CallSid: CALL_SID, CallStatus: 'in-progress' };
    assert.equal((await postStatus(base, params, { signature: 'bad' })).status, 401);
    const unsigned = await raw(base, 'POST', '/api/voice/webhooks/twilio/status', {
      body: new URLSearchParams(params).toString(),
      contentType: 'application/x-www-form-urlencoded',
    });
    assert.equal(unsigned.status, 401);
    assert.equal(sessionRow(db, sessionId).status, 'ringing');
  });
});

test('status webhook: a valid answer advances the session once; a duplicate delivery is ignored', async () => {
  await withLifecycleServer(async ({ base, db, sessionId }) => {
    const params = { CallSid: CALL_SID, CallStatus: 'in-progress' };
    const first = await postStatus(base, params);
    assert.equal(first.status, 200);
    assert.equal(first.body.data.type, 'applied');
    assert.equal(sessionRow(db, sessionId).status, 'in_progress');
    const dup = await postStatus(base, params);
    assert.equal(dup.body.data.type, 'ignored');
    assert.equal(dup.body.data.reason, 'duplicate');
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM provider_events WHERE provider = 'twilio'").get().c, 1);
  });
});

test('status webhook: a completed call ends the session; a late replay cannot reopen it', async () => {
  await withLifecycleServer(async ({ base, db, sessionId, leadId }) => {
    await postStatus(base, { CallSid: CALL_SID, CallStatus: 'in-progress' });
    const done = await postStatus(base, { CallSid: CALL_SID, CallStatus: 'completed' });
    assert.equal(done.body.data.status, 'ended');
    assert.equal(sessionRow(db, sessionId).status, 'ended');
    const replay = await postStatus(base, { CallSid: CALL_SID, CallStatus: 'in-progress' });
    assert.equal(replay.body.data.reason, 'session_terminal');
    assert.equal(sessionRow(db, sessionId).status, 'ended', 'terminal sessions are never reopened');
    assert.equal(getVoiceSession(db, sessionId).status, 'ended');
    void leadId;
  });
});

test('status webhook: an unknown Call SID is acknowledged without changing any session', async () => {
  await withLifecycleServer(async ({ base, db, sessionId }) => {
    const other = 'CA' + 'e'.repeat(32);
    const res = await postStatus(base, { CallSid: other, CallStatus: 'in-progress' });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.reason, 'session_not_found');
    assert.equal(sessionRow(db, sessionId).status, 'ringing');
  });
});

test('race: a callback that arrives before the SID is recorded is ignored, not applied to a pending session', async () => {
  const db = createDb(':memory:');
  const app = createApp(db, cfg);
  const http = app.listen(0, '127.0.0.1');
  await new Promise((r) => http.once('listening', r));
  try {
    const base = `http://127.0.0.1:${http.address().port}`;
    const { sessionId } = seedAttempt(db);
    // Simulate the window: the claim sentinel is set but the provider SID is not yet recorded.
    db.prepare('UPDATE voice_sessions SET provider_call_sid = ? WHERE id = ?').run(sentinelFor(sessionId), sessionId);
    const res = await postStatus(base, { CallSid: CALL_SID, CallStatus: 'in-progress' });
    assert.equal(res.body.data.reason, 'session_not_found');
    assert.equal(sessionRow(db, sessionId).status, 'starting');
  } finally {
    await new Promise((r) => http.close(r));
    db.close();
  }
});

test('the status webhook is absent or refused when voice or the Twilio secret is missing', async () => {
  const db = createDb(':memory:');
  const off = createApp(db, { publicBaseUrl: PUBLIC, telephony: { webhookSecret: TWILIO_TOKEN } });
  const srv = off.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  try {
    const res = await postStatus(`http://127.0.0.1:${srv.address().port}`, { CallSid: CALL_SID, CallStatus: 'in-progress' });
    assert.equal(res.status, 404, 'voice disabled: no route');
  } finally {
    await new Promise((r) => srv.close(r));
    db.close();
  }
});

// ---- media stream binding -----------------------------------------------------------------------

function streamStart(token, callSid = CALL_SID) {
  return JSON.stringify({
    event: 'start',
    sequenceNumber: '1',
    streamSid: 'MZ' + '1'.repeat(32),
    start: { accountSid: 'AC' + '2'.repeat(32), callSid, tracks: ['inbound'], customParameters: { token } },
  });
}

async function withMediaEndpoint(validateStart, fn) {
  const db = createDb(':memory:');
  const app = createApp(db, cfg);
  const http = app.listen(0, '127.0.0.1');
  await new Promise((r) => http.once('listening', r));
  const endpoint = attachMediaStreamServer(http, { tokens: app.locals.streamTokens, idleMs: 5000, validateStart });
  try {
    return await fn({ db, tokens: app.locals.streamTokens, url: `ws://127.0.0.1:${http.address().port}${MEDIA_PATH}`, endpoint });
  } finally {
    endpoint.close();
    http.closeAllConnections?.();
    await new Promise((r) => http.close(r));
    db.close();
  }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}
function closed(ws) {
  return new Promise((resolve) => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
}

test('stream binding: with no validator configured, every stream is refused (fail closed)', async () => {
  await withMediaEndpoint(undefined, async ({ tokens, url }) => {
    const token = tokens.issue(1);
    const ws = await connect(url);
    const c = closed(ws);
    ws.send(streamStart(token));
    assert.deepEqual(await c, { code: 1008, reason: 'stale_session' });
  });
});

test('stream binding: a stream for an ended or mismatched session is refused', async () => {
  await withMediaEndpoint(
    ({ sessionId, callSid }) => sessionId === 1 && callSid === CALL_SID,
    async ({ tokens, url }) => {
      const wrongSession = await connect(url);
      const c1 = closed(wrongSession);
      wrongSession.send(streamStart(tokens.issue(2)));
      assert.equal((await c1).reason, 'stale_session');

      const wrongCallSid = await connect(url);
      const c2 = closed(wrongCallSid);
      wrongCallSid.send(streamStart(tokens.issue(1), 'CA' + 'f'.repeat(32)));
      assert.equal((await c2).reason, 'stale_session');
    }
  );
});

test('stream binding: one live stream per session; a second is refused until the first closes', async () => {
  await withMediaEndpoint(() => true, async ({ tokens, url, endpoint }) => {
    const first = await connect(url);
    first.send(streamStart(tokens.issue(7)));
    await new Promise((r) => {
      const t = setInterval(() => {
        if (endpoint.bindings() === 1) {
          clearInterval(t);
          r();
        }
      }, 2);
    });
    const second = await connect(url);
    const c = closed(second);
    second.send(streamStart(tokens.issue(7)));
    assert.equal((await c).reason, 'duplicate_binding');
    assert.equal(endpoint.bindings(), 1, 'the first binding is untouched');

    const firstClosed = closed(first);
    first.terminate();
    await firstClosed;
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(endpoint.bindings(), 0, 'binding released on close');

    const third = await connect(url);
    third.send(streamStart(tokens.issue(7)));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(endpoint.bindings(), 1, 'a new token can bind again after release');
    third.terminate();
  });
});

test('stream tokens cannot be replayed across connections', async () => {
  await withMediaEndpoint(() => true, async ({ tokens, url }) => {
    const token = tokens.issue(3);
    const a = await connect(url);
    a.send(streamStart(token));
    await new Promise((r) => setTimeout(r, 20));
    a.terminate();
    const b = await connect(url);
    const c = closed(b);
    b.send(streamStart(token));
    assert.equal((await c).reason, 'unauthorized');
  });
});

// ---- mandatory audio registry -------------------------------------------------------------------

test('mandatory audio: the default registry has no assets and every playback is refused', () => {
  assert.throws(() => EMPTY_MANDATORY_AUDIO.frames('disclosure'), (err) => err.status === 503 && err.message === 'mandatory_audio_unavailable');
  assert.deepEqual(
    EMPTY_MANDATORY_AUDIO.describe().map((d) => [d.key, d.available]),
    [['disclosure', false]]
  );
});

test('mandatory audio: invalid keys, empty or oversized asset lists, and malformed frames are rejected at load time', () => {
  const frame = Buffer.alloc(160, 0xff).toString('base64');
  assert.throws(() => createMandatoryAudioRegistry({ promo: { frames: [frame] } }), /unknown mandatory audio key/);
  assert.throws(() => createMandatoryAudioRegistry({ disclosure: { frames: [] } }), /needs 1\.\.500 frames/);
  assert.throws(() => createMandatoryAudioRegistry({ disclosure: { frames: Array(501).fill(frame) } }), /needs 1\.\.500 frames/);
  assert.throws(() => createMandatoryAudioRegistry({ disclosure: { frames: ['not base64!'] } }), /invalid frame/);
  assert.throws(() => createMandatoryAudioRegistry({ disclosure: { frames: ['A'.repeat(5000)] } }), /invalid frame/);
});

test('mandatory audio: describe() reports synthetic status and frame counts but never frame data', () => {
  const frame = Buffer.alloc(160, 0xff).toString('base64');
  const reg = createMandatoryAudioRegistry({ disclosure: { synthetic: true, label: 'fixture', frames: [frame, frame] } });
  const d = reg.describe()[0];
  assert.deepEqual(d, { key: 'disclosure', available: true, synthetic: true, frameCount: 2 });
  assert.ok(!JSON.stringify(d).includes(frame));
  assert.equal(reg.frames('disclosure').length, 2);
  assert.equal(MANDATORY_MARK, 'mandatory_audio_end');
});

test('readiness reports the missing mandatory audio as a blocker and never reports live readiness', () => {
  const report = buildReadinessReport(mergeConfig({}), {}, { dbOk: true });
  const check = report.checks.find((c) => c.id === 'mandatory_audio');
  assert.equal(check.status, 'blocker');
  assert.ok(report.blockers.includes('mandatory_audio'));
  assert.equal(report.readyForLive, false);
});

test('mid-call: consent revoked during a live call stops further speech, while end_call still ends cleanly', () => {
  const db = createDb(':memory:');
  try {
    const { sessionId, campaignId, leadId } = seedAttempt(db);
    // Use the orchestrator's own session start instead of the pre-seeded attempt row.
    db.prepare('DELETE FROM voice_sessions WHERE id = ?').run(sessionId);
    const orch = createVoiceOrchestrator(db, {
      cfg,
      mediaStreamFactory: ({ socket }) => new MediaStreamSession({ socket }),
      mandatoryAudio: syntheticDisclosureRegistry(),
    });
    const mediaSocket = { sent: [], send(m) { this.sent.push(JSON.parse(m)); }, close() {} };
    const call = orch.start({ campaignId, leadId, mediaSocket });
    call.providerEvent({ sid: call.session.providerCallSid, status: 'in_progress', eventId: 'live-1' });
    playDisclosure(call);
    assert.equal(call.state, 'active');

    const saysBefore = db.prepare("SELECT COUNT(*) AS c FROM voice_events WHERE session_id = ? AND event_type = 'ai:say'").get(call.sessionId).c;
    revokeConsent(db, { phone: LEAD_PHONE, channel: 'voice', purpose: 'sales' });
    const spoken = call.tool({ name: 'approved_response', arguments: { lineKey: 'reprompt' } });
    assert.equal(spoken.ok, false);
    assert.equal(spoken.rejected, 'eligibility_revoked');
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM voice_events WHERE session_id = ? AND event_type = 'ai:say'").get(call.sessionId).c, saysBefore, 'no new spoken line after revocation');

    const hangup = call.tool({ name: 'end_call', arguments: {} });
    assert.equal(hangup.end, true, 'a terminal action is still permitted');
    assert.equal(call.state, 'ended');
  } finally {
    db.close();
  }
});
test('no test in this file reached a non-loopback host (the guard would have thrown)', () => {
  assert.throws(() => globalThis.fetch('https://api.twilio.com/2010-04-01/Accounts/x'), /network access blocked/);
});
