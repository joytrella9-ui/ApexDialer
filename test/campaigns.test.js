import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer as withServerRaw, api, raw } from '../test-support/helpers.js';
import { phoneKey } from '../src/services/leads.js';

// These suites cover the offline simulated dialer, which pre-dates the live
// compliance gate. They opt out of the fail-closed live gate so their existing
// eligibility expectations are unchanged; the gate itself is exercised by
// test/dialerEligibility.test.js and test/voiceOrchestrator.test.js.
const withServer = (fn, db, cfg = {}) =>
  withServerRaw(fn, db, { ...cfg, compliance: { ...(cfg.compliance ?? {}), requireComplianceProfile: false } });

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
  return `+1 555 03${String(1000 + phoneSeq).slice(-4)}`;
}

async function seedLead(base, { phone = nextPhone(), status, callType = 'sales', timezone } = {}) {
  const res = await api(base, 'POST', '/api/leads', {
    name: `Campaign Lead ${phoneSeq}`,
    phone,
    callType,
    timezone: timezone ?? zoneForLocalHour(12),
    status,
    consent: { status: 'recorded', evidence: 'signed form', source: 'web-form', date: '2026-08-01' },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
}

async function newCampaign(base, body = {}) {
  const res = await api(base, 'POST', '/api/campaigns', { name: 'Test Campaign', ...body });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
}

const fastRetry = { campaigns: { defaultRetryDelayMinutes: 0 } };

test('campaigns can be created, listed and fetched with stats', async () => {
  await withServer(async (base) => {
    const campaign = await newCampaign(base, { name: 'Q4 Outreach', maxAttempts: 2, concurrencyLimit: 3 });
    assert.equal(campaign.status, 'draft');
    assert.equal(campaign.name, 'Q4 Outreach');
    assert.equal(campaign.maxAttempts, 2);
    assert.equal(campaign.concurrencyLimit, 3);
    assert.equal(campaign.aiEnabled, false);
    assert.equal(campaign.ivrEnabled, true);
    assert.equal(campaign.stats.total, 0);

    const list = await api(base, 'GET', '/api/campaigns');
    assert.equal(list.status, 200);
    assert.equal(list.body.count, 1);

    const fetched = await api(base, 'GET', `/api/campaigns/${campaign.id}`);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.data.id, campaign.id);
  });
});

test('campaign lifecycle enforces valid transitions', async () => {
  await withServer(async (base) => {
    const campaign = await newCampaign(base);

    const badPause = await api(base, 'POST', `/api/campaigns/${campaign.id}/pause`);
    assert.equal(badPause.status, 409);
    assert.equal(badPause.body.error, 'invalid_transition');

    const started = await api(base, 'POST', `/api/campaigns/${campaign.id}/start`);
    assert.equal(started.status, 200);
    assert.equal(started.body.data.status, 'running');

    const paused = await api(base, 'POST', `/api/campaigns/${campaign.id}/pause`);
    assert.equal(paused.body.data.status, 'paused');

    const resumed = await api(base, 'POST', `/api/campaigns/${campaign.id}/resume`);
    assert.equal(resumed.body.data.status, 'running');

    const stopped = await api(base, 'POST', `/api/campaigns/${campaign.id}/stop`);
    assert.equal(stopped.body.data.status, 'stopped');
  });
});

test('queueing only enrolls eligible leads and skips suppressed ones', async () => {
  await withServer(async (base, db) => {
    const campaign = await newCampaign(base);
    const eligible = await seedLead(base);
    const dncLead = await seedLead(base);
    db.prepare("INSERT INTO dnc_entries (phone, source, list_name, active) VALUES (?, 'test', 'test', 1)").run(
      dncLead.phone
    );

    const queued = await api(base, 'POST', `/api/campaigns/${campaign.id}/queue`, {});
    assert.equal(queued.status, 201);
    assert.equal(queued.body.data.queued, 1);
    assert.equal(queued.body.data.skipped, 1);

    const stats = (await api(base, 'GET', `/api/campaigns/${campaign.id}`)).body.data.stats;
    assert.equal(stats.queued, 1);
    assert.equal(stats.total, 1);
    assert.ok(eligible.id);
  });
});

test('tick claims an eligible lead and increments the attempt count', async () => {
  await withServer(async (base, db) => {
    const campaign = await newCampaign(base);
    const lead = await seedLead(base);
    await api(base, 'POST', `/api/campaigns/${campaign.id}/queue`, { leadIds: [lead.id] });
    await api(base, 'POST', `/api/campaigns/${campaign.id}/start`);

    const tick = await api(base, 'POST', `/api/campaigns/${campaign.id}/tick`);
    assert.equal(tick.status, 200);
    assert.ok(tick.body.data.claimed, JSON.stringify(tick.body));
    assert.equal(tick.body.data.claimed.leadId, lead.id);
    assert.equal(tick.body.data.claimed.status, 'dialing');
    assert.equal(tick.body.data.claimed.attemptCount, 1);

    const row = db
      .prepare('SELECT status, attempt_count FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?')
      .get(campaign.id, lead.id);
    assert.equal(row.status, 'dialing');
    assert.equal(row.attempt_count, 1);

    const events = db
      .prepare("SELECT COUNT(*) AS c FROM campaign_events WHERE campaign_id = ? AND event_type = 'dialing'")
      .get(campaign.id).c;
    assert.equal(events, 1);
  });
});

test('concurrency limit blocks a second concurrent dial', async () => {
  await withServer(async (base) => {
    const campaign = await newCampaign(base, { concurrencyLimit: 1 });
    const a = await seedLead(base);
    const b = await seedLead(base);
    await api(base, 'POST', `/api/campaigns/${campaign.id}/queue`, { leadIds: [a.id, b.id] });
    await api(base, 'POST', `/api/campaigns/${campaign.id}/start`);

    const first = await api(base, 'POST', `/api/campaigns/${campaign.id}/tick`);
    assert.ok(first.body.data.claimed);

    const second = await api(base, 'POST', `/api/campaigns/${campaign.id}/tick`);
    assert.equal(second.body.data.claimed, null);
    assert.equal(second.body.data.reason, 'concurrency_limit');
  });
});

test('a lead is never dialed concurrently by two campaigns', async () => {
  await withServer(async (base) => {
    const lead = await seedLead(base);
    const one = await newCampaign(base, { name: 'One' });
    const two = await newCampaign(base, { name: 'Two' });
    await api(base, 'POST', `/api/campaigns/${one.id}/queue`, { leadIds: [lead.id] });
    await api(base, 'POST', `/api/campaigns/${two.id}/queue`, { leadIds: [lead.id] });
    await api(base, 'POST', `/api/campaigns/${one.id}/start`);
    await api(base, 'POST', `/api/campaigns/${two.id}/start`);

    const first = await api(base, 'POST', `/api/campaigns/${one.id}/tick`);
    assert.ok(first.body.data.claimed);

    const second = await api(base, 'POST', `/api/campaigns/${two.id}/tick`);
    assert.equal(second.body.data.claimed, null);
    assert.equal(second.body.data.reason, 'no_eligible_leads');
  });
});

test('an opted-out lead is terminalized and never dialed', async () => {
  await withServer(async (base, db) => {
    const campaign = await newCampaign(base);
    const lead = await seedLead(base);
    db.prepare('INSERT INTO opt_outs (phone, reason, source) VALUES (?, ?, ?)').run(lead.phone, 'earlier request', 'test');
    await api(base, 'POST', `/api/campaigns/${campaign.id}/queue`, { leadIds: [lead.id], onlyEligible: false });
    await api(base, 'POST', `/api/campaigns/${campaign.id}/start`);

    const tick = await api(base, 'POST', `/api/campaigns/${campaign.id}/tick`);
    assert.equal(tick.body.data.claimed, null);

    const row = db
      .prepare('SELECT status FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?')
      .get(campaign.id, lead.id);
    assert.equal(row.status, 'opted_out');
  });
});

test('IVR opt-out (digit 9) records a persistent opt-out and suppresses the lead', async () => {
  await withServer(async (base, db) => {
    const campaign = await newCampaign(base);
    const lead = await seedLead(base);
    await api(base, 'POST', `/api/campaigns/${campaign.id}/queue`, { leadIds: [lead.id] });
    await api(base, 'POST', `/api/campaigns/${campaign.id}/start`);
    await api(base, 'POST', `/api/campaigns/${campaign.id}/tick`);

    const res = await api(base, 'POST', `/api/campaigns/${campaign.id}/ivr`, { leadId: lead.id, digit: '9' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.ivr.route, 'opt_out');

    const optOut = db.prepare('SELECT COUNT(*) AS c FROM opt_outs WHERE phone = ?').get(phoneKey(lead.phone)).c;
    assert.equal(optOut, 1);
    assert.equal(db.prepare('SELECT status FROM leads WHERE id = ?').get(lead.id).status, 'dnc');

    const cl = db
      .prepare('SELECT status FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?')
      .get(campaign.id, lead.id);
    assert.equal(cl.status, 'opted_out');

    const ivr = db.prepare('SELECT route, digit FROM ivr_responses WHERE lead_id = ?').get(lead.id);
    assert.equal(ivr.route, 'opt_out');
    assert.equal(ivr.digit, '9');
  });
});

test('IVR interest (digit 1) completes the lead and the campaign', async () => {
  await withServer(async (base, db) => {
    const campaign = await newCampaign(base);
    const lead = await seedLead(base);
    await api(base, 'POST', `/api/campaigns/${campaign.id}/queue`, { leadIds: [lead.id] });
    await api(base, 'POST', `/api/campaigns/${campaign.id}/start`);
    await api(base, 'POST', `/api/campaigns/${campaign.id}/tick`);

    const res = await api(base, 'POST', `/api/campaigns/${campaign.id}/ivr`, { leadId: lead.id, digit: '1' });
    assert.equal(res.body.data.ivr.route, 'interested');
    assert.equal(db.prepare('SELECT status FROM leads WHERE id = ?').get(lead.id).status, 'completed');
    assert.equal(
      db.prepare('SELECT status FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').get(campaign.id, lead.id)
        .status,
      'completed'
    );

    const campaignRow = db.prepare('SELECT status FROM campaigns WHERE id = ?').get(campaign.id);
    assert.equal(campaignRow.status, 'completed');
  });
});

test('invalid IVR input is rejected, then retries exhaust to unanswered', async () => {
  await withServer(async (base, db) => {
    const campaign = await newCampaign(base, { maxAttempts: 1 });
    const lead = await seedLead(base);
    await api(base, 'POST', `/api/campaigns/${campaign.id}/queue`, { leadIds: [lead.id] });
    await api(base, 'POST', `/api/campaigns/${campaign.id}/start`);
    await api(base, 'POST', `/api/campaigns/${campaign.id}/tick`);

    const first = await api(base, 'POST', `/api/campaigns/${campaign.id}/ivr`, { leadId: lead.id, digit: '7' });
    assert.equal(first.body.data.ivr.valid, false);
    assert.equal(first.body.data.ivr.route, 'invalid');

    const second = await api(base, 'POST', `/api/campaigns/${campaign.id}/ivr`, { leadId: lead.id, digit: '7' });
    assert.equal(second.body.data.ivr.route, 'invalid');

    const third = await api(base, 'POST', `/api/campaigns/${campaign.id}/ivr`, { leadId: lead.id, digit: '7' });
    assert.equal(third.body.data.ivr.route, 'opt-retry-exhausted');
    assert.equal(
      db.prepare('SELECT status FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').get(campaign.id, lead.id)
        .status,
      'failed'
    );
  });
});

test('a retryable outcome requeues the lead until attempts are exhausted', async () => {
  await withServer(
    async (base, db) => {
      const campaign = await newCampaign(base, { maxAttempts: 2, retryDelayMinutes: 0 });
      const lead = await seedLead(base);
      await api(base, 'POST', `/api/campaigns/${campaign.id}/queue`, { leadIds: [lead.id] });
      await api(base, 'POST', `/api/campaigns/${campaign.id}/start`);

      await api(base, 'POST', `/api/campaigns/${campaign.id}/tick`);
      const first = await api(base, 'POST', `/api/campaigns/${campaign.id}/outcome`, {
        leadId: lead.id,
        outcome: 'unanswered',
      });
      assert.equal(first.status, 200);
      let row = db
        .prepare('SELECT status, attempt_count FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?')
        .get(campaign.id, lead.id);
      assert.equal(row.status, 'queued');
      assert.equal(row.attempt_count, 1);

      const secondTick = await api(base, 'POST', `/api/campaigns/${campaign.id}/tick`);
      assert.equal(secondTick.body.data.claimed.attemptCount, 2);

      await api(base, 'POST', `/api/campaigns/${campaign.id}/outcome`, { leadId: lead.id, outcome: 'unanswered' });
      row = db
        .prepare('SELECT status FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?')
        .get(campaign.id, lead.id);
      assert.equal(row.status, 'failed');
    },
    undefined,
    fastRetry
  );
});

test('simulated AI classifies an opt-out request and suppresses the lead', async () => {
  await withServer(async (base, db) => {
    const campaign = await newCampaign(base, { aiEnabled: true });
    const lead = await seedLead(base);
    await api(base, 'POST', `/api/campaigns/${campaign.id}/queue`, { leadIds: [lead.id] });
    await api(base, 'POST', `/api/campaigns/${campaign.id}/start`);
    await api(base, 'POST', `/api/campaigns/${campaign.id}/tick`);

    const res = await api(base, 'POST', `/api/campaigns/${campaign.id}/ai`, {
      leadId: lead.id,
      text: 'Please stop calling me, take me off your list',
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.ai.intent, 'opt_out');
    assert.equal(res.body.data.ai.route, 'opt_out');
    assert.equal(db.prepare('SELECT status FROM leads WHERE id = ?').get(lead.id).status, 'dnc');

    const transcripts = db
      .prepare('SELECT role, intent FROM ai_transcripts WHERE lead_id = ? ORDER BY id')
      .all(lead.id);
    assert.equal(transcripts.length, 2);
    assert.equal(transcripts[0].role, 'lead');
    assert.equal(transcripts[1].role, 'ai');
  });
});

test('outcome on a lead that is not dialing is rejected', async () => {
  await withServer(async (base) => {
    const campaign = await newCampaign(base);
    const lead = await seedLead(base);
    await api(base, 'POST', `/api/campaigns/${campaign.id}/queue`, { leadIds: [lead.id] });

    const res = await api(base, 'POST', `/api/campaigns/${campaign.id}/outcome`, {
      leadId: lead.id,
      outcome: 'completed',
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'invalid_transition');
  });
});

test('emergency stop halts every running and paused campaign', async () => {
  await withServer(async (base) => {
    const one = await newCampaign(base, { name: 'One' });
    const two = await newCampaign(base, { name: 'Two' });
    await api(base, 'POST', `/api/campaigns/${one.id}/start`);
    await api(base, 'POST', `/api/campaigns/${two.id}/start`);
    await api(base, 'POST', `/api/campaigns/${two.id}/pause`);

    const res = await api(base, 'POST', '/api/campaigns/emergency-stop');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.stopped, 2);

    assert.equal((await api(base, 'GET', `/api/campaigns/${one.id}`)).body.data.status, 'stopped');
    assert.equal((await api(base, 'GET', `/api/campaigns/${two.id}`)).body.data.status, 'stopped');
  });
});

test('campaign actions are audited and require authentication', async () => {
  await withServer(async (base, db) => {
    const campaign = await newCampaign(base);
    await api(base, 'POST', `/api/campaigns/${campaign.id}/start`);

    const actions = db
      .prepare("SELECT action FROM audit_log WHERE entity_type = 'campaign' ORDER BY id")
      .all()
      .map((r) => r.action);
    assert.ok(actions.includes('campaign_created'));
    assert.ok(actions.includes('campaign_running'));

    const unauth = await raw(base, 'GET', '/api/campaigns');
    assert.equal(unauth.status, 401);
  });
});

test('validation rejects a campaign with no name', async () => {
  await withServer(async (base) => {
    const res = await api(base, 'POST', '/api/campaigns', { name: '' });
    assert.equal(res.status, 400);
  });
});
