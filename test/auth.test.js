import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer, raw, cookieHeader } from '../test-support/helpers.js';
import { createDb } from '../src/db/db.js';
import { hashToken } from '../src/lib/sessions.js';

const OP = { username: 'operator', password: 'correct horse battery staple', displayName: 'Demo Operator' };
const NEW_PASSWORD = 'a totally new passphrase 42';
const SHORT_PASSWORD = 'short';

async function setup(base, creds = OP) {
  return raw(base, 'POST', '/api/auth/setup', { body: creds });
}

async function login(base, creds = OP) {
  const res = await raw(base, 'POST', '/api/auth/login', { body: creds });
  return { ...res, cookie: cookieHeader(res.headers.get('set-cookie')) };
}

// ---- setup -----------------------------------------------------------------

test('first-run setup creates an operator account (no password returned)', async () => {
  await withServer(async (base) => {
    const res = await setup(base);
    assert.equal(res.status, 201);
    assert.equal(res.body.data.operator.username, 'operator');
    assert.equal(res.body.data.operator.displayName, 'Demo Operator');
    assert.equal(res.body.data.operator.role, 'admin');
    assert.ok(Number.isInteger(res.body.data.operator.id));
    assert.equal('password' in res.body.data.operator, false);
    assert.equal('password_hash' in res.body.data.operator, false);
  });
});

test('setup is refused once an operator exists', async () => {
  await withServer(async (base) => {
    assert.equal((await setup(base)).status, 201);
    const second = await setup(base, { username: 'second', password: NEW_PASSWORD });
    assert.equal(second.status, 409);
    assert.equal(second.body.error, 'operator_exists');
  });
});

test('setup rejects weak or malformed credentials', async () => {
  await withServer(async (base) => {
    const weak = await setup(base, { username: 'operator', password: SHORT_PASSWORD });
    assert.equal(weak.status, 400);
    assert.equal(weak.body.error, 'validation_error');

    const badUser = await setup(base, { username: 'bad user!', password: NEW_PASSWORD });
    assert.equal(badUser.status, 400);
    assert.equal(badUser.body.error, 'validation_error');
  });
});

test('GET /api/auth/config is public and reports setup status', async () => {
  await withServer(async (base) => {
    const before = await raw(base, 'GET', '/api/auth/config');
    assert.equal(before.status, 200);
    assert.equal(before.body.setupRequired, true);

    await setup(base);
    const after = await raw(base, 'GET', '/api/auth/config');
    assert.equal(after.body.setupRequired, false);
    assert.ok(after.body.sessionTtlHours > 0);
  });
});

// ---- login / logout --------------------------------------------------------

test('login succeeds and sets a secure session cookie', async () => {
  await withServer(async (base, db) => {
    await setup(base);
    const res = await login(base);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.operator.username, 'operator');
    assert.ok(res.body.data.expiresAt);
    assert.equal('password_hash' in res.body.data.operator, false);

    const setCookie = res.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=strict/i);
    assert.match(setCookie, /Max-Age=/i);

    const token = res.cookie.split('=')[1];
    const rows = db.prepare('SELECT token_hash FROM sessions').all();
    assert.equal(rows.length, 1);
    assert.ok(rows.every((r) => r.token_hash === hashToken(token) && r.token_hash !== token));
  });
});

test('login returns an identical generic error for wrong password or wrong username', async () => {
  await withServer(async (base) => {
    await setup(base);
    const wrongPass = await login(base, { username: 'operator', password: 'wrong wrong wrong wrong' });
    const wrongUser = await login(base, { username: 'nosuchuser', password: OP.password });
    assert.equal(wrongPass.status, 401);
    assert.equal(wrongUser.status, 401);
    assert.equal(wrongPass.body.error, 'invalid_credentials');
    assert.equal(wrongUser.body.error, 'invalid_credentials');
    assert.deepEqual(wrongPass.body, wrongUser.body);
  });
});

test('logout invalidates the current session', async () => {
  await withServer(async (base) => {
    await setup(base);
    const { cookie } = await login(base);
    assert.equal((await raw(base, 'GET', '/api/leads', { cookie })).status, 200);

    const out = await raw(base, 'POST', '/api/auth/logout', { cookie });
    assert.equal(out.status, 204);

    const after = await raw(base, 'GET', '/api/leads', { cookie });
    assert.equal(after.status, 401);
  });
});

test('logout without a valid session still returns 204', async () => {
  await withServer(async (base) => {
    const out = await raw(base, 'POST', '/api/auth/logout');
    assert.equal(out.status, 204);
  });
});

test('GET /api/auth/me returns the operator for a valid session and 401 otherwise', async () => {
  await withServer(async (base) => {
    await setup(base);
    const anon = await raw(base, 'GET', '/api/auth/me');
    assert.equal(anon.status, 401);

    const { cookie } = await login(base);
    const me = await raw(base, 'GET', '/api/auth/me', { cookie });
    assert.equal(me.status, 200);
    assert.equal(me.body.data.operator.username, 'operator');
    assert.ok(me.body.data.expiresAt);
  });
});

