import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { withServer as withServerRaw, api, raw } from '../test-support/helpers.js';
import { voiceSignatureBase } from '../src/providers/fakeVoice.js';
import { phoneKey } from '../src/services/leads.js';

// Offline simulated-voice suites opt out of the fail-closed live compliance gate
// (covered separately in test/dialerEligibility.test.js + test/voiceOrchestrator.test.js).
const withServer = (fn, db, cfg = {}) =>
  withServerRaw(fn, db, { ...cfg, compliance: { ...(cfg.compliance ?? {}), requireComplianceProfile: false } });

const SECRET = 'test-voice-webhook-secret';
const WEBHOOK_PATH = '/api/voice/webhooks/fake';
const enabled = { voice: { enabled: true, webhookSecret: SECRET } };
const noSecret = { voice: { enabled: true, webhookSecret: '' } };

function zoneForLocalHour(hour) {
  const utcHour = new Date().getUTCHours();
  let offset = hour - utcHour;
  if (offset > 14) offset -= 24;
  if (offset < -12) offset += 24;
  return offset >= 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
}

let phoneSeq = 0;
function nextPhone() {
  phoneSeq += 1;
  return `+1 555 07${String(1000 + phoneSeq).slice(-4)}`;
}

async function seedLead(base, { phone = nextPhone() } = {}) {
  const res = await api(base, 'POST', '/api/leads', {
    name: `Voice Lead ${phoneSeq}`,
    phone,
    callType: 'sales',
    timezone: zoneForLocalHour(12),
    consent: { status: 'recorded', evidence: 'signed form', source: 'web-form', date: '2026-08-01' },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
}

async function newCampaign(base, body = {}) {
  const res = await api(base, 'POST', '/api/campaigns', { name: 'Voice Campaign', ...body });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
}

// Drive a lead all the way to `dialing` and return the campaign + lead.
async function dialingLead(base, db, { campaign = {}, leads = 1 } = {}) {
  const c = await newCampaign(base, { maxAttempts: 3, retryDelayMinutes: 0, concurrencyLimit: Math.max(1, leads), ...campaign });
  const seeded = [];
  for (let i = 0; i < leads; i += 1) seeded.push(await seedLead(base));
  await api(base, 'POST', `/api/campaigns/${c.id}/queue`, { leadIds: seeded.map((l) => l.id) });
  await api(base, 'POST', `/api/campaigns/${c.id}/start`);
  return { campaign: c, leads: seeded };
}

async function startSession(base, campaignId, leadId, expect = 201) {
  const res = await api(base, 'POST', '/api/voice/sessions', { campaignId, leadId });
  assert.equal(res.status, expect, JSON.stringify(res.body));
  return res.body.data;
}

function sign(url, params, secret = SECRET) {
  return createHmac('sha256', secret).update(voiceSignatureBase(url, params)).digest('base64');
}

async function webhook(base, params, { secret = SECRET, signature, omitSignature = false } = {}) {
  const url = `${base}${WEBHOOK_PATH}`;
  const body = new URLSearchParams(params).toString();
  const headers = {};
  if (!omitSignature) headers['x-apex-voice-signature'] = signature ?? sign(url, params, secret);
  return raw(base, 'POST', WEBHOOK_PATH, { body, contentType: 'application/x-www-form-urlencoded', headers });
}

test('a session starts, rings, is greeted on answer, and ends on a provider callback', async () => {
  await withServer(
    async (base, db) => {
      const { campaign, leads } = await dialingLead(base, db);
      await api(base, 'POST', `/api/campaigns/${campaign.id}/tick`);
      const session = await startSession(base, campaign.id, leads[0].id);
      assert.equal(session.status, 'ringing');
      assert.equal(session.phase, 'greeting');
      assert.ok(session.providerCallSid.startsWith('FV'));
      assert.ok(session.callId);

      const answered = await webhook(base, { sid: session.providerCallSid, status: 'answered' });
      assert.equal(answered.status, 200);
      assert.equal(answered.body.data.type, 'applied');
      assert.equal(answered.body.data.status, 'in_progress');

      let stored = db.prepare('SELECT status, phase, disclosure_played FROM voice_sessions WHERE id = ?').get(session.id);
      assert.equal(stored.status, 'in_progress');
      assert.equal(stored.phase, 'awaiting');
      assert.equal(stored.disclosure_played, 1);

      const completed = await webhook(base, { sid: session.providerCallSid, status: 'completed' });
      assert.equal(completed.body.data.status, 'ended');
      stored = db.prepare('SELECT status, ended_at FROM voice_sessions WHERE id = ?').get(session.id);
      assert.equal(stored.status, 'ended');
      assert.ok(stored.ended_at);

      const call = db.prepare('SELECT status FROM calls WHERE id = ?').get(session.callId);
      assert.equal(call.status, 'completed');
    },
    undefined,
    enabled
  );
});

test('duplicate provider events are ignored (idempotent webhooks)', async () => {
  await withServer(
    async (base, db) => {
      const { campaign, leads } = await dialingLead(base, db);
      await api(base, 'POST', `/api/campaigns/${campaign.id}/tick`);
      const session = await startSession(base, campaign.id, leads[0].id);

      const params = { sid: session.providerCallSid, status: 'ringing' };
      const first = await webhook(base, params);
      assert.equal(first.body.data.type, 'applied');
      const second = await webhook(base, params);
      assert.equal(second.status, 200);
      assert.equal(second.body.data.type, 'ignored');
      assert.equal(second.body.data.reason, 'duplicate');

      const stored = db
        .prepare("SELECT COUNT(*) AS c FROM provider_events WHERE provider = 'fake-voice' AND event_id = ?")
        .get(`${session.providerCallSid}:ringing`).c;
      assert.equal(stored, 1);
    },
    undefined,
    enabled
  );
});

test('webhook auth: bad signature, unsigned, disabled and missing-secret', async () => {
  await withServer(
    async (base, db) => {
      const { campaign, leads } = await dialingLead(base, db);
      await api(base, 'POST', `/api/campaigns/${campaign.id}/tick`);
      const session = await startSession(base, campaign.id, leads[0].id);

      const bad = await webhook(base, { sid: session.providerCallSid, status: 'ringing' }, { signature: 'nope' });
      assert.equal(bad.status, 401);
      assert.equal(bad.body.error, 'invalid_signature');

      const unsigned = await webhook(base, { sid: session.providerCallSid, status: 'ringing' }, { omitSignature: true });
      assert.equal(unsigned.status, 401);
      assert.equal(unsigned.body.error, 'invalid_signature');
    },
    undefined,
    enabled
  );

  await withServer(
    async (base) => {
      const res = await webhook(base, { sid: 'FVwhatever', status: 'ringing' });
      assert.equal(res.status, 404);
      assert.equal(res.body.error, 'not_found');
    },
    undefined,
    undefined
  );

  await withServer(
    async (base) => {
      const res = await webhook(base, { sid: 'FVwhatever', status: 'ringing' });
      assert.equal(res.status, 403);
      assert.equal(res.body.error, 'provider_disabled');
    },
    undefined,
    noSecret
  );
});

test('an event for an unknown session sid is acknowledged but ignored', async () => {
  await withServer(
    async (base) => {
      const res = await webhook(base, { sid: 'FV-does-not-exist', status: 'completed' });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.type, 'ignored');
      assert.equal(res.body.data.reason, 'session_not_found');
    },
    undefined,
    enabled
  );
});

test('a session cannot start unless the campaign is running and the lead is dialing', async () => {
  await withServer(
    async (base, db) => {
      const { campaign, leads } = await dialingLead(base, db);
      // not ticked yet -> campaign_lead is queued
      const early = await api(base, 'POST', '/api/voice/sessions', { campaignId: campaign.id, leadId: leads[0].id });
      assert.equal(early.status, 409);
      assert.equal(early.body.error, 'invalid_transition');
    },
    undefined,
    enabled
  );
});

test('a second concurrent session for the same lead is rejected with 409', async () => {
  await withServer(
    async (base, db) => {
      const { campaign, leads } = await dialingLead(base, db);
      await api(base, 'POST', `/api/campaigns/${campaign.id}/tick`);
      await startSession(base, campaign.id, leads[0].id);

      const dup = await api(base, 'POST', '/api/voice/sessions', { campaignId: campaign.id, leadId: leads[0].id });
      assert.equal(dup.status, 409);
      assert.equal(dup.body.error, 'voice_session_active');
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM voice_sessions WHERE lead_id = ?').get(leads[0].id).c, 1);
    },
    undefined,
    enabled
  );
});

test('two different leads each get their own NULL-operator call row', async () => {
  await withServer(
    async (base, db) => {
      const { campaign, leads } = await dialingLead(base, db, { leads: 2 });
      await api(base, 'POST', `/api/campaigns/${campaign.id}/tick`);
      await api(base, 'POST', `/api/campaigns/${campaign.id}/tick`);

      const a = await startSession(base, campaign.id, leads[0].id);
      const b = await startSession(base, campaign.id, leads[1].id);
      assert.notEqual(a.providerCallSid, b.providerCallSid);

      const calls = db.prepare('SELECT id, user_id FROM calls WHERE id IN (?, ?)').all(a.callId, b.callId);
      assert.equal(calls.length, 2);
      assert.ok(calls.every((c) => c.user_id === null));
    },
    undefined,
    enabled
  );
});

test('speech("interested") completes the lead and the campaign', async () => {
  await withServer(
    async (base, db) => {
      const { campaign, leads } = await dialingLead(base, db);
      const lead = leads[0];
      await api(base, 'POST', `/api/campaigns/${campaign.id}/tick`);
      const session = await startSession(base, campaign.id, lead.id);
      await webhook(base, { sid: session.providerCallSid, status: 'answered' });

      const turn = await api(base, 'POST', `/api/voice/sessions/${session.id}/turn`, {
        type: 'speech',
        text: 'Yes, I am interested, tell me more',
      });
      assert.equal(turn.status, 200, JSON.stringify(turn.body));
      assert.equal(turn.body.data.agent.ended, true);
      assert.equal(turn.body.data.agent.outcome, 'completed');

      assert.equal(db.prepare('SELECT status FROM leads WHERE id = ?').get(lead.id).status, 'completed');
      assert.equal(
        db.prepare('SELECT status FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').get(campaign.id, lead.id).status,
        'completed'
      );
      assert.equal(db.prepare('SELECT status FROM campaigns WHERE id = ?').get(campaign.id).status, 'completed');
    },
    undefined,
    enabled
  );
});

test('speech opt-out creates a persistent opt-out and suppresses the lead', async () => {
  await withServer(
    async (base, db) => {
      const { campaign, leads } = await dialingLead(base, db);
      const lead = leads[0];
      await api(base, 'POST', `/api/campaigns/${campaign.id}/tick`);
      const session = await startSession(base, campaign.id, lead.id);
      await webhook(base, { sid: session.providerCallSid, status: 'answered' });

      const turn = await api(base, 'POST', `/api/voice/sessions/${session.id}/turn`, {
        type: 'speech',
        text: 'Please stop calling me, take me off your list',
      });
      assert.equal(turn.body.data.agent.outcome, 'opted_out');
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM opt_outs WHERE phone = ?').get(phoneKey(lead.phone)).c, 1);
      assert.equal(db.prepare('SELECT status FROM leads WHERE id = ?').get(lead.id).status, 'dnc');
      assert.equal(
        db.prepare('SELECT status FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').get(campaign.id, lead.id).status,
        'opted_out'
      );
    },
    undefined,
    enabled
  );
});

test('DTMF 9 opts out; DTMF 3 transfers to a representative (connected)', async () => {
  await withServer(
    async (base, db) => {
      const { campaign, leads } = await dialingLead(base, db, { leads: 2 });
      await api(base, 'POST', `/api/campaigns/${campaign.id}/tick`);
      await api(base, 'POST', `/api/campaigns/${campaign.id}/tick`);

      const optSession = await startSession(base, campaign.id, leads[0].id);
      await webhook(base, { sid: optSession.providerCallSid, status: 'answered' });
      const opt = await api(base, 'POST', `/api/voice/sessions/${optSession.id}/turn`, { type: 'dtmf', digit: '9' });
      assert.equal(opt.body.data.agent.outcome, 'opted_out');
      assert.equal(db.prepare('SELECT status FROM leads WHERE id = ?').get(leads[0].id).status, 'dnc');

      const repSession = await startSession(base, campaign.id, leads[1].id);
      await webhook(base, { sid: repSession.providerCallSid, status: 'answered' });
      const rep = await api(base, 'POST', `/api/voice/sessions/${repSession.id}/turn`, { type: 'dtmf', digit: '3' });
      assert.equal(rep.body.data.agent.outcome, 'connected');
      assert.equal(
        db.prepare('SELECT status FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').get(campaign.id, leads[1].id).status,
        'connected'
      );
    },
    undefined,
    enabled
  );
});

test('repeated silence exhausts retries and yields unanswered (lead requeued)', async () => {
  await withServer(
    async (base, db) => {
      const { campaign, leads } = await dialingLead(base, db);
      const lead = leads[0];
      await api(base, 'POST', `/api/campaigns/${campaign.id}/tick`);
      const session = await startSession(base, campaign.id, lead.id);
      await webhook(base, { sid: session.providerCallSid, status: 'answered' });

      for (let i = 0; i < 2; i += 1) {
        const r = await api(base, 'POST', `/api/voice/sessions/${session.id}/turn`, { type: 'silence' });
        assert.equal(r.body.data.agent.ended, false);
        assert.ok(r.body.data.agent.say.length >= 1, 'a reprompt is spoken');
      }
      const last = await api(base, 'POST', `/api/voice/sessions/${session.id}/turn`, { type: 'silence' });
      assert.equal(last.body.data.agent.ended, true);
      assert.equal(last.body.data.agent.outcome, 'unanswered');

      assert.equal(
        db.prepare('SELECT status FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').get(campaign.id, lead.id).status,
        'queued'
      );
    },
    undefined,
    enabled
  );
});

test('a stream disconnect finalizes as unanswered and requeues the lead', async () => {
  await withServer(
    async (base, db) => {
      const { campaign, leads } = await dialingLead(base, db);
      const lead = leads[0];
      await api(base, 'POST', `/api/campaigns/${campaign.id}/tick`);
      const session = await startSession(base, campaign.id, lead.id);
      await webhook(base, { sid: session.providerCallSid, status: 'answered' });

      const res = await api(base, 'POST', `/api/voice/sessions/${session.id}/turn`, { type: 'stream_disconnected' });
      assert.equal(res.body.data.agent.ended, true);
      assert.equal(res.body.data.agent.outcome, null);
      assert.equal(session.id && db.prepare('SELECT status, outcome FROM voice_sessions WHERE id = ?').get(session.id).outcome, 'unanswered');
      assert.equal(
        db.prepare('SELECT status FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').get(campaign.id, lead.id).status,
        'queued'
      );
    },
    undefined,
    enabled
  );
});

test('a barge-in (interrupt) keeps the agent listening without ending the call', async () => {
  await withServer(
    async (base, db) => {
      const { campaign, leads } = await dialingLead(base, db);
      await api(base, 'POST', `/api/campaigns/${campaign.id}/tick`);
      const session = await startSession(base, campaign.id, leads[0].id);
      await webhook(base, { sid: session.providerCallSid, status: 'answered' });
      const res = await api(base, 'POST', `/api/voice/sessions/${session.id}/turn`, { type: 'interrupt' });
      assert.equal(res.body.data.agent.ended, false);
      assert.equal(res.body.data.agent.reason, 'barge_in');
    },
    undefined,
    enabled
  );
});

test('a provider start failure returns 502 and requeues the campaign lead', async () => {
  await withServer(
    async (base, db) => {
      const { campaign, leads } = await dialingLead(base, db);
      const lead = leads[0];
      await api(base, 'POST', `/api/campaigns/${campaign.id}/tick`);

      const res = await api(base, 'POST', '/api/voice/sessions', { campaignId: campaign.id, leadId: lead.id });
      assert.equal(res.status, 502);
      assert.equal(res.body.error, 'provider_start_failed');

      const session = db.prepare('SELECT status, outcome FROM voice_sessions WHERE lead_id = ?').get(lead.id);
      assert.equal(session.status, 'failed');
      assert.equal(session.outcome, 'failed');

      assert.equal(
        db.prepare('SELECT status FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').get(campaign.id, lead.id).status,
        'queued'
      );
    },
    undefined,
    { voice: { enabled: true, webhookSecret: SECRET, failStart: true } }
  );
});

test('emergency stop ends every live voice session', async () => {
  await withServer(
    async (base, db) => {
      const { campaign, leads } = await dialingLead(base, db, { leads: 2 });
      await api(base, 'POST', `/api/campaigns/${campaign.id}/tick`);
      await api(base, 'POST', `/api/campaigns/${campaign.id}/tick`);
      const a = await startSession(base, campaign.id, leads[0].id);
      const b = await startSession(base, campaign.id, leads[1].id);

      const res = await api(base, 'POST', '/api/campaigns/emergency-stop');
      assert.equal(res.status, 200);
      assert.equal(res.body.data.voiceEnded, 2);

      for (const s of [a, b]) {
        const row = db.prepare('SELECT status, disconnect_reason FROM voice_sessions WHERE id = ?').get(s.id);
        assert.equal(row.status, 'ended');
        assert.equal(row.disconnect_reason, 'emergency_stop');
      }
    },
    undefined,
    enabled
  );
});

test('voice sessions require authentication and reject invalid turns', async () => {
  await withServer(
    async (base, db) => {
      const unauth = await raw(base, 'POST', '/api/voice/sessions', {
        body: { campaignId: 1, leadId: 1 },
      });
      assert.equal(unauth.status, 401);

      const { campaign, leads } = await dialingLead(base, db);
      await api(base, 'POST', `/api/campaigns/${campaign.id}/tick`);
      const session = await startSession(base, campaign.id, leads[0].id);

      const bad = await api(base, 'POST', `/api/voice/sessions/${session.id}/turn`, { type: 'nonsense' });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.error, 'validation_error');

      await api(base, 'POST', `/api/voice/sessions/${session.id}/end`, { reason: 'operator_ended' });
      const afterEnd = await api(base, 'POST', `/api/voice/sessions/${session.id}/turn`, { type: 'speech', text: 'hello' });
      assert.equal(afterEnd.status, 409);
      assert.equal(afterEnd.body.error, 'voice_session_ended');
    },
    undefined,
    enabled
  );
});

