import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { withServer, api, raw, cookieHeader } from '../test-support/helpers.js';
import { requiredRolesFor, ROLES, authorize } from '../src/middleware/policy.js';

const PASSWORD = 'correct horse battery staple';

const LEAD = {
  name: 'Policy Lead',
  phone: '5550199001',
  company: 'Policy Co',
  callType: 'existing-customer',
  timezone: 'UTC',
  consent: { status: 'none' },
  notes: '',
};

// Adds a user directly (there is no user-management API yet) and returns a session cookie.
async function sessionFor(base, db, username, role) {
  db.prepare('INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)').run(
    username,
    bcrypt.hashSync(PASSWORD, 4),
    username,
    role
  );
  const res = await raw(base, 'POST', '/api/auth/login', { body: { username, password: PASSWORD } });
  assert.equal(res.status, 200, `login failed for ${username}`);
  return cookieHeader(res.headers.get('set-cookie'));
}

test('policy table: destructive and control actions require supervisor or admin', () => {
  assert.deepEqual(requiredRolesFor('DELETE', '/leads/12'), ['admin', 'supervisor']);
  assert.deepEqual(requiredRolesFor('POST', '/leads/import'), ['admin', 'supervisor']);
  assert.deepEqual(requiredRolesFor('POST', '/leads/reset-queue'), ['admin', 'supervisor']);
  assert.deepEqual(requiredRolesFor('POST', '/campaigns/3/tick'), ['admin', 'supervisor']);
  assert.deepEqual(requiredRolesFor('POST', '/compliance/retention/execute'), ['admin']);
  assert.deepEqual(requiredRolesFor('PUT', '/compliance/campaigns/3'), ['admin', 'supervisor']);
  assert.equal(requiredRolesFor('GET', '/campaigns'), null);
  assert.equal(requiredRolesFor('POST', '/calls/attempt'), null);
  assert.ok(ROLES.includes('operator'));
});

test('operator can work leads and calls but not delete, bulk-import, or run campaigns', async () => {
  await withServer(async (base, db) => {
    const admin = await api(base, 'POST', '/api/leads', LEAD);
    assert.equal(admin.status, 201);
    const leadId = admin.body.data.id;

    const op = await sessionFor(base, db, 'ops', 'operator');

    const list = await api(base, 'GET', '/api/leads', undefined, { cookie: op });
    assert.equal(list.status, 200);

    const created = await api(base, 'POST', '/api/leads', { ...LEAD, phone: '5550199002' }, { cookie: op });
    assert.equal(created.status, 201);

    const del = await api(base, 'DELETE', `/api/leads/${leadId}`, undefined, { cookie: op });
    assert.equal(del.status, 403);
    assert.equal(del.body.error, 'forbidden');

    const reset = await api(base, 'POST', '/api/leads/reset-queue', undefined, { cookie: op });
    assert.equal(reset.status, 403);

    const imp = await api(base, 'POST', '/api/leads/import', 'name,phone\n', {
      cookie: op,
      contentType: 'text/csv',
    });
    assert.equal(imp.status, 403);

    const campaign = await api(base, 'POST', '/api/campaigns', { name: 'X' }, { cookie: op });
    assert.equal(campaign.status, 403);

    const campaignList = await api(base, 'GET', '/api/campaigns', undefined, { cookie: op });
    assert.equal(campaignList.status, 200);
  });
});

test('supervisor can delete leads and manage campaigns but not run retention', async () => {
  await withServer(async (base, db) => {
    const admin = await api(base, 'POST', '/api/leads', LEAD);
    const leadId = admin.body.data.id;
    const sup = await sessionFor(base, db, 'sup', 'supervisor');

    const del = await api(base, 'DELETE', `/api/leads/${leadId}`, undefined, { cookie: sup });
    assert.equal(del.status, 204);

    const campaign = await api(base, 'POST', '/api/campaigns', { name: 'Spring' }, { cookie: sup });
    assert.notEqual(campaign.status, 403);

    const retention = await api(base, 'POST', '/api/compliance/retention/execute', {}, { cookie: sup });
    assert.equal(retention.status, 403);
  });
});

test('admin keeps full access', async () => {
  await withServer(async (base) => {
    const created = await api(base, 'POST', '/api/leads', LEAD);
    assert.equal(created.status, 201);
    const del = await api(base, 'DELETE', `/api/leads/${created.body.data.id}`);
    assert.equal(del.status, 204);
    const campaign = await api(base, 'POST', '/api/campaigns', { name: 'Admin campaign' });
    assert.notEqual(campaign.status, 403);
  });
});

test('the database refuses unknown roles', async () => {
  await withServer(async (base, db) => {
    await api(base, 'GET', '/api/leads'); // ensures the admin account exists
    assert.throws(() =>
      db
        .prepare('INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)')
        .run('odd', bcrypt.hashSync(PASSWORD, 4), 'odd', 'auditor')
    );
  });
});

test('the authorize middleware denies an unknown role even if it reaches the request', () => {
  let status = null;
  let passed = false;
  const req = { method: 'GET', path: '/leads', auth: { user: { role: 'auditor' } } };
  authorize(req, {}, (err) => {
    if (err) status = err.status;
    else passed = true;
  });
  assert.equal(passed, false);
  assert.equal(status, 403);
});

test('unauthenticated requests are still rejected with 401', async () => {
  await withServer(async (base) => {
    const res = await api(base, 'GET', '/api/leads', undefined, { cookie: null, authenticated: false });
    assert.equal(res.status, 401);
  });
});
