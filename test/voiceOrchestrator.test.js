import test from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/db/db.js';
import { mergeConfig } from '../src/app.js';
import { createVoiceOrchestrator } from '../src/services/voiceOrchestrator.js';
import { startVoiceSession, getVoiceSession } from '../src/services/voiceSessions.js';
import { upsertComplianceProfile, setConsent, revokeConsent } from '../src/services/complianceProfile.js';
import { MediaStreamSession } from '../src/providers/twilioMediaStream.js';
import { RealtimeSession } from '../src/providers/openaiRealtime.js';
import { withServer, api } from '../test-support/helpers.js';
import { syntheticDisclosureRegistry, playDisclosure } from '../test-support/orchestrationFixtures.js';

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

// Seed a running campaign with one campaign lead already in 'dialing' state.
function seedDialing(db) {
  db.prepare(
    `INSERT INTO leads (name, phone, call_type, timezone, consent_status, consent_evidence, consent_source, consent_date, status)
     VALUES ('Orch Lead', '+15550123456', 'sales', ?, 'recorded', 'signed form', 'web-form', '2026-01-01', 'pending')`
  ).run(zoneForLocalHour(12));
  const leadId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  db.prepare("INSERT INTO campaigns (name, status) VALUES ('Orch Campaign', 'running')").run();
  const campaignId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  db.prepare("INSERT INTO campaign_leads (campaign_id, lead_id, status) VALUES (?, ?, 'dialing')").run(campaignId, leadId);
  return { campaignId, leadId };
}

function makeEligible(db) {
  const ids = seedDialing(db);
  upsertComplianceProfile(db, ids.campaignId, PROFILE);
  setConsent(db, CONSENT);
  return ids;
}