test('no voice session can be created while the voice subsystem is disabled (demo default)', async () => {
  await withServer(
    async (base, db) => {
      const res = await api(base, 'POST', '/api/voice/sessions', { campaignId: 1, leadId: 1 });
      assert.equal(res.status, 404);
      assert.equal(res.body.error, 'not_found');
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM voice_sessions').get().c, 0);
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM calls').get().c, 0);
    },
    undefined,
    undefined
  );
});

test('a caller turn is rejected until the provider confirms the call was answered', async () => {
  await withServer(
    async (base, db) => {
      const { campaign, leads } = await dialingLead(base, db);
      await api(base, 'POST', `/api/campaigns/${campaign.id}/tick`);
      const session = await startSession(base, campaign.id, leads[0].id);
      assert.equal(session.status, 'ringing');

      const early = await api(base, 'POST', `/api/voice/sessions/${session.id}/turn`, {
        type: 'speech',
        text: 'I am interested',
      });
      assert.equal(early.status, 409);
      assert.equal(early.body.error, 'voice_not_answered');
      // The un-answered call must not have been finalized as connected/successful.
      const stored = db.prepare('SELECT status, outcome FROM voice_sessions WHERE id = ?').get(session.id);
      assert.equal(stored.status, 'ringing');
      assert.equal(stored.outcome, '');

      await webhook(base, { sid: session.providerCallSid, status: 'answered' });
      const turn = await api(base, 'POST', `/api/voice/sessions/${session.id}/turn`, {
        type: 'speech',
        text: 'I am interested',
      });
      assert.equal(turn.status, 200, JSON.stringify(turn.body));
    },
    undefined,
    enabled
  );
});

