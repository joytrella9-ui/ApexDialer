import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer, api } from '../test-support/helpers.js';

test('GET /api/health reports ok', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.service, 'apexdialer-api');
  });
});

test('GET /api/health/config reports demo mode on and telephony off', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/health/config`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.demoMode, true);
    assert.equal(body.telephony.enabled, false);
    assert.equal(body.telephony.liveEnabled, false);
    assert.equal(body.database, 'connected');
  });
});

test('GET / serves the integrated frontend app', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.ok(html.includes('<title>ApexDialer'), 'expected ApexDialer title');
    assert.ok(html.includes('id="loginForm"'), 'expected login screen');
    assert.ok(html.includes('api/auth/me'), 'expected session check');
    assert.ok(html.includes('api/auth/config'), 'expected setup-config check');
  });
});

test('unknown API route requires authentication (401 unauthenticated, 404 when logged in)', async () => {
  await withServer(async (base) => {
    const unauth = await fetch(`${base}/api/nope`);
    assert.equal(unauth.status, 401);
    const unauthBody = await unauth.json();
    assert.equal(unauthBody.error, 'authentication_required');

    const authed = await api(base, 'GET', '/api/nope');
    assert.equal(authed.status, 404);
    assert.equal(authed.body.error, 'not_found');
  });
});

test('server omits the x-powered-by header', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.headers.get('x-powered-by'), null);
  });
});