// ---- protected endpoints----------------------------------------------------

test('unauthenticated requests cannot read or write leads', async () => {
  await withServer(async (base) => {
    await setup(base);
    const list = await raw(base, 'GET', '/api/leads');
    assert.equal(list.status, 401);
    assert.equal(list.body.error, 'authentication_required');

    const create = await raw(base, 'POST', '/api/leads', { body: { name: 'X', phone: '5550100001' } });
    assert.equal(create.status, 401);

    const exportCsv = await raw(base, 'GET', '/api/leads/export');
    assert.equal(exportCsv.status, 401);

    const compliance = await raw(base, 'GET', '/api/leads/1/compliance');
    assert.equal(compliance.status, 401);
  });
});

test('authenticated requests can read and write leads', async () => {
  await withServer(async (base) => {
    await setup(base);
    const { cookie } = await login(base);
    const created = await raw(base, 'POST', '/api/leads', { body: { name: 'X', phone: '5550100001' }, cookie });
    assert.equal(created.status, 201);
    const list = await raw(base, 'GET', '/api/leads', { cookie });
    assert.equal(list.status, 200);
    assert.equal(list.body.count, 1);
  });
});

test('garbage or forged session cookies are rejected', async () => {
  await withServer(async (base) => {
    await setup(base);
    const res = await raw(base, 'GET', '/api/leads', { cookie: 'apexdialer_session=garbage-value' });
    assert.equal(res.status, 401);
  });
});

test('expired sessions are rejected', async () => {
  await withServer(async (base, db) => {
    const setupRes = await setup(base);
    const userId = setupRes.body.data.operator.id;
    const token = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    db.prepare(
      "INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (?, ?, datetime('now', '-1 hours'))"
    ).run(userId, hashToken(token));

    const res = await raw(base, 'GET', '/api/leads', { cookie: `apexdialer_session=${token}` });
    assert.equal(res.status, 401);
  });
});

// ---- password change -------------------------------------------------------

test('operator can change their password; old password stops working', async () => {
  await withServer(async (base) => {
    await setup(base);
    const { cookie } = await login(base);

    const change = await raw(base, 'PUT', '/api/auth/password', {
      body: { currentPassword: OP.password, newPassword: NEW_PASSWORD },
      cookie,
    });
    assert.equal(change.status, 200);
    assert.equal(change.body.data.changed, true);

    const oldLogin = await login(base, { username: OP.username, password: OP.password });
    assert.equal(oldLogin.status, 401);
    const newLogin = await login(base, { username: OP.username, password: NEW_PASSWORD });
    assert.equal(newLogin.status, 200);
  });
});

test('password change requires the current password', async () => {
  await withServer(async (base) => {
    await setup(base);
    const { cookie } = await login(base);
    const res = await raw(base, 'PUT', '/api/auth/password', {
      body: { currentPassword: 'wrong-current-pass', newPassword: NEW_PASSWORD },
      cookie,
    });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'invalid_credentials');
  });
});

// ---- rate limiting ---------------------------------------------------------

test('login failures are rate limited and recover after a successful login', async () => {
  await withServer(
    async (base) => {
      await setup(base);
      const fail = { username: OP.username, password: 'wrong wrong wrong wrong' };

      for (let i = 0; i < 3; i++) {
        const res = await raw(base, 'POST', '/api/auth/login', { body: fail });
        assert.equal(res.status, 401);
        assert.equal(res.body.error, 'invalid_credentials');
      }

      const blocked = await raw(base, 'POST', '/api/auth/login', { body: fail });
      assert.equal(blocked.status, 429);
      assert.equal(blocked.body.error, 'too_many_attempts');
      assert.ok(blocked.headers.get('retry-after'));

      const good = await raw(base, 'POST', '/api/auth/login', { body: OP });
      assert.equal(good.status, 200);

      for (let i = 0; i < 3; i++) {
        const res = await raw(base, 'POST', '/api/auth/login', { body: fail });
        assert.equal(res.status, 401);
      }
      const blockedAgain = await raw(base, 'POST', '/api/auth/login', { body: fail });
      assert.equal(blockedAgain.status, 429);
    },
    createDb(':memory:'),
    { auth: { loginFailureMax: 3, loginMaxPerIp: 100 } }
  );
});

// ---- CSRF / origin ---------------------------------------------------------

test('state-changing requests from a foreign origin are rejected', async () => {
  await withServer(async (base) => {
    await setup(base);
    const { cookie } = await login(base);

    const evil = await raw(base, 'POST', '/api/leads', {
      body: { name: 'X', phone: '5550100001' },
      cookie,
      headers: { origin: 'http://evil.example' },
    });
    assert.equal(evil.status, 403);
    assert.equal(evil.body.error, 'cross_origin_forbidden');

    const same = await raw(base, 'POST', '/api/leads', {
      body: { name: 'X', phone: '5550100001' },
      cookie,
      headers: { origin: base },
    });
    assert.equal(same.status, 201);
  });
});