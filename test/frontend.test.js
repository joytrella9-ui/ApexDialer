import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { withServer, raw, cookieHeader, AUTH_CREDS } from '../test-support/helpers.js';
import { loadFrontend } from '../test-support/domshim.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ORIGINAL = new URL('../ApexDialer_Working_MVP.html', import.meta.url);
const BACKUP = new URL('../ApexDialer_Working_MVP_2026-10-11.html.bak', import.meta.url);
const INTEGRATED = new URL('../ApexDialer_App.html', import.meta.url);

const ORIGINAL_SHA256 = 'FB922BC05D876A7593F868B9693D97AC48B802B6255063FE6051700DA8CDEBF9';

function sha256(text) {
  return createHash('sha256').update(text).digest('hex').toUpperCase();
}

test('the original frontend and its backup are byte-identical and unchanged', () => {
  const original = readFileSync(ORIGINAL, 'utf8');
  const backup = readFileSync(BACKUP, 'utf8');
  assert.equal(original, backup, 'original and backup must match exactly');
  assert.equal(sha256(original), ORIGINAL_SHA256, 'original must stay byte-for-byte as preserved');
});

test('the integrated frontend is a separate file from the preserved original', () => {
  const original = readFileSync(ORIGINAL, 'utf8');
  const integrated = readFileSync(INTEGRATED, 'utf8');
  assert.notEqual(integrated, original, 'integration file must differ from the original');
  assert.ok(integrated.includes('<title>ApexDialer'));
  assert.ok(integrated.includes('id="loginForm"'));
  assert.ok(integrated.includes('id="setupForm"'));
  assert.ok(integrated.includes('id="compModal"'));
});

test('GET / serves exactly the integrated frontend file', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.equal(html, readFileSync(INTEGRATED, 'utf8'));
  });
});

test('the integrated frontend keeps server-side state: no localStorage, no secrets, no tokens', () => {
  const html = readFileSync(INTEGRATED, 'utf8');
  assert.ok(!html.includes('localStorage'), 'browser storage must not be used');
  assert.ok(!html.includes('apex_workspace_leads'), 'legacy local lead key must be gone');
  assert.ok(!html.includes('password_hash'), 'no password hashes in the frontend');
  assert.ok(!html.includes('dummy-password-not-real'), 'no known test/backdoor password');
  assert.ok(!html.includes('Bearer '), 'no bearer tokens');
  assert.ok(!html.includes('access_token'), 'no access tokens');
});

test('the integrated frontend wires the authenticated API contract', () => {
  const html = readFileSync(INTEGRATED, 'utf8');
  for (const needle of [
    'api/auth/config',
    'api/auth/setup',
    'api/auth/login',
    'api/auth/me',
    'api/auth/logout',
    'api/auth/password',
    'api/leads',
    'api/leads/export',
    'api/leads/import',
    'compliance',
    'credentials',
    'same-origin',
    "decision!=='allowed'",
  ]) {
    assert.ok(html.includes(needle), `frontend must reference "${needle}"`);
  }
});

test('frontend flow: config → setup → login → me → leads, then logout revokes the cookie', async () => {
  await withServer(async (base) => {
    const cfg = await (await fetch(`${base}/api/auth/config`)).json();
    assert.equal(cfg.setupRequired, true);

    const setup = await raw(base, 'POST', '/api/auth/setup', { body: AUTH_CREDS });
    assert.equal(setup.status, 201);

    const login = await raw(base, 'POST', '/api/auth/login', { body: AUTH_CREDS });
    assert.equal(login.status, 200);
    const cookie = cookieHeader(login.headers.get('set-cookie'));
    assert.ok(cookie, 'login must set a session cookie');
    assert.match(login.headers.get('set-cookie'), /HttpOnly/i);
    assert.match(login.headers.get('set-cookie'), /SameSite=Strict/i);
    assert.equal(login.body.data.operator.password ?? null, null, 'never echo passwords');

    const me = await raw(base, 'GET', '/api/auth/me', { cookie });
    assert.equal(me.status, 200);
    assert.equal(me.body.data.operator.username, AUTH_CREDS.username);
    assert.equal(me.body.data.operator.password_hash ?? null, null);

    const leads = await raw(base, 'GET', '/api/leads', { cookie });
    assert.equal(leads.status, 200);
    assert.deepEqual(leads.body.data, []);

    const out = await raw(base, 'POST', '/api/auth/logout', { cookie });
    assert.equal(out.status, 204);
    assert.equal((await raw(base, 'GET', '/api/leads', { cookie })).status, 401);
  });
});

