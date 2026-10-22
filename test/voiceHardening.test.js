import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createDb } from '../src/db/db.js';
import { mergeConfig } from '../src/app.js';
import { loadConfig, effectiveRequireComplianceProfile } from '../src/config.js';
import { executeAiToolCall } from '../src/services/aiToolExecutor.js';
import { syntheticDisclosureRegistry, playDisclosure } from '../test-support/orchestrationFixtures.js';
import { createVoiceOrchestrator } from '../src/services/voiceOrchestrator.js';
import { getVoiceSession } from '../src/services/voiceSessions.js';
import { upsertComplianceProfile, setConsent } from '../src/services/complianceProfile.js';
import { MediaStreamSession } from '../src/providers/twilioMediaStream.js';
import { RealtimeSession } from '../src/providers/openaiRealtime.js';
import { voiceSignatureBase } from '../src/providers/fakeVoice.js';
import { withServer as withServerRaw, api, raw } from '../test-support/helpers.js';

// All tests here are offline: the fake provider only, no sockets, no network.
const SECRET = 'test-voice-webhook-secret';
const WEBHOOK_PATH = '/api/voice/webhooks/fake';
const enabled = { voice: { enabled: true, webhookSecret: SECRET } };
const withServer = (fn, db, cfg = {}) =>
  withServerRaw(fn, db, { ...cfg, compliance: { ...(cfg.compliance ?? {}), requireComplianceProfile: false } });

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

function fakeSocket() {
  return {
    sent: [],
    closed: false,
    send(msg) {
      this.sent.push(JSON.parse(msg));
    },
    close() {
      this.closed = true;
    },
  };
}

// ---- config: compliance gate and caller ID --------------------------------

test('the compliance gate can only be relaxed in demo + fake-provider simulation', () => {
  assert.equal(effectiveRequireComplianceProfile({ requested: false, demoMode: true, provider: 'fake' }), false);
  assert.equal(effectiveRequireComplianceProfile({ requested: false, demoMode: false, provider: 'fake' }), true);
  assert.equal(effectiveRequireComplianceProfile({ requested: false, demoMode: true, provider: 'twilio' }), true);
  assert.equal(effectiveRequireComplianceProfile({ requested: false, demoMode: true, provider: 'fake', liveEnabled: true }), true);
  assert.equal(effectiveRequireComplianceProfile({ requested: true, demoMode: false, provider: 'fake' }), true);
});

test('env cannot disable the compliance gate outside demo mode', () => {
  const live = loadConfig({ APEX_DEMO_MODE: 'false', APEX_REQUIRE_COMPLIANCE_PROFILE: 'false' });
  assert.equal(live.compliance.requireComplianceProfile, true);
  const demo = loadConfig({ APEX_DEMO_MODE: 'true', APEX_REQUIRE_COMPLIANCE_PROFILE: 'false' });
  assert.equal(demo.compliance.requireComplianceProfile, false, 'simulator may be relaxed in demo mode');
  assert.equal(loadConfig({}).compliance.requireComplianceProfile, true, 'default is fail-closed');
});

test('mergeConfig re-applies the gate after overrides', () => {
  assert.equal(mergeConfig({ demoMode: false, compliance: { requireComplianceProfile: false } }).compliance.requireComplianceProfile, true);
  assert.equal(mergeConfig({ compliance: { requireComplianceProfile: false } }).compliance.requireComplianceProfile, false);
  assert.equal(mergeConfig({ voice: { provider: 'twilio' }, compliance: { requireComplianceProfile: false } }).compliance.requireComplianceProfile, true);
});

test('caller ID (fromNumber) is separate from the transfer destination', () => {
  const cfg = loadConfig({ APEX_VOICE_FROM_NUMBER: ' +15550001111 ', APEX_VOICE_TRANSFER_NUMBER: '+15559990000' });
  assert.equal(cfg.voice.fromNumber, '+15550001111');
  assert.equal(cfg.voice.transferNumber, '+15559990000');
  assert.equal(loadConfig({}).voice.fromNumber, '');
  assert.equal(loadConfig({}).voice.liveEnabled, false);
  assert.equal(loadConfig({ APEX_VOICE_ENABLED: 'true' }).voice.liveEnabled, false);
});

