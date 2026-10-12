import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer, api, raw } from '../test-support/helpers.js';

let phoneSeq = 0;
function nextPhone() {
  phoneSeq += 1;
  return `+1 555 01${String(1000 + phoneSeq).slice(-4)}`;
}

// Pick a fixed-offset IANA zone whose recipient-local time is `hour:00` right now.
// Etc/GMT zones have no DST, so the evaluation is deterministic regardless of when
// the suite runs. hour=12 lands inside the 08:00-21:00 window; hour=3 lands outside.
function zoneForLocalHour(hour) {
  const utcHour = new Date().getUTCHours();
  let offset = hour - utcHour;
  if (offset > 14) offset -= 24;
  if (offset < -12) offset += 24;
  return offset >= 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
}

async function createLead(base, overrides = {}) {
  const body = {
    name: 'Test Contact',
    phone: nextPhone(),
    company: 'Test Co',
    callType: 'sales',
    timezone: zoneForLocalHour(12),
    consent: { status: 'recorded', evidence: 'signed form', source: 'web-form', date: '2026-08-01' },
    ...overrides,
  };
  const res = await api(base, 'POST', '/api/leads', body);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
}

async function startAttempt(base, leadId) {
  const res = await api(base, 'POST', '/api/calls/attempt', { leadId });
  return res;
}

test('POST /api/calls/attempt starts an attempt on an allowed lead', async () => {
  await withServer(async (base) => {
    const lead = await createLead(base);
    const res = await startAttempt(base, lead.id);
    assert.equal(res.status, 201);
    const { call, lead: echoed, compliance } = res.body.data;
    assert.equal(call.status, 'in_progress');
    assert.equal(call.leadId, lead.id);
    assert.equal(call.direction, 'outbound');
    assert.equal(echoed.id, lead.id);
    assert.equal(compliance.decision, 'allowed');

    const active = await api(base, 'GET', '/api/calls/active');
    assert.equal(active.body.data.call.id, call.id);
    assert.equal(active.body.data.lead.id, lead.id);
    assert.equal(active.body.data.compliance.decision, 'allowed');
  });
});

test('attempt on a blocked lead returns 409 not_eligible and creates no call', async () => {
  await withServer(async (base) => {
    const lead = await createLead(base, {
      consent: { status: 'none', evidence: '', source: '', date: '' },
    });
    const res = await startAttempt(base, lead.id);
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'not_eligible');
    assert.equal(res.body.details.decision, 'blocked');
    assert.ok(Array.isArray(res.body.details.compliance.reasons));
    assert.ok(res.body.details.compliance.reasons.some((r) => r.code === 'missing_consent'));

    assert.equal((await api(base, 'GET', '/api/calls/active')).body.data, null);
    assert.equal((await api(base, 'GET', '/api/calls')).body.count, 0);
  });
});

test('attempt outside the calling window is refused (server re-check)', async () => {
  await withServer(async (base) => {
    const lead = await createLead(base, { timezone: zoneForLocalHour(3) });
    const res = await startAttempt(base, lead.id);
    assert.equal(res.status, 409);
    assert.equal(res.body.details.decision, 'blocked');
    assert.ok(res.body.details.compliance.reasons.some((r) => r.code === 'outside_calling_window'));
  });
});

test('a second concurrent attempt is refused with 409 attempt_in_progress (DB-backed)', async () => {
  await withServer(async (base, db) => {
    const a = await createLead(base);
    const b = await createLead(base);
    const first = await startAttempt(base, a.id);
    assert.equal(first.status, 201);

    const second = await startAttempt(base, b.id);
    assert.equal(second.status, 409);
    assert.equal(second.body.error, 'attempt_in_progress');
    assert.equal(second.body.details.callId, first.body.data.call.id);

    const uid = db.prepare('SELECT id FROM users LIMIT 1').get().id;
    assert.throws(
      () =>
        db
          .prepare(
            "INSERT INTO calls (lead_id, user_id, status, call_type, started_at) VALUES (?, ?, 'paused', 'sales', datetime('now'))"
          )
          .run(b.id, uid),
      /UNIQUE/i,
      'the partial unique index must reject a second active attempt'
    );
  });
});

test('ending an attempt without a disposition returns 400 disposition_required', async () => {
  await withServer(async (base) => {
    const lead = await createLead(base);
    const { call } = (await startAttempt(base, lead.id)).body.data;
    const res = await api(base, 'POST', `/api/calls/${call.id}/end`, {});
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'disposition_required');
    assert.equal((await api(base, 'GET', '/api/calls/active')).body.data.call.id, call.id);
  });
});

