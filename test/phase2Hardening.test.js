import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { withServer, api, raw } from '../test-support/helpers.js';
import { createDb } from '../src/db/db.js';
import { createSession } from '../src/lib/sessions.js';
import { mergeConfig } from '../src/app.js';
import { buildReadinessReport } from '../src/services/readiness.js';
import { buildConnectStreamTwiml, assertPublicWssUrl, xmlEscape } from '../src/providers/twilioTwiml.js';
import { RETENTION_CONFIRM } from '../src/services/transcriptRetention.js';

// Offline only: temporary/in-memory databases, injected config, no provider calls.

function addUserWithRole(db, username, role) {
  const hash = bcrypt.hashSync('e2e-only-password-value', 4);
  db.prepare("INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)").run(username, hash, username, role);
  const userId = db.prepare('SELECT id FROM users WHERE username = ?').get(username).id;
  return createSession(db, userId, { ttlHours: 1 }).token;
}

// ---- role enforcement on retention --------------------------------------------

test('retention preview is limited to admin and supervisor; operators are refused (403)', async () => {
  await withServer(async (base, db) => {
    const operatorToken = addUserWithRole(db, 'floor-operator', 'operator');
    const supervisorToken = addUserWithRole(db, 'floor-supervisor', 'supervisor');
    const cookie = (token) => `apexdialer_session=${token}`;

    const op = await raw(base, 'GET', '/api/compliance/retention', { cookie: cookie(operatorToken) });
    assert.equal(op.status, 403);
    assert.equal(op.body.error, 'forbidden');

    const sup = await raw(base, 'GET', '/api/compliance/retention', { cookie: cookie(supervisorToken) });
    assert.equal(sup.status, 200);
  });
});

test('retention execution is admin-only: supervisors and operators cannot delete, even with the token', async () => {
  await withServer(async (base, db) => {
    const operatorToken = addUserWithRole(db, 'op-two', 'operator');
    const supervisorToken = addUserWithRole(db, 'sup-two', 'supervisor');
    const body = { confirm: RETENTION_CONFIRM, expectedTotal: 0 };
    for (const token of [operatorToken, supervisorToken]) {
      const res = await raw(base, 'POST', '/api/compliance/retention/execute', {
        body,
        cookie: `apexdialer_session=${token}`,
      });
      assert.equal(res.status, 403, 'non-admin execution refused before any work');
    }
    const adminToken = addUserWithRole(db, 'admin-owner', 'admin');
    const admin = await raw(base, 'POST', '/api/compliance/retention/execute', {
      body,
      cookie: `apexdialer_session=${adminToken}`,
    });
    assert.equal(admin.status, 200, JSON.stringify(admin.body));
  });
});

test('an unauthenticated retention request is refused before any role check', async () => {
  await withServer(async (base) => {
    const res = await raw(base, 'POST', '/api/compliance/retention/execute', { body: { confirm: RETENTION_CONFIRM } });
    assert.equal(res.status, 401);
  });
});

// ---- readiness report ---------------------------------------------------------

const SECRET_VALUE = 'SUPER-SECRET-VALUE-do-not-print-0123';

test('default readiness is never live-ready and names every blocker', () => {
  const report = buildReadinessReport(mergeConfig({}), {}, { dbOk: true });
  assert.equal(report.readyForLive, false);
  assert.equal(report.liveAuthorized, false);
  assert.equal(report.demoReady, true);
  for (const id of ['live_calling', 'media_stream_endpoint', 'public_base_url', 'gpt_live_backend_model']) {
    assert.ok(report.blockers.includes(id), `blocker ${id} reported`);
  }
  const recording = report.checks.find((c) => c.id === 'recording');
  assert.equal(recording.status, 'ok');
  assert.equal(report.secretsIncluded, false);
});

test('readiness lists credential NAMES only and never reveals values', () => {
  const env = { APEX_TWILIO_ACCOUNT_SID: SECRET_VALUE, APEX_TWILIO_AUTH_TOKEN: SECRET_VALUE };
  const cfg = mergeConfig({ voice: { provider: 'twilio', webhookSecret: SECRET_VALUE } });
  const report = buildReadinessReport(cfg, env, { dbOk: true });
  const creds = report.checks.find((c) => c.id === 'provider_credentials');
  assert.equal(creds.status, 'blocker');
  assert.match(creds.message, /APEX_TWILIO_FROM_NUMBER/);
  assert.ok(!JSON.stringify(report).includes(SECRET_VALUE), 'no secret value anywhere in the report');
  assert.equal(report.readyForLive, false);
  assert.equal(report.demoReady, false, 'an unimplemented provider is not demo-ready');
});