// ---- AI tool executor: answered-state and audit ---------------------------

function seedSession(db, status = 'in_progress') {
  db.prepare("INSERT INTO leads (name, phone, timezone, status) VALUES ('Lead', '+15550123456', 'Etc/GMT+0', 'pending')").run();
  const leadId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  db.prepare("INSERT INTO campaigns (name, status) VALUES ('C', 'running')").run();
  const campaignId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  db.prepare("INSERT INTO campaign_leads (campaign_id, lead_id, status) VALUES (?, ?, 'dialing')").run(campaignId, leadId);
  db.prepare("INSERT INTO calls (lead_id, direction, status, call_type, started_at) VALUES (?, 'outbound', 'ringing', 'sales', datetime('now'))").run(leadId);
  const callId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  db.prepare(
    "INSERT INTO voice_sessions (campaign_id, lead_id, call_id, provider, status, phase, started_at) VALUES (?, ?, ?, 'fake', ?, 'greeting', datetime('now'))"
  ).run(campaignId, leadId, callId, status);
  return db.prepare('SELECT last_insert_rowid() AS id').get().id;
}

test('no AI tool may act before the provider confirms the call was answered', () => {
  const db = createDb(':memory:');
  try {
    const sessionId = seedSession(db, 'ringing');
    const cfg = mergeConfig({});
    const say = executeAiToolCall(db, { id: sessionId }, { name: 'approved_response', arguments: { lineKey: 'greeting' } }, { cfg });
    assert.equal(say.ok, false);
    assert.equal(say.rejected, 'call_not_answered');
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM voice_events WHERE session_id = ? AND event_type = 'ai:say'").get(sessionId).c, 0);
    assert.equal(db.prepare('SELECT status FROM voice_sessions WHERE id = ?').get(sessionId).status, 'ringing');
  } finally {
    db.close();
  }
});

test('successful non-terminal AI actions are written to the audit log', () => {
  const db = createDb(':memory:');
  try {
    const sessionId = seedSession(db);
    executeAiToolCall(db, { id: sessionId }, { name: 'approved_response', arguments: { lineKey: 'reprompt' } }, { cfg: mergeConfig({}) });
    const row = db.prepare("SELECT actor, action FROM audit_log WHERE action = 'ai_tool' ORDER BY id DESC LIMIT 1").get();
    assert.ok(row, 'ai_tool audit row written');
    assert.equal(row.actor, 'ai');
  } finally {
    db.close();
  }
});

// ---- orchestrator fail-safe behavior --------------------------------------

function seedDialing(db) {
  db.prepare(
    `INSERT INTO leads (name, phone, call_type, timezone, consent_status, consent_evidence, consent_source, consent_date, status)
     VALUES ('Orch Lead', '+15550123456', 'sales', ?, 'recorded', 'signed form', 'web-form', '2026-01-01', 'pending')`
  ).run(zoneForLocalHour(12));
  const leadId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  db.prepare("INSERT INTO campaigns (name, status) VALUES ('Orch Campaign', 'running')").run();
  const campaignId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  db.prepare("INSERT INTO campaign_leads (campaign_id, lead_id, status) VALUES (?, ?, 'dialing')").run(campaignId, leadId);
  upsertComplianceProfile(db, campaignId, PROFILE);
  setConsent(db, CONSENT);
  return { campaignId, leadId };
}

function orchestrator(db, cfg = mergeConfig({})) {
  return createVoiceOrchestrator(db, {
    cfg,
    mediaStreamFactory: ({ socket }) => new MediaStreamSession({ socket }),
    realtimeFactory: ({ socket, sessionConfig }) => new RealtimeSession({ socket, sessionConfig }),
    mandatoryAudio: syntheticDisclosureRegistry(),
  });
}