test('live calling cannot be enabled through config overrides', async () => {
  await withServer(
    async (base) => {
      const health = await raw(base, 'GET', '/api/health/config');
      assert.equal(health.status, 200);
      assert.equal(health.body.telephony.liveEnabled, false);
      assert.equal(health.body.voice.liveEnabled, false);
      assert.equal(health.body.voice.stack.liveEnabled, false);
      assert.equal(health.body.voice.stack.mode, 'simulation');
    },
    undefined,
    { telephony: { liveEnabled: true }, voice: { enabled: true, liveEnabled: true, webhookSecret: SECRET } }
  );
});

test('an out-of-order ring after answer does not downgrade the session or call', async () => {
  await withServer(
    async (base, db) => {
      const { campaign, leads } = await dialingLead(base, db);
      await api(base, 'POST', `/api/campaigns/${campaign.id}/tick`);
      const session = await startSession(base, campaign.id, leads[0].id);

      const answered = await webhook(base, { sid: session.providerCallSid, status: 'answered' });
      assert.equal(answered.body.data.status, 'in_progress');

      const lateRing = await webhook(base, { sid: session.providerCallSid, status: 'ringing' });
      assert.equal(lateRing.status, 200);
      assert.equal(lateRing.body.data.type, 'applied');

      assert.equal(
        db.prepare('SELECT status FROM voice_sessions WHERE id = ?').get(session.id).status,
        'in_progress'
      );
      assert.equal(db.prepare('SELECT status FROM calls WHERE id = ?').get(session.callId).status, 'in_progress');
    },
    undefined,
    enabled
  );
});