test('the orchestrator always enforces the fail-closed gate (no profile -> refused)', () => {
  const db = createDb(':memory:');
  try {
    const { campaignId, leadId } = seedDialing(db);
    const orch = createVoiceOrchestrator(db, { cfg: mergeConfig({}) });
    assert.throws(
      () => orch.start({ campaignId, leadId }),
      (err) => err.status === 409 && err.message === 'not_eligible'
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM voice_sessions').get().c, 0);
  } finally {
    db.close();
  }
});

test('startVoiceSession itself refuses when the gate is on and the profile is missing', () => {
  const db = createDb(':memory:');
  try {
    const { campaignId, leadId } = seedDialing(db);
    assert.throws(
      () => startVoiceSession(db, { campaignId, leadId, cfg: mergeConfig({}) }),
      (err) => err.status === 409 && err.message === 'not_eligible'
    );
  } finally {
    db.close();
  }
});

test('revoking consent makes the gate block immediately', () => {
  const db = createDb(':memory:');
  try {
    const { campaignId, leadId } = makeEligible(db);
    const orch = createVoiceOrchestrator(db, { cfg: mergeConfig({}) });
    assert.equal(orch.preflight({ campaignId, leadId }).allowed, true);
    revokeConsent(db, { phone: CONSENT.phone, channel: 'voice', purpose: 'sales' });
    const after = orch.preflight({ campaignId, leadId });
    assert.equal(after.allowed, false);
    assert.ok(after.reasons.some((r) => r.code === 'consent_missing'));
  } finally {
    db.close();
  }
});

test('an offline outbound call runs end-to-end with injected, network-free transports', () => {
  const db = createDb(':memory:');
  try {
    const { campaignId, leadId } = makeEligible(db);
    const cfg = mergeConfig({});
    const mediaSocket = fakeSocket();
    const realtimeSocket = fakeSocket();
    const orch = createVoiceOrchestrator(db, {
      cfg,
      mediaStreamFactory: ({ socket }) => new MediaStreamSession({ socket }),
      realtimeFactory: ({ socket, sessionConfig }) => new RealtimeSession({ socket, sessionConfig }),
      mandatoryAudio: syntheticDisclosureRegistry(),
    });

    const call = orch.start({ campaignId, leadId, mediaSocket, realtimeSocket });
    assert.equal(call.session.status, 'ringing');
    assert.ok(call.session.providerCallSid.startsWith('FV'));

    // Provider confirms answer -> media opens and the synthetic disclosure is played.
    // The AI session must NOT start yet.
    const answered = call.providerEvent({
      sid: call.session.providerCallSid,
      status: 'in_progress',
      eventId: 'e-answer',
    });
    assert.equal(answered.status, 'in_progress');
    assert.equal(call.media.state, 'streaming');
    assert.equal(call.disclosure.state, 'awaiting_mark');
    assert.ok(mediaSocket.sent.some((m) => m.event === 'media'), 'disclosure frames were sent');
    assert.equal(mediaSocket.sent.at(-1).event, 'mark');
    assert.equal(realtimeSocket.sent.length, 0, 'no model session before the disclosure mark');

    // Carrier echoes the disclosure mark -> AI session opens.
    playDisclosure(call);
    assert.equal(call.disclosure.state, 'played');
    assert.equal(call.state, 'active');
    // session.update + response.create were written to the realtime socket.
    assert.equal(realtimeSocket.sent[0].type, 'session.update');
    assert.equal(realtimeSocket.sent[1].type, 'response.create');

    // Inbound caller audio is validated and forwarded to the model.
    const before = realtimeSocket.sent.length;
    const mediaMsg = call.onMedia({
      event: 'media',
      streamSid: `SS${call.sessionId}`,
      media: { payload: 'AAAA' },
    });
    assert.equal(mediaMsg.type, 'media');
    assert.ok(realtimeSocket.sent.length > before);
    assert.equal(realtimeSocket.sent.at(-1).type, 'input_audio_buffer.append');

    // Model audio is written back to the caller.
    call.onRealtime({ type: 'response.output_audio.delta', delta: 'BBBB' });
    const last = mediaSocket.sent.at(-1);
    assert.equal(last.event, 'media');
    assert.equal(last.media.payload, 'BBBB');

    // Barge-in clears buffered playback.
    call.onRealtime({ type: 'input_audio_buffer.speech_started' });
    assert.equal(mediaSocket.sent.at(-1).event, 'clear');

    // A validated terminal tool call ends the call and tears down the streams.
    const tool = call.onRealtime({
      type: 'response.function_call_arguments.done',
      call_id: 'call-1',
      name: 'end_call',
      arguments: '{}',
    });
    assert.equal(tool.end, true);
    assert.equal(tool.outcome, 'unanswered');
    assert.equal(call.state, 'ended');
    assert.equal(mediaSocket.closed, true);
    assert.equal(realtimeSocket.closed, true);

    const stored = getVoiceSession(db, call.sessionId);
    assert.equal(stored.status, 'ended');
  } finally {
    db.close();
  }
});

test('a disallowed realtime tool call is rejected without touching the session outcome', () => {
  const db = createDb(':memory:');
  try {
    const { campaignId, leadId } = makeEligible(db);
    const cfg = mergeConfig({});
    const orch = createVoiceOrchestrator(db, {
      cfg,
      mediaStreamFactory: ({ socket }) => new MediaStreamSession({ socket }),
      realtimeFactory: ({ socket, sessionConfig }) => new RealtimeSession({ socket, sessionConfig }),
      mandatoryAudio: syntheticDisclosureRegistry(),
    });
    const call = orch.start({ campaignId, leadId, mediaSocket: fakeSocket(), realtimeSocket: fakeSocket() });
    call.providerEvent({ sid: call.session.providerCallSid, status: 'in_progress', eventId: 'e1' });
    playDisclosure(call);

    const rejected = call.onRealtime({
      type: 'response.function_call_arguments.done',
      call_id: 'c1',
      name: 'run_shell',
      arguments: '{}',
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.rejected, 'tool_not_allowed');
    assert.equal(getVoiceSession(db, call.sessionId).status, 'in_progress');
  } finally {
    db.close();
  }
});

test('emergencyStop halts campaigns and ends live sessions', () => {
  const db = createDb(':memory:');
  try {
    const { campaignId, leadId } = makeEligible(db);
    const orch = createVoiceOrchestrator(db, { cfg: mergeConfig({}) });
    const call = orch.start({ campaignId, leadId });
    assert.equal(call.session.status, 'ringing');

    const result = orch.emergencyStop('operator');
    assert.equal(result.campaigns, 1);
    assert.equal(result.voiceSessions, 1);
    assert.equal(getVoiceSession(db, call.sessionId).status, 'ended');
    assert.equal(db.prepare('SELECT status FROM campaigns WHERE id = ?').get(campaignId).status, 'stopped');
  } finally {
    db.close();
  }
});

test('HTTP: a campaign tick is blocked by the gate until profile + consent are configured', async () => {
  await withServer(async (base) => {
    const campaign = (await api(base, 'POST', '/api/campaigns', { name: 'Gate Campaign' })).body.data;
    const lead = (
      await api(base, 'POST', '/api/leads', {
        name: 'Gate Lead',
        phone: '+15550129876',
        callType: 'sales',
        timezone: zoneForLocalHour(12),
        consent: { status: 'recorded', evidence: 'signed', source: 'web', date: '2026-01-01' },
      })
    ).body.data;
    await api(base, 'POST', `/api/campaigns/${campaign.id}/queue`, { leadIds: [lead.id] });
    await api(base, 'POST', `/api/campaigns/${campaign.id}/start`);

    const blocked = await api(base, 'POST', `/api/campaigns/${campaign.id}/tick`);
    assert.equal(blocked.body.data.claimed, null);
    assert.equal(blocked.body.data.reason, 'not_eligible');

    const preview = await api(base, 'GET', `/api/compliance/campaigns/${campaign.id}/eligibility?leadId=${lead.id}`);
    assert.equal(preview.body.data.allowed, false);
    assert.ok(preview.body.data.reasons.some((r) => r.code === 'compliance_profile_missing'));

    await api(base, 'PUT', `/api/compliance/campaigns/${campaign.id}`, PROFILE);
    await api(base, 'POST', '/api/compliance/consent', { ...CONSENT, phone: '+15550129876' });

    const allowed = await api(base, 'POST', `/api/campaigns/${campaign.id}/tick`);
    assert.equal(allowed.body.data.claimed.leadId, lead.id);
  });
});

test('HTTP: revoking consent through the API immediately blocks a later call', async () => {
  await withServer(async (base) => {
    const campaign = (await api(base, 'POST', '/api/campaigns', { name: 'Revoke Campaign' })).body.data;
    const lead = (
      await api(base, 'POST', '/api/leads', {
        name: 'Revoke Lead',
        phone: '+15550128888',
        callType: 'sales',
        timezone: zoneForLocalHour(12),
        consent: { status: 'recorded', evidence: 'signed', source: 'web', date: '2026-01-01' },
      })
    ).body.data;
    await api(base, 'POST', `/api/campaigns/${campaign.id}/queue`, { leadIds: [lead.id] });
    await api(base, 'POST', `/api/campaigns/${campaign.id}/start`);
    await api(base, 'PUT', `/api/compliance/campaigns/${campaign.id}`, PROFILE);
    await api(base, 'POST', '/api/compliance/consent', { ...CONSENT, phone: '+15550128888' });

    const ok = await api(base, 'GET', `/api/compliance/campaigns/${campaign.id}/eligibility?leadId=${lead.id}`);
    assert.equal(ok.body.data.allowed, true);
    assert.equal(ok.body.data.recording.allowed, false);

    const revoked = await api(base, 'POST', '/api/compliance/consent/revoke', {
      phone: '+15550128888',
      channel: 'voice',
      purpose: 'sales',
    });
    assert.equal(revoked.body.data.status, 'revoked');

    const after = await api(base, 'GET', `/api/compliance/campaigns/${campaign.id}/eligibility?leadId=${lead.id}`);
    assert.equal(after.body.data.allowed, false);
    assert.ok(after.body.data.reasons.some((r) => r.code === 'consent_missing'));
  });
});

test('the orchestrator module contains no static network access', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/services/voiceOrchestrator.js', import.meta.url), 'utf8');
  const forbidden = ['fetch(', 'http.request', 'https.request', 'WebSocket', 'net.connect', 'axios', 'require('];
  for (const token of forbidden) {
    assert.ok(!src.includes(token), `orchestrator must not statically reference ${token}`);
  }
});