test('a realtime provider_error ends the call safely and later events are refused', () => {
  const db = createDb(':memory:');
  try {
    const { campaignId, leadId } = seedDialing(db);
    const call = orchestrator(db).start({ campaignId, leadId, mediaSocket: fakeSocket(), realtimeSocket: fakeSocket() });
    call.providerEvent({ sid: call.session.providerCallSid, status: 'in_progress', eventId: 'a1' });
    playDisclosure(call);

    const result = call.onRealtime({ type: 'error', error: { code: 'server_error', message: 'boom' } });
    assert.equal(result.ended, true);
    assert.equal(call.state, 'ended');
    assert.equal(getVoiceSession(db, call.sessionId).status, 'ended');
    assert.equal(getVoiceSession(db, call.sessionId).outcome, 'unanswered');

    assert.throws(
      () => call.onRealtime({ type: 'response.output_audio.delta', delta: 'AAAA' }),
      (err) => err.status === 409 && err.message === 'session_ended'
    );
    assert.throws(
      () => call.onMedia({ event: 'media', streamSid: 'SS1', media: { payload: 'AAAA' } }),
      (err) => err.status === 409 && err.message === 'session_ended'
    );
  } finally {
    db.close();
  }
});

test('a model session that cannot open ends the call instead of leaving a silent live line', () => {
  const db = createDb(':memory:');
  try {
    const { campaignId, leadId } = seedDialing(db);
    // No realtime socket injected: the model leg cannot open once the disclosure plays.
    const call = orchestrator(db).start({ campaignId, leadId, mediaSocket: fakeSocket(), realtimeSocket: null });
    const result = call.providerEvent({ sid: call.session.providerCallSid, status: 'in_progress', eventId: 'a2' });
    assert.equal(result.type, 'applied');
    assert.equal(result.streamError, undefined, 'the disclosure leg opens first');
    assert.equal(call.disclosure.state, 'awaiting_mark');
    const after = playDisclosure(call);
    assert.equal(after.type, 'ended');
    assert.equal(after.reason, 'realtime_socket_unavailable');
    assert.equal(call.state, 'ended');
    assert.equal(getVoiceSession(db, call.sessionId).status, 'ended');
    assert.equal(db.prepare('SELECT status FROM campaign_leads WHERE lead_id = ?').get(leadId).status, 'queued');
  } finally {
    db.close();
  }
});

test('no approved disclosure audio: the call ends before any AI session exists', () => {
  const db = createDb(':memory:');
  try {
    const { campaignId, leadId } = seedDialing(db);
    const realtimeSocket = fakeSocket();
    const cfg = mergeConfig({});
    const orch = createVoiceOrchestrator(db, {
      cfg,
      mediaStreamFactory: ({ socket }) => new MediaStreamSession({ socket }),
      realtimeFactory: ({ socket, sessionConfig }) => new RealtimeSession({ socket, sessionConfig }),
      // default: EMPTY mandatory audio registry
    });
    const call = orch.start({ campaignId, leadId, mediaSocket: fakeSocket(), realtimeSocket });
    const result = call.providerEvent({ sid: call.session.providerCallSid, status: 'in_progress', eventId: 'd1' });
    assert.equal(result.streamError, 'mandatory_audio_unavailable');
    assert.equal(call.state, 'ended');
    assert.equal(realtimeSocket.sent.length, 0, 'the model was never started');
    assert.equal(getVoiceSession(db, call.sessionId).disconnectReason, 'disclosure_unavailable');
  } finally {
    db.close();
  }
});