const TWILIO_ENV_KEYS = [
  'APEX_TWILIO_ACCOUNT_SID',
  'APEX_TWILIO_AUTH_TOKEN',
  'APEX_TWILIO_FROM_NUMBER',
  'APEX_VOICE_WEBHOOK_SECRET',
];

async function withTempEnv(keys, values, fn) {
  const saved = {};
  for (const key of keys) saved[key] = process.env[key];
  for (const key of keys) {
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  try {
    return await fn();
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('a recognized but unimplemented provider is never ready, even with fully populated credentials', async () => {
  const fakeValues = Object.fromEntries(TWILIO_ENV_KEYS.map((key) => [key, 'dummy-not-a-real-secret']));
  await withTempEnv(TWILIO_ENV_KEYS, fakeValues, async () =>
    withServer(
      async (base) => {
        const health = await raw(base, 'GET', '/api/health/config');
        assert.equal(health.status, 200);
        assert.equal(health.body.voice.provider, 'twilio');
        const stack = health.body.voice.stack;
        assert.equal(stack.provider, 'twilio');
        assert.equal(stack.recognized, true);
        assert.equal(stack.implemented, false);
        assert.equal(stack.credentialsPresent, true);
        assert.equal(stack.ready, false);
        assert.equal(stack.liveEnabled, false);
        assert.equal(stack.mode, 'not_implemented');
        assert.ok(!JSON.stringify(health.body).includes('dummy-not-a-real-secret'));

        const settings = await api(base, 'GET', '/api/settings');
        assert.equal(settings.body.data.voice.stack.implemented, false);
        assert.equal(settings.body.data.voice.stack.ready, false);
        assert.ok(!JSON.stringify(settings.body).includes('dummy-not-a-real-secret'));
      },
      undefined,
      { voice: { provider: 'twilio' } }
    )
  );
});

test('a recognized provider with missing credentials is not ready either', async () => {
  const cleared = Object.fromEntries(TWILIO_ENV_KEYS.map((key) => [key, undefined]));
  await withTempEnv(TWILIO_ENV_KEYS, cleared, async () =>
    withServer(
      async (base) => {
        const health = await raw(base, 'GET', '/api/health/config');
        const stack = health.body.voice.stack;
        assert.equal(stack.provider, 'twilio');
        assert.equal(stack.implemented, false);
        assert.equal(stack.credentialsPresent, false);
        assert.equal(stack.ready, false);
        assert.equal(stack.mode, 'not_implemented');
        assert.deepEqual(stack.missingConfig, TWILIO_ENV_KEYS);
      },
      undefined,
      { voice: { provider: 'twilio' } }
    )
  );
});

test('the voice webhook secret is never exposed by health or settings', async () => {
  await withServer(
    async (base) => {
      const health = await raw(base, 'GET', '/api/health/config');
      assert.equal(health.status, 200);
      assert.ok(!JSON.stringify(health.body).includes(SECRET));
      assert.equal(health.body.voice.enabled, true);
      assert.equal(health.body.voice.liveEnabled, false);
      assert.equal(health.body.voice.provider, 'fake');

      const settings = await api(base, 'GET', '/api/settings');
      assert.equal(settings.status, 200);
      assert.ok(!JSON.stringify(settings.body).includes(SECRET));
    },
    undefined,
    enabled
  );
});
