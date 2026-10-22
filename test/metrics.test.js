import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { withServer, api, raw, cookieHeader } from '../test-support/helpers.js';
import { createMetrics } from '../src/lib/metrics.js';

test('createMetrics counts requests and status classes without recording paths or users', async () => {
  const m = createMetrics({ now: () => 1_000_000, memory: () => ({ rss: 2 * 1048576, heapUsed: 1048576 }) });
  const { EventEmitter } = await import('node:events');

  const fire = (status) => {
    const res = new EventEmitter();
    res.statusCode = status;
    let nextCalled = false;
    m.middleware({ method: 'GET', path: '/secret/path' }, res, () => (nextCalled = true));
    assert.equal(nextCalled, true);
    res.emit('finish');
    res.emit('close'); // a second terminal event must not double count
    return res;
  };

  fire(200);
  fire(404);
  fire(503);
  fire(302);

  const snap = m.snapshot();
  assert.equal(snap.requests.total, 4);
  assert.equal(snap.requests.inFlight, 0);
  assert.deepEqual(snap.requests.byStatusClass, { '2xx': 1, '3xx': 1, '4xx': 1, '5xx': 1, other: 0 });
  assert.equal(snap.memory.rssMb, 2);
  assert.equal(snap.memory.heapUsedMb, 1);
  assert.equal(JSON.stringify(snap).includes('secret'), false);
});

test('GET /api/settings/metrics is admin-only and returns counts', async () => {
  await withServer(async (base, db) => {
    const admin = await api(base, 'GET', '/api/settings/metrics');
    assert.equal(admin.status, 200);
    assert.ok(admin.body.data.requests.total >= 1);
    assert.ok(Number.isInteger(admin.body.data.uptimeSeconds));

    db.prepare('INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)').run(
      'ops2',
      bcrypt.hashSync('correct horse battery staple', 4),
      'ops2',
      'operator'
    );
    const login = await raw(base, 'POST', '/api/auth/login', {
      body: { username: 'ops2', password: 'correct horse battery staple' },
    });
    const cookie = cookieHeader(login.headers.get('set-cookie'));
    const op = await api(base, 'GET', '/api/settings/metrics', undefined, { cookie });
    assert.equal(op.status, 403);
  });
});

test('metrics endpoint requires sign-in', async () => {
  await withServer(async (base) => {
    const res = await api(base, 'GET', '/api/settings/metrics', undefined, { cookie: null, authenticated: false });
    assert.equal(res.status, 401);
  });
});