test('a missing disclosure mark times out and ends the call; the AI never starts', async () => {
  const db = createDb(':memory:');
  try {
    const { campaignId, leadId } = seedDialing(db);
    const realtimeSocket = fakeSocket();
    const cfg = mergeConfig({});
    const orch = createVoiceOrchestrator(db, {
      cfg,
      mediaStreamFactory: ({ socket }) => new MediaStreamSession({ socket }),
      realtimeFactory: ({ socket, sessionConfig }) => new RealtimeSession({ socket, sessionConfig }),
      mandatoryAudio: syntheticDisclosureRegistry(),
      markTimeoutMs: 20,
    });
    const call = orch.start({ campaignId, leadId, mediaSocket: fakeSocket(), realtimeSocket });
    call.providerEvent({ sid: call.session.providerCallSid, status: 'in_progress', eventId: 'd2' });
    await new Promise((r) => setTimeout(r, 40));
    const turn = call.callerTurn({ type: 'speech', text: 'hello?' });
    assert.equal(turn.agent.reason, 'disclosure_timeout', 'expired before any turn is processed');
    assert.equal(call.state, 'ended');
    assert.equal(realtimeSocket.sent.length, 0);
  } finally {
    db.close();
  }
});

test('before the disclosure mark, caller turns, audio, and model tools are all refused', () => {
  const db = createDb(':memory:');
  try {
    const { campaignId, leadId } = seedDialing(db);
    const realtimeSocket = fakeSocket();
    const orch = orchestrator(db);
    const call = orch.start({ campaignId, leadId, mediaSocket: fakeSocket(), realtimeSocket });
    call.providerEvent({ sid: call.session.providerCallSid, status: 'in_progress', eventId: 'd3' });
    assert.throws(() => call.callerTurn({ type: 'speech', text: 'yes' }), (e) => e.message === 'disclosure_not_played');
    assert.throws(() => call.tool({ name: 'end_call', arguments: {} }), (e) => e.message === 'disclosure_not_played');
    const audio = call.onRealtime({ type: 'session.output_audio.delta', delta: 'AAAA' }).reason;
    assert.equal(audio, undefined);
    assert.equal(call.state, 'active');
    assert.equal(call.disclosure.state, 'awaiting_mark');
  } finally {
    db.close();
  }
});
test('the hard call-duration cap ends a call on the next inbound event', () => {
  const db = createDb(':memory:');
  try {
    const { campaignId, leadId } = seedDialing(db);
    const cfg = mergeConfig({ voice: { maxCallSeconds: 1 } });
    const call = orchestrator(db, cfg).start({ campaignId, leadId, mediaSocket: fakeSocket(), realtimeSocket: fakeSocket() });
    call.providerEvent({ sid: call.session.providerCallSid, status: 'in_progress', eventId: 'a3' });
    call.startedAt = Date.now() - 5000;

    const turn = call.callerTurn({ type: 'speech', text: 'hello?' });
    assert.equal(turn.agent.ended, true);
    assert.equal(turn.agent.reason, 'max_call_duration');
    assert.equal(getVoiceSession(db, call.sessionId).status, 'ended');
  } finally {
    db.close();
  }
});

// ---- HTTP: tool execution route -------------------------------------------

function sign(url, params) {
  return createHmac('sha256', SECRET).update(voiceSignatureBase(url, params)).digest('base64');
}

async function webhook(base, params) {
  const url = `${base}${WEBHOOK_PATH}`;
  return raw(base, 'POST', WEBHOOK_PATH, {
    body: new URLSearchParams(params).toString(),
    contentType: 'application/x-www-form-urlencoded',
    headers: { 'x-apex-voice-signature': sign(url, params) },
  });
}

async function answeredSession(base, db) {
  const campaign = (await api(base, 'POST', '/api/campaigns', { name: 'Tool Campaign', maxAttempts: 3, retryDelayMinutes: 0 })).body.data;
  const lead = (
    await api(base, 'POST', '/api/leads', {
      name: 'Tool Lead',
      phone: '+15550127777',
      callType: 'sales',
      timezone: zoneForLocalHour(12),
      consent: { status: 'recorded', evidence: 'signed', source: 'web', date: '2026-01-01' },
    })
  ).body.data;
  await api(base, 'POST', `/api/campaigns/${campaign.id}/queue`, { leadIds: [lead.id] });
  await api(base, 'POST', `/api/campaigns/${campaign.id}/start`);
  await api(base, 'POST', `/api/campaigns/${campaign.id}/tick`);
  const started = await api(base, 'POST', '/api/voice/sessions', { campaignId: campaign.id, leadId: lead.id });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const session = started.body.data;
  await webhook(base, { sid: session.providerCallSid, status: 'answered' });
  return { session, lead, campaign };
}

