import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer, api, raw, cookieHeader } from '../test-support/helpers.js';
import { createDb } from '../src/db/db.js';
import { setupOperator } from '../src/services/auth.js';
import { createUser, updateUser, listUsers } from '../src/services/users.js';

const PASSWORD = 'correct horse battery staple';
const ROUNDS = 4;

async function loginAs(base, username, password = PASSWORD) {
  const res = await raw(base, 'POST', '/api/auth/login', { body: { username, password } });
  return { status: res.status, cookie: cookieHeader(res.headers.get('set-cookie')) };
}

test('admin can create users with a role and the password is never returned', async () => {
  await withServer(async (base) => {
    const created = await api(base, 'POST', '/api/users', {
      username: 'agent1',
      password: PASSWORD,
      displayName: 'Agent One',
      role: 'supervisor',
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.data.role, 'supervisor');
    assert.equal(created.body.data.disabled, false);
    assert.equal('password_hash' in created.body.data, false);
    assert.equal('password' in created.body.data, false);

    const list = await api(base, 'GET', '/api/users');
    assert.equal(list.status, 200);
    assert.ok(list.body.data.some((u) => u.username === 'agent1'));
    assert.equal(JSON.stringify(list.body).includes('password'), false);
  });
});

test('new users default to the operator role and duplicate usernames are refused', async () => {
  await withServer(async (base) => {
    const created = await api(base, 'POST', '/api/users', { username: 'agent2', password: PASSWORD });
    assert.equal(created.status, 201);
    assert.equal(created.body.data.role, 'operator');

    const dup = await api(base, 'POST', '/api/users', { username: 'agent2', password: PASSWORD });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error, 'username_taken');
  });
});

test('invalid role and weak passwords are rejected', async () => {
  await withServer(async (base) => {
    const badRole = await api(base, 'POST', '/api/users', { username: 'x1', password: PASSWORD, role: 'root' });
    assert.equal(badRole.status, 400);

    const weak = await api(base, 'POST', '/api/users', { username: 'x2', password: 'short' });
    assert.equal(weak.status, 400);
  });
});

test('operators and supervisors cannot manage users', async () => {
  await withServer(async (base) => {
    await api(base, 'POST', '/api/users', { username: 'opx', password: PASSWORD, role: 'operator' });
    const op = await loginAs(base, 'opx');
    assert.equal(op.status, 200);

    const list = await api(base, 'GET', '/api/users', undefined, { cookie: op.cookie });
    assert.equal(list.status, 403);
    const create = await api(base, 'POST', '/api/users', { username: 'y', password: PASSWORD }, { cookie: op.cookie });
    assert.equal(create.status, 403);
  });
});

test('an admin cannot change their own role or disable themselves', async () => {
  await withServer(async (base) => {
    const me = await api(base, 'GET', '/api/auth/me');
    const id = me.body.data.operator.id;

    const demote = await api(base, 'PATCH', `/api/users/${id}`, { role: 'operator' });
    assert.equal(demote.status, 409);
    assert.equal(demote.body.error, 'cannot_modify_self');

    const disable = await api(base, 'PATCH', `/api/users/${id}`, { disabled: true });
    assert.equal(disable.status, 409);
    assert.equal(disable.body.error, 'cannot_modify_self');
  });
});

test('changing a role is audited and takes effect for the target user', async () => {
  await withServer(async (base, db) => {
    const created = await api(base, 'POST', '/api/users', { username: 'agent3', password: PASSWORD });
    const id = created.body.data.id;

    const res = await api(base, 'PATCH', `/api/users/${id}`, { role: 'supervisor' });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.role, 'supervisor');

    const row = db.prepare("SELECT actor, details FROM audit_log WHERE action = 'user_role_changed'").get();
    assert.ok(row);
    assert.equal(row.actor, 'test-operator');
    assert.deepEqual(JSON.parse(row.details), { from: 'operator', to: 'supervisor' });
  });
});

test('disabling a user ends their sessions and blocks sign-in until re-enabled', async () => {
  await withServer(async (base) => {
    const created = await api(base, 'POST', '/api/users', { username: 'agent4', password: PASSWORD });
    const id = created.body.data.id;

    const session = await loginAs(base, 'agent4');
    assert.equal(session.status, 200);
    const before = await api(base, 'GET', '/api/leads', undefined, { cookie: session.cookie });
    assert.equal(before.status, 200);

    const off = await api(base, 'PATCH', `/api/users/${id}`, { disabled: true });
    assert.equal(off.status, 200);
    assert.equal(off.body.data.disabled, true);

    const after = await api(base, 'GET', '/api/leads', undefined, { cookie: session.cookie });
    assert.equal(after.status, 401, 'existing session must stop working immediately');

    assert.equal((await loginAs(base, 'agent4')).status, 401, 'disabled users cannot sign in');

    const on = await api(base, 'PATCH', `/api/users/${id}`, { disabled: false });
    assert.equal(on.body.data.disabled, false);
    assert.equal((await loginAs(base, 'agent4')).status, 200);
  });
});

test('unknown user ids and bad ids return proper errors', async () => {
  await withServer(async (base) => {
    assert.equal((await api(base, 'PATCH', '/api/users/abc', { role: 'operator' })).status, 400);
    const missing = await api(base, 'PATCH', '/api/users/999999', { role: 'operator' });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, 'user_not_found');
    const empty = await api(base, 'PATCH', '/api/users/1', {});
    assert.equal(empty.status, 400);
  });
});

test('the last enabled admin can never be demoted or disabled by another user', () => {
  const db = createDb(':memory:');
  try {
    const admin1 = setupOperator(db, { username: 'admin1', password: PASSWORD }, { bcryptRounds: ROUNDS });
    const admin2 = createUser(db, 'admin1', { username: 'admin2', password: PASSWORD, role: 'admin' }, { bcryptRounds: ROUNDS });

    // admin1 disables admin2: allowed, admin1 is still an active admin.
    updateUser(db, 'admin1', { targetId: admin2.id, actorId: admin1.id }, { disabled: true });

    // admin2 is disabled, so admin1 is the only active admin. Demoting admin1 from
    // a different acting user must be refused.
    assert.throws(
      () => updateUser(db, 'someone', { targetId: admin1.id, actorId: 999 }, { role: 'operator' }),
      (err) => err.status === 409 && err.message === 'last_admin'
    );
    assert.equal(listUsers(db).find((u) => u.id === admin1.id).role, 'admin');
  } finally {
    db.close();
  }
});
