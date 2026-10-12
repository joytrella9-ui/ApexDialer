import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer, api } from '../test-support/helpers.js';
import { createDb } from '../src/db/db.js';
import { createLead, updateLead } from '../src/services/leads.js';
import { evaluateLead, evaluateLeadById, isValidTimeZone } from '../src/services/compliance.js';

const BASE = {
  name: 'Test Lead',
  phone: '5550100001',
  company: 'Test Co',
  callType: 'sales',
  timezone: 'America/New_York',
  consent: { status: 'recorded', evidence: 'signed form', source: 'web-form', date: '2026-01-01' },
  notes: '',
};

function makeLead(db, overrides = {}) {
  return createLead(db, { ...BASE, ...overrides });
}

function codes(result) {
  return result.reasons.map((r) => r.code);
}

function withDb(fn) {
  const db = createDb(':memory:');
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

// fixed instants (America/New_York = UTC-5 in January)
const OPEN_NY = new Date('2026-01-15T13:00:00Z'); // 08:00 EST
const BEFORE_NY = new Date('2026-01-15T12:59:00Z'); // 07:59 EST
const LATE_NY = new Date('2026-01-16T01:59:00Z'); // 20:59 EST
const AFTER_NY = new Date('2026-01-16T02:00:00Z'); // 21:00 EST

// ---- timezone helper ------------------------------------------------------

test('isValidTimeZone accepts IANA names and rejects junk', () => {
  assert.equal(isValidTimeZone('America/New_York'), true);
  assert.equal(isValidTimeZone('UTC'), true);
  assert.equal(isValidTimeZone('Not/AZone'), false);
  assert.equal(isValidTimeZone(''), false);
  assert.equal(isValidTimeZone(undefined), false);
});

// ---- allowed / blocked window --------------------------------------------

test('allows a fully valid lead inside the calling window', () => {
  withDb((db) => {
    const lead = makeLead(db);
    const result = evaluateLead(db, lead, { now: OPEN_NY });
    assert.equal(result.decision, 'allowed');
    assert.equal(result.mayDial, true);
    assert.equal(result.allowed, true);
    assert.ok(codes(result).includes('within_calling_window'));
    assert.equal(result.details.consent.proofLevel, 'self-asserted');
    assert.match(result.disclaimer, /not a legal compliance certification/i);
  });
});

test('blocks before the window opens', () => {
  withDb((db) => {
    const result = evaluateLead(db, makeLead(db), { now: BEFORE_NY });
    assert.equal(result.decision, 'blocked');
    assert.ok(codes(result).includes('outside_calling_window'));
  });
});

test('blocks at and after the window closes (21:00 closed, 20:59 open)', () => {
  withDb((db) => {
    assert.equal(evaluateLead(db, makeLead(db), { now: LATE_NY }).decision, 'allowed');
    const late = evaluateLead(db, makeLead(db), { now: AFTER_NY });
    assert.equal(late.decision, 'blocked');
    assert.ok(codes(late).includes('outside_calling_window'));
  });
});

test('window boundaries are inclusive of 08:00 and exclusive of 21:00', () => {
  withDb((db) => {
    assert.equal(evaluateLead(db, makeLead(db), { now: OPEN_NY }).decision, 'allowed');
  });
});

// ---- DNC ------------------------------------------------------------------

test('blocks a phone that matches the internal Do Not Call list', () => {
  withDb((db) => {
    db.prepare('INSERT INTO dnc_entries (phone, source) VALUES (?, ?)').run('5550100002', 'internal');
    const info = db
      .prepare(
        `INSERT INTO leads (name, phone, call_type, timezone, consent_status, consent_evidence, consent_source, consent_date, status)
         VALUES ('DNC Lead', '5550100002', 'sales', 'UTC', 'recorded', 'e', 's', '2026-01-01', 'pending')`
      )
      .run();
    const lead = evaluateLeadById(db, Number(info.lastInsertRowid), { now: new Date('2026-06-15T13:00:00Z') });
    assert.equal(lead.decision, 'blocked');
    assert.ok(lead.reasons.some((r) => r.code === 'internal_dnc' && r.severity === 'block'));
  });
});

// ---- consent --------------------------------------------------------------

test('blocks sales calls with no recorded consent', () => {
  withDb((db) => {
    const result = evaluateLead(db, makeLead(db, { consent: { status: 'none' } }), { now: OPEN_NY });
    assert.equal(result.decision, 'blocked');
    assert.ok(codes(result).includes('missing_consent'));
    assert.equal(result.details.consent.proofLevel, 'missing');
  });
});

test('blocks recorded consent that has no evidence', () => {
  withDb((db) => {
    const result = evaluateLead(
      db,
      makeLead(db, { consent: { status: 'recorded', source: 'web-form', date: '2026-01-01' } }),
      { now: OPEN_NY }
    );
    assert.equal(result.decision, 'blocked');
    assert.ok(codes(result).includes('insufficient_consent_evidence'));
  });
});

test('flags incomplete consent metadata for human review (not a hard block)', () => {
  withDb((db) => {
    const result = evaluateLead(
      db,
      makeLead(db, { consent: { status: 'recorded', evidence: 'signed form' } }),
      { now: OPEN_NY }
    );
    assert.equal(result.decision, 'review');
    assert.equal(result.mayDial, false);
    assert.ok(codes(result).includes('consent_metadata_incomplete'));
    assert.ok(result.reasons.some((r) => r.code === 'consent_metadata_incomplete' && r.severity === 'review'));
  });
});

test('blocks when consent was revoked', () => {
  withDb((db) => {
    const result = evaluateLead(db, makeLead(db, { consent: { status: 'revoked' } }), { now: OPEN_NY });
    assert.equal(result.decision, 'blocked');
    assert.ok(codes(result).includes('consent_revoked'));
  });
});

// ---- call type ------------------------------------------------------------

test('existing-customer calls do not require marketing consent', () => {
  withDb((db) => {
    const result = evaluateLead(
      db,
      makeLead(db, { callType: 'existing-customer', consent: { status: 'none' } }),
      { now: OPEN_NY }
    );
    assert.equal(result.decision, 'allowed');
    assert.ok(codes(result).includes('consent_not_required'));
    assert.equal(result.details.consent.required, false);
    assert.equal(result.details.consent.proofLevel, 'not-required');
  });
});

test('existing-customer calls are still blocked if consent was revoked', () => {
  withDb((db) => {
    const result = evaluateLead(
      db,
      makeLead(db, { callType: 'existing-customer', consent: { status: 'revoked' } }),
      { now: OPEN_NY }
    );
    assert.equal(result.decision, 'blocked');
    assert.ok(codes(result).includes('consent_revoked'));
  });
});

test('fails closed on an unknown call type', () => {
  withDb((db) => {
    const fake = {
      id: 987654,
      name: 'Weird',
      phone: '5550109999',
      callType: 'mystery',
      timezone: 'UTC',
      status: 'pending',
      consent: { status: 'recorded' },
    };
    const result = evaluateLead(db, fake, { now: new Date('2026-06-15T13:00:00Z') });
    assert.equal(result.decision, 'blocked');
    assert.ok(codes(result).includes('unknown_call_type'));
  });
});

// ---- timezone fail-closed -------------------------------------------------

test('fails closed on a missing timezone', () => {
  withDb((db) => {
    const result = evaluateLead(db, makeLead(db, { timezone: '' }), { now: OPEN_NY });
    assert.equal(result.decision, 'blocked');
    assert.ok(codes(result).includes('missing_timezone'));
    assert.equal(result.details.schedule.valid, false);
  });
});

test('fails closed on an invalid timezone', () => {
  withDb((db) => {
    const result = evaluateLead(db, makeLead(db, { timezone: 'Not/AZone' }), { now: OPEN_NY });
    assert.equal(result.decision, 'blocked');
    assert.ok(codes(result).includes('invalid_timezone'));
  });
});

// ---- lead status ----------------------------------------------------------

test('blocks leads that are not pending', () => {
  withDb((db) => {
    const completed = makeLead(db);
    updateLead(db, completed.id, { status: 'completed' });
    assert.ok(codes(evaluateLeadById(db, completed.id, { now: OPEN_NY })).includes('lead_status_completed'));

    const dnc = makeLead(db, { phone: '5550100010' });
    updateLead(db, dnc.id, { status: 'dnc' });
    assert.ok(codes(evaluateLeadById(db, dnc.id, { now: OPEN_NY })).includes('lead_status_dnc'));

    const blocked = makeLead(db, { phone: '5550100011' });
    updateLead(db, blocked.id, { status: 'blocked' });
    assert.ok(codes(evaluateLeadById(db, blocked.id, { now: OPEN_NY })).includes('lead_status_blocked'));
  });
});

// ---- DST and timezone boundaries -----------------------------------------

test('handles US spring-forward DST (offset -300 -> -240)', () => {
  withDb((db) => {
    const before = evaluateLead(db, makeLead(db), { now: new Date('2026-03-08T06:59:00Z') });
    assert.equal(before.details.schedule.localHour, 1);
    assert.equal(before.details.schedule.utcOffsetMinutes, -300);

    const after = evaluateLead(db, makeLead(db), { now: new Date('2026-03-08T07:00:00Z') });
    assert.equal(after.details.schedule.localHour, 3); // 02:00 does not exist
    assert.equal(after.details.schedule.utcOffsetMinutes, -240);

    const open = evaluateLead(db, makeLead(db), { now: new Date('2026-03-08T12:00:00Z') });
    assert.equal(open.details.schedule.localHour, 8);
    assert.equal(open.decision, 'allowed');
  });
});

test('handles US fall-back DST (offset -240 -> -300)', () => {
  withDb((db) => {
    const first = evaluateLead(db, makeLead(db), { now: new Date('2026-11-01T05:00:00Z') });
    const second = evaluateLead(db, makeLead(db), { now: new Date('2026-11-01T06:00:00Z') });
    assert.equal(first.details.schedule.localHour, 1);
    assert.equal(second.details.schedule.localHour, 1);
    assert.equal(first.details.schedule.utcOffsetMinutes, -240);
    assert.equal(second.details.schedule.utcOffsetMinutes, -300);
    assert.equal(first.decision, 'blocked');
    assert.equal(second.decision, 'blocked');
  });
});

test('respects far-flung timezone boundaries (+14 and -11)', () => {
  withDb((db) => {
    const kiritimati = evaluateLead(db, makeLead(db, { timezone: 'Pacific/Kiritimati' }), {
      now: new Date('2026-06-15T12:00:00Z'),
    });
    assert.equal(kiritimati.details.schedule.localTime, '2026-06-16 02:00');
    assert.equal(kiritimati.decision, 'blocked');

    const midway = evaluateLead(db, makeLead(db, { timezone: 'Pacific/Midway' }), {
      now: new Date('2026-06-15T20:00:00Z'),
    });
    assert.equal(midway.details.schedule.localTime, '2026-06-15 09:00');
    assert.equal(midway.decision, 'allowed');
  });
});

test('evaluates UTC boundaries at 08:00 (open) and 21:00 (closed)', () => {
  withDb((db) => {
    const open = evaluateLead(db, makeLead(db, { timezone: 'UTC' }), { now: new Date('2026-06-15T08:00:00Z') });
    assert.equal(open.decision, 'allowed');
    const closed = evaluateLead(db, makeLead(db, { timezone: 'UTC' }), { now: new Date('2026-06-15T21:00:00Z') });
    assert.equal(closed.decision, 'blocked');
  });
});

// ---- HTTP endpoint --------------------------------------------------------

test('GET /api/leads/:id/compliance returns an allowed decision at a given time', async () => {
  await withServer(async (base) => {
    const { body } = await api(base, 'POST', '/api/leads', { ...BASE, timezone: 'UTC' });
    const res = await api(base, 'GET', `/api/leads/${body.data.id}/compliance?at=2026-06-15T13:00:00Z`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.decision, 'allowed');
    assert.equal(res.body.data.mayDial, true);
    assert.ok(res.body.data.disclaimer);
  });
});

test('GET /api/leads/:id/compliance blocks outside the window', async () => {
  await withServer(async (base) => {
    const { body } = await api(base, 'POST', '/api/leads', { ...BASE, timezone: 'UTC' });
    const res = await api(base, 'GET', `/api/leads/${body.data.id}/compliance?at=2026-06-15T03:00:00Z`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.decision, 'blocked');
    assert.ok(res.body.data.reasons.some((r) => r.code === 'outside_calling_window'));
  });
});

test('GET /api/leads/:id/compliance validates inputs', async () => {
  await withServer(async (base) => {
    const { body } = await api(base, 'POST', '/api/leads', BASE);
    const badAt = await api(base, 'GET', `/api/leads/${body.data.id}/compliance?at=not-a-date`);
    assert.equal(badAt.status, 400);
    assert.equal(badAt.body.error, 'invalid_at');

    const badId = await api(base, 'GET', '/api/leads/abc/compliance');
    assert.equal(badId.status, 400);
    assert.equal(badId.body.error, 'invalid_id');

    const missing = await api(base, 'GET', '/api/leads/999999/compliance');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, 'lead_not_found');
  });
});

test('GET /api/leads/:id/compliance works without an explicit time', async () => {
  await withServer(async (base) => {
    const { body } = await api(base, 'POST', '/api/leads', BASE);
    const res = await api(base, 'GET', `/api/leads/${body.data.id}/compliance`);
    assert.equal(res.status, 200);
    assert.ok(['allowed', 'review', 'blocked'].includes(res.body.data.decision));
    assert.ok(res.body.data.details.evaluatedAt);
  });
});