test('POST /api/voice/sessions/:id/tools executes an allowed tool on an answered call', async () => {
  await withServer(
    async (base, db) => {
      const { session } = await answeredSession(base, db);
      const res = await api(base, 'POST', `/api/voice/sessions/${session.id}/tools`, {
        name: 'approved_response',
        callId: 'call-1',
        arguments: { lineKey: 'reprompt' },
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.ok, true);
      assert.equal(res.body.data.say.length, 1);
      // The model cannot supply free text: extra keys are a validation error.
      const extra = await api(base, 'POST', `/api/voice/sessions/${session.id}/tools`, {
        name: 'approved_response',
        arguments: { lineKey: 'reprompt', text: 'free text' },
      });
      assert.equal(extra.status, 400);
      assert.equal(extra.body.error, 'invalid_tool_arguments');
    },
    undefined,
    enabled
  );
});

test('tool route rejects unknown tools, bad arguments and unauthenticated callers', async () => {
  await withServer(
    async (base, db) => {
      const { session } = await answeredSession(base, db);
      const unknown = await api(base, 'POST', `/api/voice/sessions/${session.id}/tools`, { name: 'wire_money', arguments: {} });
      assert.equal(unknown.status, 400);
      assert.equal(unknown.body.error, 'tool_not_allowed');

      const badArgs = await api(base, 'POST', `/api/voice/sessions/${session.id}/tools`, {
        name: 'opt_out',
        arguments: { confirm: false },
      });
      assert.equal(badArgs.status, 400);
      assert.equal(badArgs.body.error, 'invalid_tool_arguments');

      const anon = await raw(base, 'POST', `/api/voice/sessions/${session.id}/tools`, {
        body: { name: 'end_call', arguments: {} },
      });
      assert.equal(anon.status, 401);
      assert.equal(db.prepare('SELECT status FROM voice_sessions WHERE id = ?').get(session.id).status, 'in_progress');
    },
    undefined,
    enabled
  );
});

test('an opt_out tool call through the route suppresses the lead and finalizes the session', async () => {
  await withServer(
    async (base, db) => {
      const { session, lead } = await answeredSession(base, db);
      const res = await api(base, 'POST', `/api/voice/sessions/${session.id}/tools`, {
        name: 'opt_out',
        callId: 'call-optout',
        arguments: { confirm: true, reason: 'caller asked to stop' },
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.outcome, 'opted_out');
      assert.equal(db.prepare('SELECT status FROM voice_sessions WHERE id = ?').get(session.id).status, 'ended');
      assert.equal(db.prepare('SELECT status FROM leads WHERE id = ?').get(lead.id).status, 'dnc');

      const after = await api(base, 'POST', `/api/voice/sessions/${session.id}/tools`, { name: 'end_call', arguments: {} });
      assert.equal(after.body.data.rejected, 'session_ended');
    },
    undefined,
    enabled
  );
});

test('a call past its duration cap cannot run more model actions through the route', async () => {
  await withServer(
    async (base, db) => {
      const { session } = await answeredSession(base, db);
      db.prepare("UPDATE voice_sessions SET started_at = datetime('now', '-2 hours') WHERE id = ?").run(session.id);
      const res = await api(base, 'POST', `/api/voice/sessions/${session.id}/tools`, {
        name: 'approved_response',
        arguments: { lineKey: 'reprompt' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.rejected, 'call_duration_exceeded');
    },
    undefined,
    enabled
  );
});

test('the tool route is absent while the voice subsystem is disabled (demo default)', async () => {
  await withServer(
    async (base) => {
      const res = await api(base, 'POST', '/api/voice/sessions/1/tools', { name: 'end_call', arguments: {} });
      assert.equal(res.status, 404);
    },
    undefined,
    undefined
  );
});
