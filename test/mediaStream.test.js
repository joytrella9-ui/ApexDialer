import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import WebSocket from 'ws';
import { createDb } from '../src/db/db.js';
import { createApp } from '../src/app.js';
import { raw } from '../test-support/helpers.js';
import { signatureBase } from '../src/providers/twilio.js';
import { attachMediaStreamServer, MEDIA_PATH } from '../src/providers/mediaStreamServer.js';
import { createStreamTokenStore } from '../src/services/mediaStreamTokens.js';

// Offline protocol tests. A loopback `ws` client plays the role of Twilio. No
// test contacts Twilio, uses a real number, or uses a real credential.

const TWILIO_TOKEN = 'twilio-test-auth-token-not-real';
const VOICE_SECRET = 'voice-test-secret-not-real';
const PUBLIC = 'https://apex.example.com';
const CALL_SID = 'CA' + 'b'.repeat(32);

function seedSession(db, { status = 'in_progress', callSid = CALL_SID } = {}) {
  db.prepare("INSERT INTO leads (name, phone, timezone, status) VALUES ('Synthetic', '+15550199901', 'Etc/GMT+0', 'pending')").run();
  const leadId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  db.prepare("INSERT INTO campaigns (name, status) VALUES ('C', 'running')").run();
  const campaignId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  db.prepare("INSERT INTO campaign_leads (campaign_id, lead_id, status) VALUES (?, ?, 'dialing')").run(campaignId, leadId);
  db.prepare("INSERT INTO calls (lead_id, direction, status, call_type) VALUES (?, 'outbound', 'in_progress', 'sales')").run(leadId);
  const callId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  db.prepare(
    'INSERT INTO voice_sessions (campaign_id, lead_id, call_id, provider, status, phase, provider_call_sid) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(campaignId, leadId, callId, 'twilio', status, 'awaiting', callSid);
  return db.prepare('SELECT last_insert_rowid() AS id').get().id;
}

function sign(url, params, token = TWILIO_TOKEN) {
  return createHmac('sha1', token).update(signatureBase(url, params)).digest('base64');
}

async function startStack({ attach = {} } = {}) {
  const db = createDb(':memory:');
  const app = createApp(db, {
    publicBaseUrl: PUBLIC,
    voice: { enabled: true, webhookSecret: VOICE_SECRET },
    telephony: { webhookSecret: TWILIO_TOKEN },
  });
  const http = app.listen(0, '127.0.0.1');
  await new Promise((r) => http.once('listening', r));
  const received = [];
  const closes = [];
  const starts = [];
  const endpoint = attachMediaStreamServer(http, {
    tokens: app.locals.streamTokens,
    idleMs: 300,
    onMessage: (e) => received.push(e),
    onClose: (e) => closes.push(e),
    onStart: (e) => starts.push(e),
    validateStart: () => true,
    ...attach,
  });
  const base = `http://127.0.0.1:${http.address().port}`;
  return {
    db,
    app,
    base,
    wsUrl: `ws://127.0.0.1:${http.address().port}${MEDIA_PATH}`,
    tokens: app.locals.streamTokens,
    received,
    closes,
    starts,
    endpoint,
    async stop() {
      endpoint.close();
      http.closeAllConnections?.();
      await new Promise((r) => http.close(r));
      db.close();
    },
  };
}

function issueToken(stack, sessionId) {
  return stack.tokens.issue(sessionId);
}

function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextClose(ws) {
  return new Promise((resolve) => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
}

function startMessage(token, extra = {}) {
  return JSON.stringify({
    event: 'start',
    sequenceNumber: '1',
    streamSid: 'MZ' + '1'.repeat(32),
    start: {
      accountSid: 'AC' + '2'.repeat(32),
      callSid: CALL_SID,
      tracks: ['inbound'],
      customParameters: { token },
      mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
    },
    ...extra,
  });
}

const CONNECTED = JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' });
const mediaFrame = (streamSid = 'MZ' + '1'.repeat(32)) =>
  JSON.stringify({ event: 'media', streamSid, media: { track: 'inbound', chunk: '1', timestamp: '5', payload: Buffer.alloc(160, 0x7f).toString('base64') } });

async function waitUntil(fn, ms = 2000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ---- TwiML route -----------------------------------------------------------------

test('TwiML route issues a <Connect><Stream> with a single-use token passed as a parameter, not in the URL', async () => {
  const stack = await startStack();
  try {
    const id = seedSession(stack.db);
    const path = `/api/voice/webhooks/twiml/${id}`;
    const params = { CallSid: CALL_SID, From: '+15550000000' };
    const res = await raw(stack.base, 'POST', path, {
      body: new URLSearchParams(params).toString(),
      contentType: 'application/x-www-form-urlencoded',
      headers: { 'x-twilio-signature': sign(`${PUBLIC}${path}`, params) },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const xml = String(res.body);
    assert.match(xml, /<Connect>/);
    assert.match(xml, new RegExp(`<Stream url="wss://apex\\.example\\.com${MEDIA_PATH}">`));
    assert.doesNotMatch(xml, /<Stream url="[^"]*\?/, 'no query string in the stream URL');
    const token = /<Parameter name="token" value="([^"]+)"\/>/.exec(xml)?.[1];
    assert.ok(token && token.length >= 40, 'token parameter present');
    assert.match(xml, new RegExp(`<Parameter name="sessionId" value="${id}"/>`));
    assert.equal(stack.tokens.consume(token), id, 'the issued token is bound to this session');
  } finally {
    await stack.stop();
  }
});

test('TwiML route rejects unsigned, mis-signed, and locally-signed requests', async () => {
  const stack = await startStack();
  try {
    const id = seedSession(stack.db);
    const path = `/api/voice/webhooks/twiml/${id}`;
    const params = { CallSid: CALL_SID };
    const body = new URLSearchParams(params).toString();
    const unsigned = await raw(stack.base, 'POST', path, { body, contentType: 'application/x-www-form-urlencoded' });
    assert.equal(unsigned.status, 401);
    const local = await raw(stack.base, 'POST', path, {
      body,
      contentType: 'application/x-www-form-urlencoded',
      headers: { 'x-twilio-signature': sign(`${stack.base}${path}`, params) },
    });
    assert.equal(local.status, 401, 'a signature over the local URL is not accepted');
    const wrongKey = await raw(stack.base, 'POST', path, {
      body,
      contentType: 'application/x-www-form-urlencoded',
      headers: { 'x-twilio-signature': sign(`${PUBLIC}${path}`, params, 'other-key') },
    });
    assert.equal(wrongKey.status, 401);
  } finally {
    await stack.stop();
  }
});

test('TwiML route requires the session to exist, be live, and name its own call SID', async () => {
  const stack = await startStack();
  try {
    const ended = seedSession(stack.db, { status: 'ended' });
    const live = seedSession(stack.db, { callSid: 'CA' + 'c'.repeat(32) });
    const sign2 = (path, params) => sign(`${PUBLIC}${path}`, params);
    const post = (path, params) =>
      raw(stack.base, 'POST', path, {
        body: new URLSearchParams(params).toString(),
        contentType: 'application/x-www-form-urlencoded',
        headers: { 'x-twilio-signature': sign2(path, params) },
      });
    const endedPath = `/api/voice/webhooks/twiml/${ended}`;
    assert.equal((await post(endedPath, { CallSid: CALL_SID })).status, 404, 'ended session is not served');
    const missing = `/api/voice/webhooks/twiml/999999`;
    assert.equal((await post(missing, { CallSid: CALL_SID })).status, 404);
    const livePath = `/api/voice/webhooks/twiml/${live}`;
    assert.equal((await post(livePath, { CallSid: CALL_SID })).status, 403, 'a different call SID is refused');
    assert.equal((await post(livePath, { CallSid: 'CA' + 'c'.repeat(32) })).status, 200);
  } finally {
    await stack.stop();
  }
});

test('TwiML route is absent or refused when voice, the Twilio secret, or the public origin is missing', async () => {
  const db = createDb(':memory:');
  const disabled = createApp(db, { publicBaseUrl: PUBLIC, telephony: { webhookSecret: TWILIO_TOKEN } });
  const noSecret = createApp(db, { publicBaseUrl: PUBLIC, voice: { enabled: true, webhookSecret: VOICE_SECRET } });
  const noOrigin = createApp(db, { voice: { enabled: true, webhookSecret: VOICE_SECRET }, telephony: { webhookSecret: TWILIO_TOKEN } });
  const srvs = [disabled, noSecret, noOrigin].map((a) => a.listen(0, '127.0.0.1'));
  await Promise.all(srvs.map((s) => new Promise((r) => s.once('listening', r))));
  try {
    const path = '/api/voice/webhooks/twiml/1';
    const params = { CallSid: CALL_SID };
    const body = new URLSearchParams(params).toString();
    const headers = { 'x-twilio-signature': sign(`${PUBLIC}${path}`, params) };
    const port = (s) => s.address().port;
    const r1 = await raw(`http://127.0.0.1:${port(srvs[0])}`, 'POST', path, { body, contentType: 'application/x-www-form-urlencoded', headers });
    assert.equal(r1.status, 404, 'voice disabled: route not found');
    const r2 = await raw(`http://127.0.0.1:${port(srvs[1])}`, 'POST', path, { body, contentType: 'application/x-www-form-urlencoded', headers });
    assert.equal(r2.status, 403);
    assert.equal(r2.body.error, 'provider_disabled', 'no Twilio secret: refused before any other check');
    const r3 = await raw(`http://127.0.0.1:${port(srvs[2])}`, 'POST', path, { body, contentType: 'application/x-www-form-urlencoded', headers });
    assert.equal(r3.status, 403);
    assert.equal(r3.body.error, 'public_base_url_required', 'no public origin: refused');
  } finally {
    srvs.forEach((s) => s.close());
    db.close();
  }
});

// ---- media WebSocket ---------------------------------------------------------------

test('a Twilio-style stream with a valid token is accepted, media is forwarded, and stop closes cleanly', async () => {
  const stack = await startStack();
  try {
    const id = seedSession(stack.db);
    const token = issueToken(stack, id);
    const ws = await openWs(stack.wsUrl);
    const closed = nextClose(ws);
    ws.send(CONNECTED);
    ws.send(startMessage(token));
    await waitUntil(() => stack.starts.length === 1);
    assert.equal(stack.starts[0].sessionId, id);
    ws.send(mediaFrame());
    await waitUntil(() => stack.received.some((e) => e.message.type === 'media'));
    assert.equal(stack.received.find((e) => e.message.type === 'media').sessionId, id);
    ws.send(JSON.stringify({ event: 'stop', streamSid: 'MZ' + '1'.repeat(32), stop: { accountSid: 'AC' + '2'.repeat(32), callSid: CALL_SID, reason: 'done' } }));
    const { code } = await closed;
    assert.equal(code, 1000);
    await waitUntil(() => stack.closes.length === 1);
    assert.equal(stack.closes[0].reason, 'stream_stopped');
    assert.equal(stack.endpoint.connections(), 0);
  } finally {
    await stack.stop();
  }
});

test('a token is single-use: a replayed token is refused at the next start', async () => {
  const stack = await startStack();
  try {
    const id = seedSession(stack.db);
    const token = issueToken(stack, id);
    const first = await openWs(stack.wsUrl);
    first.send(startMessage(token));
    await waitUntil(() => stack.starts.length === 1);
    first.terminate();

    const replay = await openWs(stack.wsUrl);
    const closed = nextClose(replay);
    replay.send(startMessage(token));
    const { code, reason } = await closed;
    assert.equal(code, 1008);
    assert.equal(reason, 'unauthorized');
    assert.equal(stack.starts.length, 1, 'no second session was bound');
  } finally {
    await stack.stop();
  }
});

test('a forged or missing token is refused', async () => {
  const stack = await startStack();
  try {
    for (const token of ['forged-token-value', undefined]) {
      const ws = await openWs(stack.wsUrl);
      const closed = nextClose(ws);
      ws.send(startMessage(token));
      const { code, reason } = await closed;
      assert.equal(code, 1008);
      assert.equal(reason, 'unauthorized');
    }
    assert.equal(stack.starts.length, 0);
  } finally {
    await stack.stop();
  }
});

test('protocol violations close the socket: media before start, binary frames, non-JSON, duplicate start', async () => {
  const stack = await startStack();
  try {
    const early = await openWs(stack.wsUrl);
    const c1 = nextClose(early);
    early.send(mediaFrame());
    assert.equal((await c1).reason, 'not_started');

    const bin = await openWs(stack.wsUrl);
    const c2 = nextClose(bin);
    bin.send(Buffer.from([1, 2, 3]), { binary: true });
    assert.equal((await c2).code, 1003);

    const junk = await openWs(stack.wsUrl);
    const c3 = nextClose(junk);
    junk.send('{not json');
    assert.equal((await c3).reason, 'invalid_message');

    const id = seedSession(stack.db);
    const token = issueToken(stack, id);
    const dup = await openWs(stack.wsUrl);
    const c4 = nextClose(dup);
    dup.send(startMessage(token));
    await waitUntil(() => stack.starts.length === 1);
    dup.send(startMessage('another'));
    assert.equal((await c4).reason, 'duplicate_start');
  } finally {
    await stack.stop();
  }
});

test('a request for any other path is refused at the HTTP upgrade', async () => {
  const stack = await startStack();
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${stack.base.split(':').pop()}/api/other`);
    const err = await new Promise((resolve) => ws.once('error', resolve));
    assert.match(String(err.message), /404/);
  } finally {
    await stack.stop();
  }
});

test('idle connections are closed by the server', async () => {
  const stack = await startStack();
  try {
    const ws = await openWs(stack.wsUrl);
    const closed = nextClose(ws);
    const { code, reason } = await closed;
    assert.equal(code, 1001);
    assert.equal(reason, 'idle_timeout');
  } finally {
    await stack.stop();
  }
});

test('an oversized frame is rejected by the transport before it reaches the handler', async () => {
  const stack = await startStack({ attach: { maxPayload: 1024 } });
  try {
    const ws = await openWs(stack.wsUrl);
    const closed = nextClose(ws);
    ws.send('x'.repeat(4096));
    const { code } = await closed;
    assert.equal(code, 1009, 'message too big');
    assert.equal(stack.received.length, 0);
  } finally {
    await stack.stop();
  }
});

test('a message flood is cut off after the per-second limit', async () => {
  const stack = await startStack({ attach: { maxMessagesPerSecond: 5 } });
  try {
    const id = seedSession(stack.db);
    const token = issueToken(stack, id);
    const ws = await openWs(stack.wsUrl);
    const closed = nextClose(ws);
    ws.send(startMessage(token));
    for (let i = 0; i < 10; i += 1) ws.send(CONNECTED);
    const { code, reason } = await closed;
    assert.equal(code, 1008);
    assert.equal(reason, 'rate_limited');
  } finally {
    await stack.stop();
  }
});

test('the connection cap refuses new streams with 503 once reached', async () => {
  const stack = await startStack({ attach: { maxConnections: 1 } });
  try {
    const first = await openWs(stack.wsUrl);
    const second = new WebSocket(stack.wsUrl);
    const err = await new Promise((resolve) => second.once('error', resolve));
    assert.match(String(err.message), /503/);
    first.terminate();
  } finally {
    await stack.stop();
  }
});

// ---- token store ----------------------------------------------------------------------

test('the token store expires tokens, binds them once, never stores the raw token, and bounds its size', () => {
  let clock = 1000;
  const store = createStreamTokenStore({ ttlMs: 100, maxTokens: 2, now: () => clock });
  const token = store.issue(7);
  assert.equal(store.consume('wrong'), null);
  assert.equal(store.consume(token), 7);
  assert.equal(store.consume(token), null, 'single use');

  const expiring = store.issue(8);
  clock += 101;
  assert.equal(store.consume(expiring), null, 'expired');

  store.issue(1);
  store.issue(2);
  assert.throws(() => store.issue(3), /stream_token_capacity/);
  assert.equal(store.size(), 2);
  assert.equal(store.consume(''), null);
  assert.equal(store.consume('x'.repeat(300)), null);
});
