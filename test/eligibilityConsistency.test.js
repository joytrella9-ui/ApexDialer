import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer, api } from '../test-support/helpers.js';
import { assertSimulatedManualDialing } from '../src/services/calls.js';
import { mergeConfig } from '../src/app.js';

// Synthetic leads only. No provider is contacted by any test here.

function zoneForLocalHour(hour) {
  const utcHour = new Date().getUTCHours();
  let offset = hour - utcHour;
  if (offset > 14) offset -= 24;
  if (offset < -12) offset += 24;
  return offset >= 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
}

let seq = 0;
async function createLead(base, overrides = {}) {
  seq += 1;
  const res = await api(base, 'POST', '/api/leads', {
    name: `Synthetic Lead ${seq}`,
    phone: `+1555020${String(1000 + seq).slice(-4)}`,
    callType: 'sales',
    timezone: zoneForLocalHour(12),
    consent: { status: 'recorded', evidence: 'synthetic evidence', source: 'test', date: '2026-01-01' },
    ...overrides,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
}

async function attempt(base, leadId) {
  return api(base, 'POST', '/api/calls/attempt', { leadId });
}

function countCalls(db) {
  return db.prepare('SELECT COUNT(*) AS c FROM calls').get().c;
}

// ---- demo behavior is preserved ----------------------------------------------------

test('demo mode: a manual attempt on an eligible synthetic lead still works and is labelled simulated', async () => {
  await withServer(async (base) => {
    const lead = await createLead(base);
    const res = await attempt(base, lead.id);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.dialingMode, 'simulated');
    assert.equal(res.body.data.call.status, 'in_progress');
  });
});

test('demo mode still refuses leads that fail the legacy checks (consent, DNC, window)', async () => {
  await withServer(async (base, db) => {
    const noConsent = await createLead(base, { consent: { status: 'none' } });
    const r1 = await attempt(base, noConsent.id);
    assert.equal(r1.status, 409);
    assert.equal(r1.body.error, 'not_eligible');

    const lead = await createLead(base);
    db.prepare("UPDATE leads SET status = 'dnc', suppression_blocked = 1 WHERE id = ?").run(lead.id);
    const r2 = await attempt(base, lead.id);
    assert.equal(r2.status, 409);
    assert.equal(r2.body.error, 'not_eligible');
    assert.equal(countCalls(db), 0, 'refused attempts write no call row');
  });
});

// ---- live-capable configurations are refused before any row is written ---------------

test('a manual attempt is refused when demo mode is off, with no call row written', async () => {
  await withServer(
    async (base, db) => {
      const lead = await createLead(base);
      const res = await attempt(base, lead.id);
      assert.equal(res.status, 409);
      assert.equal(res.body.error, 'manual_dial_requires_campaign_gate');
      assert.equal(countCalls(db), 0);
    },
    undefined,
    { demoMode: false }
  );
});

test('a manual attempt is refused when a live provider is selected even in demo mode', async () => {
  await withServer(
    async (base, db) => {
      const lead = await createLead(base);
      const res = await attempt(base, lead.id);
      assert.equal(res.status, 409);
      assert.equal(res.body.error, 'manual_dial_requires_campaign_gate');
      assert.equal(countCalls(db), 0);
    },
    undefined,
    { voice: { provider: 'twilio' } }
  );
});

test('the simulated-dial check fails closed on a missing or partial dialing context', () => {
  assert.equal(assertSimulatedManualDialing({ demoMode: true, provider: 'fake', liveEnabled: false }), 'simulated');
  for (const ctx of [undefined, null, {}, { demoMode: false, provider: 'fake', liveEnabled: false }, { demoMode: true, provider: 'fake', liveEnabled: true }, { demoMode: true, provider: 'twilio', liveEnabled: false }]) {
    assert.throws(() => assertSimulatedManualDialing(ctx), (err) => err.status === 409 && err.message === 'manual_dial_requires_campaign_gate', JSON.stringify(ctx));
  }
});

test('the compliance gate cannot be relaxed outside demo mode, whatever the overrides say', () => {
  const cfg = mergeConfig({ demoMode: false, compliance: { requireComplianceProfile: false } });
  assert.equal(cfg.compliance.requireComplianceProfile, true);
  assert.equal(mergeConfig({ voice: { provider: 'twilio' }, compliance: { requireComplianceProfile: false } }).compliance.requireComplianceProfile, true);
});

test('live calling and recording stay off in the default configuration', () => {
  const cfg = mergeConfig({});
  assert.equal(cfg.demoMode, true);
  assert.equal(cfg.telephony.liveEnabled, false);
  assert.equal(cfg.voice.liveEnabled, false);
  assert.equal(cfg.voice.recordingEnabled, false);
  assert.equal(cfg.compliance.recordingAllowed, false);
});