test('an https public origin and backend model clear those checks but never make the build live-ready', () => {
  const cfg = mergeConfig({
    publicBaseUrl: 'https://apex.example.com',
    voice: { liveBackendModel: 'backend-model-x' },
  });
  const report = buildReadinessReport(cfg, {}, { dbOk: true });
  assert.ok(!report.blockers.includes('public_base_url'));
  assert.ok(!report.blockers.includes('gpt_live_backend_model'));
  assert.ok(report.blockers.includes('media_stream_endpoint'));
  assert.equal(report.readyForLive, false);
});

test('a failed database check is reported as a blocker and removes demo readiness', () => {
  const report = buildReadinessReport(mergeConfig({}), {}, { dbOk: false });
  assert.ok(report.blockers.includes('database'));
  assert.equal(report.demoReady, false);
});

test('GET /api/settings/readiness requires authentication and returns the secret-free report', async () => {
  await withServer(async (base) => {
    const anon = await raw(base, 'GET', '/api/settings/readiness');
    assert.equal(anon.status, 401);
    const res = await api(base, 'GET', '/api/settings/readiness');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.readyForLive, false);
    assert.equal(res.body.data.secretsIncluded, false);
    assert.ok(Array.isArray(res.body.data.checks) && res.body.data.checks.length >= 10);
  });
});

// ---- TwiML <Connect><Stream> ----------------------------------------------------

test('buildConnectStreamTwiml produces the documented Connect/Stream/Parameter structure', () => {
  const xml = buildConnectStreamTwiml({
    streamUrl: 'wss://apex.example.com/api/voice/media',
    parameters: { token: 'abc123', sessionId: '42' },
  });
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<Connect>/);
  assert.match(xml, /<Stream url="wss:\/\/apex\.example\.com\/api\/voice\/media">/);
  assert.match(xml, /<Parameter name="token" value="abc123"\/>/);
  assert.match(xml, /<Parameter name="sessionId" value="42"\/>/);
  assert.ok(!/url="[^"]*\?/.test(xml), 'no query string in the stream url');
});

test('stream parameter values cannot inject TwiML markup', () => {
  const hostile = '"/><Say>pwned</Say><Stream url="https://evil.example"';
  const xml = buildConnectStreamTwiml({ streamUrl: 'wss://apex.example.com/s', parameters: { note: hostile } });
  assert.ok(!xml.includes('<Say>'), 'no injected element');
  assert.equal((xml.match(/<Stream /g) ?? []).length, 1, 'exactly one Stream element');
  assert.ok(xml.includes('&lt;Say&gt;'));
});

test('stream URLs must be public wss:// origins with no query string', () => {
  for (const bad of [
    'ws://apex.example.com/s',
    'https://apex.example.com/s',
    'wss://apex.example.com/s?token=1',
    'wss://localhost/s',
    'wss://127.0.0.1/s',
    'wss://192.168.1.5/s',
    'wss://user:pw@apex.example.com/s',
    'not a url',
  ]) {
    assert.throws(() => assertPublicWssUrl(bad), (err) => err.status === 400 && err.message === 'invalid_stream_url', bad);
  }
  assert.equal(assertPublicWssUrl('wss://apex.example.com/api/voice/media'), 'wss://apex.example.com/api/voice/media');
});

test('stream parameters are limited in count, name shape, and combined length', () => {
  const url = 'wss://apex.example.com/s';
  const eleven = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`p${i}`, 'v']));
  assert.throws(() => buildConnectStreamTwiml({ streamUrl: url, parameters: eleven }), (err) => err.message === 'too_many_stream_parameters');
  assert.throws(() => buildConnectStreamTwiml({ streamUrl: url, parameters: { 'bad name': 'v' } }), (err) => err.message === 'invalid_stream_parameter');
  assert.throws(() => buildConnectStreamTwiml({ streamUrl: url, parameters: { token: 'x'.repeat(495) } }), (err) => err.message === 'stream_parameter_too_long');
  assert.ok(buildConnectStreamTwiml({ streamUrl: url, parameters: { token: 'x'.repeat(100) } }).includes('<Parameter'));
});

test('xmlEscape neutralizes the five XML metacharacters', () => {
  assert.equal(xmlEscape(`<a href="x">&'`), '&lt;a href=&quot;x&quot;&gt;&amp;&apos;');
});

test('the database used by these tests is always temporary', () => {
  const db = createDb(':memory:');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM users').get().c, 0);
  db.close();
});
