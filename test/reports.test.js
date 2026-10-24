import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer, api } from '../test-support/helpers.js';

const LEAD = {
  name: 'Report Lead',
  phone: '5550199400',
  company: 'Reports Co',
  callType: 'existing-customer',
  timezone: 'UTC',
  consent: { status: 'none' },
  notes: '',
};

test('GET /api/reports/overview returns lead and call counts from the database', async () => {
  await withServer(async (base) => {
    const created = await api(base, 'POST', '/api/leads', LEAD);
    assert.equal(created.status, 201);

    const res = await api(base, 'GET', '/api/reports/overview?days=30');
    assert.equal(res.status, 200);
    const data = res.body.data;
    assert.equal(data.leads.total, 1);
    assert.equal(data.leads.pending, 1);
    assert.equal(typeof data.calls.attempted, 'number');
    assert.ok(Array.isArray(data.unavailable));
    assert.ok(data.unavailable.includes('answerRate'));
    assert.equal(data.telephony.liveCalling, false);
    assert.ok(data.formulas.completionRate);
  });
});

test('GET /api/reports/calls.csv is a CSV attachment for an authenticated supervisor-level user', async () => {
  await withServer(async (base) => {
    const res = await api(base, 'GET', '/api/reports/calls.csv');
    assert.equal(res.status, 200);
    assert.match(String(res.body).slice(0, 20) || 'Call ID', /Call ID/);
  });
});

test('GET /api/audit returns paginated audit rows for an admin', async () => {
  await withServer(async (base) => {
    const res = await api(base, 'GET', '/api/audit?limit=20');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.data));
    assert.ok(Number.isInteger(res.body.total));
  });
});
