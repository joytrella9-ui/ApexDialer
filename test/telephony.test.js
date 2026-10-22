import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { withServer, api, raw } from '../test-support/helpers.js';
import { signatureBase } from '../src/providers/twilio.js';

const SECRET = 'test-webhook-secret';
const WEBHOOK_PATH = '/api/telephony/webhooks/twilio';

let sidSeq = 0;
function nextSid() {
  sidSeq += 1;
  return `CA${String(sidSeq).padStart(32, '0')}`;
}

function zoneForLocalHour(hour) {
  const utcHour = new Date().getUTCHours();
  let offset = hour - utcHour;
  if (offset > 14) offset -= 24;
  if (offset < -12) offset += 24;
  return offset >= 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
}

async function seedCall(base, db) {
  const lead = await api(base, 'POST', '/api/leads', {
    name: 'Webhook Contact',
    phone: `+1 555 02${String(1000 + sidSeq).slice(-4)}`,
    callType: 'sales',
    timezone: zoneForLocalHour(12),
    consent: { status: 'recorded', evidence: 'signed form', source: 'web-form', date: '2026-08-01' },
  });
  const started = await api(base, 'POST', '/api/calls/attempt', { leadId: lead.body.data.id });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const callId = started.body.data.call.id;
  const sid = nextSid();
  db.prepare('UPDATE calls SET provider_call_sid = ? WHERE id = ?').run(sid, callId);
  return { leadId: lead.body.data.id, callId, sid };
}

function sign(url, params, secret = SECRET) {
  return createHmac('sha1', secret).update(signatureBase(url, params)).digest('base64');
}

async function webhook(base, params, { secret = SECRET, signature, omitSignature = false } = {}) {
  const url = `${base}${WEBHOOK_PATH}`;
  const body = new URLSearchParams(params).toString();
  const headers = {};
  if (!omitSignature) headers['x-twilio-signature'] = signature ?? sign(url, params, secret);
  return raw(base, 'POST', WEBHOOK_PATH, {
    body,
    contentType: 'application/x-www-form-urlencoded',
    headers,
  });
}

const enabled = { telephony: { enabled: true, provider: 'twilio', webhookSecret: SECRET } };

test('signed provider status callbacks drive the call to completed and are recorded', async () => {
  await withServer(
    async (base, db) => {
      const { callId, sid } = await seedCall(base, db);

      const initiated = await webhook(base, { CallSid: sid, CallStatus: 'initiated' });
      assert.equal(initiated.status, 200);
      assert.equal(initiated.body.data.type, 'applied');
      assert.equal(initiated.body.data.status, 'in_progress');

      const completed = await webhook(base, {
        CallSid: sid,
        CallStatus: 'completed',
        To: '+15550200100',
        From: '+15550200999',
      });
      assert.equal(completed.status, 200);
      assert.equal(completed.body.data.type, 'applied');
      assert.equal(completed.body.data.status, 'completed');

      const row = db.prepare('SELECT status, ended_at FROM calls WHERE id = ?').get(callId);
      assert.equal(row.status, 'completed');
      assert.ok(row.ended_at, 'ended_at must be set on a terminal provider event');

      const events = db
        .prepare("SELECT COUNT(*) AS c FROM call_events WHERE call_id = ? AND event_type = 'provider_status'")
        .get(callId).c;
      assert.equal(events, 2, 'both applied callbacks append a provider_status event');

      const audits = db
        .prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'provider_status' AND actor = 'provider'")
        .get().c;
      assert.equal(audits, 2);

      const stored = db.prepare('SELECT COUNT(*) AS c FROM provider_events WHERE call_id = ?').get(callId).c;
      assert.equal(stored, 2, 'both callbacks must be journaled');

      const detail = await api(base, 'GET', `/api/calls/${callId}`);
      assert.ok(detail.body.data.events.some((e) => e.type === 'provider_status'));
    },
    undefined,
    enabled
  );
});

