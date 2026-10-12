import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer } from '../test-support/helpers.js';

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

test('GET / serves the preserved original frontend HTML', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.ok(html.includes('<title>ApexDialer'), 'expected original ApexDialer title');
  });
});

test('unknown API route returns structured 404', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/nope`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error, 'not_found');
  });
});

test('server omits the x-powered-by header', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.headers.get('x-powered-by'), null);
  });
});