test('ending an attempt persists the call, updates the lead, and records events', async () => {
  await withServer(async (base) => {
    const lead = await createLead(base);
    const { call } = (await startAttempt(base, lead.id)).body.data;
    const res = await api(base, 'POST', `/api/calls/${call.id}/end`, {
      disposition: 'Interested',
      notes: 'call back tomorrow',
      durationSeconds: 42,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.call.status, 'completed');
    assert.equal(res.body.data.call.disposition, 'Interested');
    assert.equal(res.body.data.call.durationSeconds, 42);
    assert.equal(res.body.data.call.notes, 'call back tomorrow');
    assert.equal(res.body.data.lead.status, 'completed');
    assert.equal(res.body.data.lead.disposition, 'Interested');
    assert.equal((await api(base, 'GET', '/api/calls/active')).body.data, null);

    const detail = await api(base, 'GET', `/api/calls/${call.id}`);
    const types = detail.body.data.events.map((e) => e.type);
    for (const t of ['attempt_started', 'eligibility_allowed', 'disposition_recorded', 'attempt_ended']) {
      assert.ok(types.includes(t), `expected event ${t}`);
    }
  });
});

test('adding to DNC suppresses the lead and blocks future attempts', async () => {
  await withServer(async (base, db) => {
    const lead = await createLead(base);
    const { call } = (await startAttempt(base, lead.id)).body.data;
    const res = await api(base, 'POST', `/api/calls/${call.id}/end`, {
      disposition: 'Add to DNC',
      notes: 'asked to stop',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.lead.status, 'dnc');
    assert.equal(res.body.data.lead.suppressed, true);
    assert.equal(res.body.data.lead.eligible, false);
    assert.ok(db.prepare('SELECT COUNT(*) AS c FROM dnc_entries').get().c >= 1);

    const again = await startAttempt(base, lead.id);
    assert.equal(again.status, 409);
    assert.equal(again.body.details.decision, 'blocked');
  });
});

test('pause and resume transition status and reject invalid transitions', async () => {
  await withServer(async (base) => {
    const lead = await createLead(base);
    const { call } = (await startAttempt(base, lead.id)).body.data;

    const paused = await api(base, 'POST', `/api/calls/${call.id}/pause`);
    assert.equal(paused.status, 200);
    assert.equal(paused.body.data.call.status, 'paused');

    const pauseAgain = await api(base, 'POST', `/api/calls/${call.id}/pause`);
    assert.equal(pauseAgain.status, 409);
    assert.equal(pauseAgain.body.error, 'invalid_transition');

    const resumed = await api(base, 'POST', `/api/calls/${call.id}/resume`);
    assert.equal(resumed.body.data.call.status, 'in_progress');

    const resumeAgain = await api(base, 'POST', `/api/calls/${call.id}/resume`);
    assert.equal(resumeAgain.status, 409);
  });
});

test('aborting ends the active attempt without a disposition', async () => {
  await withServer(async (base) => {
    const lead = await createLead(base);
    const { call } = (await startAttempt(base, lead.id)).body.data;
    const res = await api(base, 'POST', `/api/calls/${call.id}/abort`, { reason: 'operator stopped' });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.call.status, 'aborted');
    assert.equal(res.body.data.call.disposition, '');
    assert.equal((await api(base, 'GET', '/api/calls/active')).body.data, null);

    const abortAgain = await api(base, 'POST', `/api/calls/${call.id}/abort`);
    assert.equal(abortAgain.status, 409);
  });
});

test('GET /api/calls/next returns the first eligible allowed lead and honors exclude', async () => {
  await withServer(async (base) => {
    const a = await createLead(base);
    const b = await createLead(base);

    const first = await api(base, 'GET', '/api/calls/next');
    assert.equal(first.body.data.lead.id, a.id);
    assert.equal(first.body.data.compliance.decision, 'allowed');

    const excluded = await api(base, 'GET', `/api/calls/next?exclude=${a.id}`);
    assert.equal(excluded.body.data.lead.id, b.id);

    const none = await api(base, 'GET', `/api/calls/next?exclude=${a.id},${b.id}`);
    assert.equal(none.body.data, null);
  });
});

test('the server re-checks eligibility when a lead becomes ineligible before dialing', async () => {
  await withServer(async (base) => {
    const lead = await createLead(base);
    await api(base, 'PUT', `/api/leads/${lead.id}`, { status: 'completed' });
    const res = await startAttempt(base, lead.id);
    assert.equal(res.status, 409);
    assert.equal(res.body.details.compliance.decision, 'blocked');
  });
});

test('calls require a session; stale active attempts auto-abort', async () => {
  await withServer(async (base, db) => {
    const lead = await createLead(base);
    const { call } = (await startAttempt(base, lead.id)).body.data;

    const unauth = await raw(base, 'GET', '/api/calls/active', {});
    assert.equal(unauth.status, 401);

    db.prepare("UPDATE calls SET started_at = datetime('now','-10 hours') WHERE id = ?").run(call.id);
    const active = await api(base, 'GET', '/api/calls/active');
    assert.equal(active.body.data, null);
    assert.equal(db.prepare('SELECT status FROM calls WHERE id = ?').get(call.id).status, 'aborted');
  });
});

test('GET /api/calls/:id returns the persisted call and validates the id', async () => {
  await withServer(async (base) => {
    const lead = await createLead(base);
    const { call } = (await startAttempt(base, lead.id)).body.data;

    const detail = await api(base, 'GET', `/api/calls/${call.id}`);
    assert.equal(detail.body.data.id, call.id);
    assert.ok(detail.body.data.events.length >= 2);

    assert.equal((await api(base, 'GET', '/api/calls/99999')).status, 404);
    assert.equal((await api(base, 'GET', '/api/calls/abc')).status, 400);
  });
});

test('POST /api/calls/skip audits and returns the next non-skipped lead', async () => {
  await withServer(async (base, db) => {
    const a = await createLead(base);
    const b = await createLead(base);
    const res = await api(base, 'POST', '/api/calls/skip', { leadId: a.id });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.lead.id, b.id);
    const audits = db
      .prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'lead_skipped'")
      .get().c;
    assert.ok(audits >= 1);
  });
});

test('attempt validates the payload and reports unknown leads', async () => {
  await withServer(async (base) => {
    assert.equal((await api(base, 'POST', '/api/calls/attempt', { leadId: 'x' })).status, 400);
    assert.equal((await api(base, 'POST', '/api/calls/attempt', {})).status, 400);
    assert.equal((await api(base, 'POST', '/api/calls/attempt', { leadId: 99999 })).status, 404);
  });
});