test('a duplicated provider event is ignored (idempotent webhooks)', async () => {
  await withServer(
    async (base, db) => {
      const { callId, sid } = await seedCall(base, db);
      const params = { CallSid: sid, CallStatus: 'completed' };

      const first = await webhook(base, params);
      assert.equal(first.body.data.type, 'applied');
      const second = await webhook(base, params);
      assert.equal(second.status, 200);
      assert.equal(second.body.data.type, 'ignored');
      assert.equal(second.body.data.reason, 'duplicate');

      const stored = db.prepare('SELECT COUNT(*) AS c FROM provider_events WHERE call_id = ?').get(callId).c;
      assert.equal(stored, 1);
    },
    undefined,
    enabled
  );
});

test('a bad signature is rejected with 401 invalid_signature', async () => {
  await withServer(
    async (base, db) => {
      const { sid } = await seedCall(base, db);
      const res = await webhook(
        base,
        { CallSid: sid, CallStatus: 'completed' },
        { signature: 'not-a-valid-signature' }
      );
      assert.equal(res.status, 401);
      assert.equal(res.body.error, 'invalid_signature');
    },
    undefined,
    enabled
  );
});

test('an unsigned webhook is rejected', async () => {
  await withServer(
    async (base, db) => {
      const { sid } = await seedCall(base, db);
      const res = await webhook(base, { CallSid: sid, CallStatus: 'completed' }, { omitSignature: true });
      assert.equal(res.status, 401);
      assert.equal(res.body.error, 'invalid_signature');
    },
    undefined,
    enabled
  );
});

test('an event for an unknown call sid is acknowledged but ignored', async () => {
  await withServer(
    async (base) => {
      const res = await webhook(base, { CallSid: 'CA-does-not-exist', CallStatus: 'completed' });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.type, 'ignored');
      assert.equal(res.body.data.reason, 'call_not_found');
    },
    undefined,
    enabled
  );
});

test('an unmapped status is journaled without changing the call', async () => {
  await withServer(
    async (base, db) => {
      const { callId, sid } = await seedCall(base, db);
      const res = await webhook(base, { CallSid: sid, CallStatus: 'stale' });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.type, 'recorded');
      assert.equal(res.body.data.reason, 'unknown_status');
      assert.equal(db.prepare('SELECT status FROM calls WHERE id = ?').get(callId).status, 'in_progress');
    },
    undefined,
    enabled
  );
});

test('a completed call cannot be reopened by a later in-progress callback', async () => {
  await withServer(
    async (base, db) => {
      const { callId, sid } = await seedCall(base, db);
      await webhook(base, { CallSid: sid, CallStatus: 'completed' });

      const res = await webhook(base, { CallSid: sid, CallStatus: 'ringing' });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.type, 'ignored');
      assert.equal(res.body.data.reason, 'call_terminal');
      assert.equal(db.prepare('SELECT status FROM calls WHERE id = ?').get(callId).status, 'completed');
    },
    undefined,
    enabled
  );
});

test('the webhook route is absent when telephony is disabled', async () => {
  await withServer(async (base) => {
    const res = await webhook(base, { CallSid: 'CA-whatever', CallStatus: 'completed' });
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'not_found');
  });
});

test('an enabled webhook without a secret is refused with 403 provider_disabled', async () => {
  await withServer(
    async (base) => {
      const res = await webhook(base, { CallSid: 'CA-whatever', CallStatus: 'completed' });
      assert.equal(res.status, 403);
      assert.equal(res.body.error, 'provider_disabled');
    },
    undefined,
    { telephony: { enabled: true, provider: 'twilio', webhookSecret: '' } }
  );
});

test('the webhook secret is never exposed by settings or health config', async () => {
  await withServer(
    async (base) => {
      const settings = await api(base, 'GET', '/api/settings');
      assert.equal(settings.status, 200);
      assert.ok(!JSON.stringify(settings.body).includes(SECRET));

      const health = await raw(base, 'GET', '/api/health/config');
      assert.ok(!JSON.stringify(health.body).includes(SECRET));
      assert.equal(health.body.telephony.enabled, true);
      assert.equal(health.body.telephony.liveEnabled, false);
    },
    undefined,
    enabled
  );
});
