import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer, api, raw } from '../test-support/helpers.js';

let phoneSeq = 0;
function nextPhone() {
  phoneSeq += 1;
  return `+1 555 02${String(1000 + phoneSeq).slice(-4)}`;
}

function zoneForLocalHour(hour) {
  const utcHour = new Date().getUTCHours();
  let offset = hour - utcHour;
  if (offset > 14) offset -= 24;
  if (offset < -12) offset += 24;
  return offset >= 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
}

async function createLead(base, overrides = {}) {
  const res = await api(base, 'POST', '/api/leads', {
    name: 'Queue Contact',
    phone: nextPhone(),
    company: 'Queue Co',
    timezone: zoneForLocalHour(12),
    consent: { status: 'recorded', evidence: 'signed form', source: 'web-form', date: '2026-08-01' },
    ...overrides,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
}

async function complete(base, id, disposition = 'Interested') {
  const res = await api(base, 'PUT', `/api/leads/${id}`, { status: 'completed', disposition });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data;
}

test('POST /api/leads/reset-queue returns completed leads to pending and clears disposition', async () => {
  await withServer(async (base) => {
    const lead = await createLead(base);
    await complete(base, lead.id);

    const res = await api(base, 'POST', '/api/leads/reset-queue');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data, { total: 1, reset: 1, blocked: 0 });

    const after = await api(base, 'GET', `/api/leads/${lead.id}`);
    assert.equal(after.body.data.status, 'pending');
    assert.equal(after.body.data.disposition, '');
  });
});

test('reset-queue leaves Do Not Call / suppressed contacts blocked, never pending', async () => {
  await withServer(async (base, db) => {
    const normal = await createLead(base);
    const suppressed = await createLead(base);
    await complete(base, normal.id);
    await complete(base, suppressed.id);
    db.prepare('UPDATE leads SET suppression_blocked = 1 WHERE id = ?').run(suppressed.id);

    const res = await api(base, 'POST', '/api/leads/reset-queue');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data, { total: 2, reset: 1, blocked: 1 });

    assert.equal((await api(base, 'GET', `/api/leads/${normal.id}`)).body.data.status, 'pending');
    assert.equal((await api(base, 'GET', `/api/leads/${suppressed.id}`)).body.data.status, 'blocked');
  });
});

test('reset-queue is a no-op when nothing is completed and still reports accurately', async () => {
  await withServer(async (base) => {
    await createLead(base);
    const res = await api(base, 'POST', '/api/leads/reset-queue');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data, { total: 0, reset: 0, blocked: 0 });
  });
});

test('reset-queue keeps a completed lead blocked when its phone is on the DNC list', async () => {
  await withServer(async (base, db) => {
    const lead = await createLead(base);
    await complete(base, lead.id);
    db.prepare('INSERT INTO dnc_entries (phone) VALUES (?)').run(lead.phone);

    const res = await api(base, 'POST', '/api/leads/reset-queue');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data, { total: 1, reset: 0, blocked: 1 });

    const after = await api(base, 'GET', `/api/leads/${lead.id}`);
    assert.equal(after.body.data.status, 'blocked');
    assert.equal(after.body.data.suppressed, true);

    const forced = await api(base, 'PUT', `/api/leads/${lead.id}`, { status: 'pending' });
    assert.equal(forced.status, 200);
    assert.equal(forced.body.data.status, 'blocked', 'a DNC suppressed lead can never be forced back to pending');
  });
});

test('reset-queue records an audit entry and requires a session', async () => {
  await withServer(async (base, db) => {
    const unauth = await raw(base, 'POST', '/api/leads/reset-queue');
    assert.equal(unauth.status, 401);

    const lead = await createLead(base);
    await complete(base, lead.id);
    await api(base, 'POST', '/api/leads/reset-queue');

    const row = db
      .prepare("SELECT * FROM audit_log WHERE action = 'queue_reset' ORDER BY id DESC LIMIT 1")
      .get();
    assert.ok(row, 'reset must be audited');
    assert.equal(JSON.parse(row.details).reset, 1);
  });
});

test('GET /api/settings reports the effective read-only server configuration', async () => {
  await withServer(async (base) => {
    const unauth = await raw(base, 'GET', '/api/settings');
    assert.equal(unauth.status, 401);

    const res = await api(base, 'GET', '/api/settings');
    assert.equal(res.status, 200);
    const cfg = res.body.data;
    assert.equal(cfg.readOnly, true);
    assert.equal(cfg.source, 'server');
    assert.equal(cfg.demoMode, true);
    assert.equal(cfg.telephony.enabled, false);
    assert.equal(cfg.telephony.liveEnabled, false);
    assert.equal(cfg.compliance.callWindowStart, '08:00');
    assert.equal(cfg.compliance.callWindowEnd, '21:00');
    assert.equal(typeof cfg.auth.sessionTtlHours, 'number');
    assert.equal(cfg.calls.maxAttemptMinutes, 240);
  });
});

test('GET /api/health/config reflects the live config, not the seeded settings table', async () => {
  await withServer(
    async (base) => {
      const res = await raw(base, 'GET', '/api/health/config');
      assert.equal(res.status, 200);
      assert.equal(res.body.demoMode, false);
      assert.equal(res.body.telephony.provider, 'test-provider');
      assert.equal(res.body.telephony.enabled, false);
      assert.equal(res.body.telephony.liveEnabled, false);
      assert.equal(res.body.database, 'connected');
    },
    undefined,
    { demoMode: false, telephony: { provider: 'test-provider' } },
  );
});

test('GET /api/calls/:id is scoped to the authenticated operator (no IDOR)', async () => {
  await withServer(async (base, db) => {
    const lead = await createLead(base);
    const attempt = await api(base, 'POST', '/api/calls/attempt', { leadId: lead.id });
    assert.equal(attempt.status, 201, JSON.stringify(attempt.body));
    const callId = attempt.body.data.call.id;

    const own = await api(base, 'GET', `/api/calls/${callId}`);
    assert.equal(own.status, 200);
    assert.equal(own.body.data.id, callId);

    const info = db
      .prepare("INSERT INTO users (username, password_hash, display_name) VALUES ('other-operator', 'x', 'Other')")
      .run();
    db.prepare('UPDATE calls SET user_id = ? WHERE id = ?').run(info.lastInsertRowid, callId);
    const foreign = await api(base, 'GET', `/api/calls/${callId}`);
    assert.equal(foreign.status, 404);
    assert.equal(foreign.body.error, 'call_not_found');
  });
});