test('session expiry: an expired cookie yields 401 exactly like an absent one', async () => {
  await withServer(async (base, db) => {
    await raw(base, 'POST', '/api/auth/setup', { body: AUTH_CREDS });
    const login = await raw(base, 'POST', '/api/auth/login', { body: AUTH_CREDS });
    const cookie = cookieHeader(login.headers.get('set-cookie'));
    assert.equal((await raw(base, 'GET', '/api/leads', { cookie })).status, 200);

    db.prepare("UPDATE sessions SET expires_at = datetime('now', '-1 minute')").run();

    const expired = await raw(base, 'GET', '/api/leads', { cookie });
    assert.equal(expired.status, 401);
    assert.equal(expired.body.error, 'authentication_required');

    const relogin = await raw(base, 'POST', '/api/auth/login', { body: AUTH_CREDS });
    const newCookie = cookieHeader(relogin.headers.get('set-cookie'));
    assert.equal((await raw(base, 'GET', '/api/leads', { cookie: newCookie })).status, 200);
  });
});

test('same-origin requests pass the CSRF guard; foreign origins are rejected', async () => {
  await withServer(async (base) => {
    await raw(base, 'POST', '/api/auth/setup', { body: AUTH_CREDS });
    const login = await raw(base, 'POST', '/api/auth/login', {
      body: AUTH_CREDS,
      headers: { origin: base },
    });
    const cookie = cookieHeader(login.headers.get('set-cookie'));
    const foreign = await raw(base, 'POST', '/api/leads', {
      body: { name: 'Sneaky', phone: '+1 555 010 9999' },
      cookie,
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.body.error, 'cross_origin_forbidden');
    const same = await raw(base, 'GET', '/api/leads', { cookie, headers: { origin: base } });
    assert.equal(same.status, 200);
  });
});

test('lead CRUD + search + persistence round-trip mirrors the UI calls', async () => {
  await withServer(async (base) => {
    await raw(base, 'POST', '/api/auth/setup', { body: AUTH_CREDS });
    const login = await raw(base, 'POST', '/api/auth/login', { body: AUTH_CREDS });
    const cookie = cookieHeader(login.headers.get('set-cookie'));
    const get = (p, extra = {}) => raw(base, 'GET', p, { cookie, ...extra });

    const body = {
      name: 'Jordan Mitchell',
      phone: '+1 555 010 1001',
      company: 'Northstar Logistics',
      callType: 'existing-customer',
      timezone: 'America/New_York',
      consent: { status: 'recorded', evidence: 'signed', source: 'web-form', date: '2026-08-01' },
      notes: 'round-trip',
    };
    const created = await raw(base, 'POST', '/api/leads', { body, cookie });
    assert.equal(created.status, 201);
    const lead = created.body.data;
    assert.equal(lead.id, 1);
    assert.equal(lead.callType, 'existing-customer');
    assert.equal(lead.consent.status, 'recorded');
    assert.equal(lead.status, 'pending');

    const list = await get('/api/leads');
    assert.equal(list.body.count, 1);
    const filtered = await get('/api/leads?status=pending');
    assert.equal(filtered.body.count, 1);
    const q = await get('/api/leads?q=' + encodeURIComponent('northstar'));
    assert.equal(q.body.count, 1);
    const noq = await get('/api/leads?q=' + encodeURIComponent('zzz'));
    assert.equal(noq.body.count, 0);

    const updated = await raw(base, 'PUT', `/api/leads/${lead.id}`, {
      body: { status: 'completed', disposition: 'Interested', notes: 'said call back' },
      cookie,
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.status, 'completed');
    assert.equal(updated.body.data.disposition, 'Interested');

    const again = await get(`/api/leads/${lead.id}`);
    assert.equal(again.body.data.disposition, 'Interested');
    assert.equal(again.body.data.notes, 'said call back');

    const del = await raw(base, 'DELETE', `/api/leads/${lead.id}`, { cookie });
    assert.equal(del.status, 204);
    assert.equal((await get(`/api/leads/${lead.id}`)).status, 404);
    assert.equal((await get('/api/leads')).body.count, 0);
  });
});

test('CSV export/import flows match the UI wire-up', async () => {
  await withServer(async (base) => {
    await raw(base, 'POST', '/api/auth/setup', { body: AUTH_CREDS });
    const login = await raw(base, 'POST', '/api/auth/login', { body: AUTH_CREDS });
    const cookie = cookieHeader(login.headers.get('set-cookie'));

    const csv = [
      'Name,Phone,Company',
      'Alice Example,+1 555 010 2001,Acme',
      'Bob Sample,+1 555 010 2002,Acme',
    ].join('\r\n');
    const imported = await raw(base, 'POST', '/api/leads/import', {
      body: csv,
      contentType: 'text/csv',
      cookie,
    });
    assert.equal(imported.status, 201);
    assert.equal(imported.body.data.imported, 2);
    assert.equal(imported.body.data.rejected, 0);

    const dup = await raw(base, 'POST', '/api/leads/import', {
      body: csv,
      contentType: 'text/csv',
      cookie,
    });
    assert.equal(dup.body.data.skipped, 2);

    const exported = await raw(base, 'GET', '/api/leads/export', { cookie });
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get('content-type'), /text\/csv/);
    assert.match(exported.headers.get('content-disposition'), /apexdialer-leads\.csv/);
    assert.match(exported.body, /Lead ID/);
    assert.match(exported.body, /Alice Example/);
    assert.match(exported.body, /Bob Sample/);
  });
});

test('compliance decisions the UI depends on: allowed, review, and blocked', async () => {
  await withServer(async (base) => {
    await raw(base, 'POST', '/api/auth/setup', { body: AUTH_CREDS });
    const login = await raw(base, 'POST', '/api/auth/login', { body: AUTH_CREDS });
    const cookie = cookieHeader(login.headers.get('set-cookie'));
    const at = '2026-09-01T15:00:00.000Z';

    const compliant = await raw(base, 'POST', '/api/leads', {
      cookie,
      body: {
        name: 'Ready Contact',
        phone: '+1 555 010 3001',
        company: 'Acme',
        callType: 'sales',
        timezone: 'America/New_York',
        consent: { status: 'recorded', evidence: 'signed', source: 'web-form', date: '2026-08-01' },
      },
    });
    const review = await raw(base, 'POST', '/api/leads', {
      cookie,
      body: {
        name: 'Partial Contact',
        phone: '+1 555 010 3002',
        callType: 'sales',
        timezone: 'America/New_York',
        consent: { status: 'recorded', evidence: 'signed', source: '', date: '' },
      },
    });
    const blocked = await raw(base, 'POST', '/api/leads', {
      cookie,
      body: { name: 'No Consent', phone: '+1 555 010 3003' },
    });

    const allowed = await raw(base, 'GET', `/api/leads/${compliant.body.data.id}/compliance?at=${at}`, {
      cookie,
    });
    assert.equal(allowed.body.data.decision, 'allowed');
    assert.equal(allowed.body.data.mayDial, true);

    const reviewRes = await raw(base, 'GET', `/api/leads/${review.body.data.id}/compliance?at=${at}`, {
      cookie,
    });
    assert.equal(reviewRes.body.data.decision, 'review');
    assert.equal(reviewRes.body.data.mayDial, false);

    const blockedRes = await raw(base, 'GET', `/api/leads/${blocked.body.data.id}/compliance?at=${at}`, {
      cookie,
    });
    assert.equal(blockedRes.body.data.decision, 'blocked');
    assert.equal(blockedRes.body.data.mayDial, false);
    assert.ok(blockedRes.body.data.reasons.some((r) => r.code === 'missing_consent'));
  });
});

test('startup: the hidden attribute is not defeated by overlay display rules', () => {
  const html = readFileSync(INTEGRATED, 'utf8');
  const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
  assert.match(styles, /\.loginwrap\s*\{[^}]*display:grid/, '.loginwrap sets display:grid (the trigger)');
  assert.match(styles, /\.loginform\s*\{[^}]*display:grid/, '.loginform sets display:grid (the trigger)');
  assert.ok(
    styles.includes('[hidden]{display:none!important}'),
    'an author [hidden] rule with !important must outrank the overlay display rules',
  );
  assert.ok(/id="loginView" hidden/.test(html), 'login overlay must start hidden');
  assert.ok(/id="setupForm" hidden/.test(html), 'setup form must start hidden');
  assert.ok(!/id="loadingView" hidden/.test(html), 'loading overlay must start visible');
});

test('startup: failures surface a clear error with a Retry control, never a silent hang', () => {
  const html = readFileSync(INTEGRATED, 'utf8');
  for (const needle of [
    'id="startupError" hidden',
    'id="startupErrorMsg"',
    'id="startupRetry"',
    "window.addEventListener('error'",
    "window.addEventListener('unhandledrejection'",
    'showStartupError(',
    'location.reload()',
  ]) {
    assert.ok(html.includes(needle), `frontend must include "${needle}"`);
  }
});

test('startup behavior: reachable server reveals setup; failed request reveals error + working Retry', async () => {
  const html = readFileSync(INTEGRATED, 'utf8');

  const ok = loadFrontend(html, {
    fetch: async (path) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () =>
        JSON.stringify(path === '/api/auth/config' ? { setupRequired: true } : {}),
    }),
  });
  await ok.flush();
  assert.equal(ok.get('loadingView').hidden, true, 'loading overlay must hide once startup resolves');
  assert.equal(ok.get('loginView').hidden, false, 'login overlay must be visible');
  assert.equal(ok.get('setupForm').hidden, false, 'setup form must be shown on first run');
  assert.equal(ok.get('loginForm').hidden, true, 'login form must be hidden while setup is required');

  const broken = loadFrontend(html, {
    fetch: async () => {
      throw new Error('network down');
    },
    location: {
      reload() {
        this.calls = (this.calls || 0) + 1;
      },
    },
  });
  await broken.flush();
  assert.equal(broken.get('startupError').hidden, false, 'startup error screen must be shown');
  assert.match(broken.get('startupErrorMsg').textContent, /server|retry/i);
  assert.equal(broken.get('loadingView').hidden, true, 'loading overlay must not stay stuck');
  assert.equal(broken.reloads(), 0);
  broken.get('startupRetry').click();
  assert.equal(broken.reloads(), 1, 'Retry must reload the page');
});