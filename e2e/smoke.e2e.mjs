import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/db.js';

// Real-browser smoke tests. They drive the actual UI through a real browser
// (Microsoft Edge, found on this machine via playwright-core's `msedge` channel) against
// an in-process server bound to 127.0.0.1 with a TEMPORARY database.
// Guarantees enforced here:
//   - no real leads, no real phone numbers (all test data is synthetic);
//   - every request the page makes must target 127.0.0.1 (no external network);
//   - nothing under /api/telephony or /api/voice may be requested by the demo flow.
// If no browser can be launched the suite reports skips with the reason; it never
// reports a browser pass it did not perform.

const CHANNEL = process.env.APEX_E2E_CHANNEL || 'msedge';
const OPERATOR = { username: 'e2e-operator', password: 'e2e-correct-horse-1' };
const LEAD = { name: 'E2E Synthetic Lead', phone: '+1 555 010 4242' };
const CAMPAIGN = 'E2E Smoke Campaign';

function zoneForLocalHour(hour) {
  const utcHour = new Date().getUTCHours();
  let offset = hour - utcHour;
  if (offset > 14) offset -= 24;
  if (offset < -12) offset += 24;
  return offset >= 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
}

let browser = null;
let launchError = '';
try {
  browser = await chromium.launch({ channel: CHANNEL, headless: true });
} catch (err) {
  launchError = `browser unavailable (channel ${CHANNEL}): ${String(err.message).split('\n')[0]}`;
}

const dir = mkdtempSync(path.join(tmpdir(), 'apex-e2e-'));
const db = createDb(path.join(dir, 'e2e.db'));
const app = createApp(db, {});
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;

// Shared, sequential flow state.
const seen = { requests: [], pageErrors: [] };

async function newPage() {
  const context = await browser.newContext({ baseURL: BASE });
  const page = await context.newPage();
  page.on('request', (req) => seen.requests.push(req.url()));
  page.on('pageerror', (err) => seen.pageErrors.push(String(err.message)));
  return { context, page };
}

async function bodyText(page) {
  return page.evaluate(() => document.body.innerText);
}

async function waitForText(page, text, timeout = 10000) {
  await page.waitForFunction((t) => document.body.innerText.includes(t), text, { timeout });
}

async function go(page, pageName) {
  await page.click(`button[data-page="${pageName}"]`);
  await page.waitForSelector(`#page-${pageName}:not([hidden])`, { timeout: 10000 });
}

const skip = launchError || false;

test('first run: operator setup signs in, and sign-out returns to the login screen', { skip }, async () => {
  const { context, page } = await newPage();
  try {
    await page.goto(BASE);
    await page.waitForSelector('#setupForm:not([hidden])', { timeout: 15000 });
    await page.fill('#setupUsername', OPERATOR.username);
    await page.fill('#setupPass', OPERATOR.password);
    await page.fill('#setupPass2', OPERATOR.password);
    await page.click('#setupForm button[type="submit"]');
    await page.waitForSelector('#page-overview:not([hidden])', { timeout: 15000 });

    await page.click('#logoutTop');
    await page.waitForSelector('#loginForm:not([hidden])', { timeout: 10000 });

    await page.fill('#loginUsername', OPERATOR.username);
    await page.fill('#loginPass', 'wrong-password-value');
    await page.click('#loginForm button[type="submit"]');
    await page.waitForFunction(() => document.querySelector('#authError')?.textContent.trim().length > 0, null, { timeout: 10000 });
    assert.equal(await page.locator('#loginForm').isVisible(), true, 'wrong password keeps the login form');

    await page.fill('#loginPass', OPERATOR.password);
    await page.click('#loginForm button[type="submit"]');
    await page.waitForSelector('#page-overview:not([hidden])', { timeout: 15000 });
  } finally {
    await context.close();
  }
});

test('diagnostics: settings show demo mode ON and live calling disabled (read-only)', { skip }, async () => {
  const { context, page } = await newPage();
  try {
    await page.goto(BASE);
    await page.waitForSelector('#loginForm:not([hidden])', { timeout: 15000 });
    await page.fill('#loginUsername', OPERATOR.username);
    await page.fill('#loginPass', OPERATOR.password);
    await page.click('#loginForm button[type="submit"]');
    await page.waitForSelector('#page-overview:not([hidden])', { timeout: 15000 });

    await go(page, 'settings');
    await waitForText(page, 'Demo mode');
    const text = await bodyText(page);
    assert.match(text, /Demo mode\s*ON/);
    assert.match(text, /Live calling\s*disabled/);
    assert.match(text, /READ-ONLY/);
  } finally {
    await context.close();
  }
});

test('lead workflow: a synthetic lead is created through the form and listed', { skip }, async () => {
  const { context, page } = await newPage();
  try {
    await page.goto(BASE);
    await page.waitForSelector('#loginForm:not([hidden])', { timeout: 15000 });
    await page.fill('#loginUsername', OPERATOR.username);
    await page.fill('#loginPass', OPERATOR.password);
    await page.click('#loginForm button[type="submit"]');
    await page.waitForSelector('#page-overview:not([hidden])', { timeout: 15000 });

    await go(page, 'leads');
    await page.click('#addLeadBtn');
    await page.waitForSelector('#leadModal', { state: 'visible', timeout: 10000 });
    await page.fill('#leadName', LEAD.name);
    await page.fill('#leadPhone', LEAD.phone);
    await page.fill('#leadTimezone', zoneForLocalHour(12));
    await page.selectOption('#leadConsent', 'recorded');
    await page.fill('#leadConsentDate', '2026-01-01');
    await page.fill('#leadConsentSource', 'web-form');
    await page.fill('#leadConsentEvidence', 'synthetic e2e evidence');
    await page.click('#leadForm button[type="submit"]');
    await waitForText(page, LEAD.name);
  } finally {
    await context.close();
  }
});

test('campaign workflow: a campaign is created and listed', { skip }, async () => {
  const { context, page } = await newPage();
  try {
    await page.goto(BASE);
    await page.waitForSelector('#loginForm:not([hidden])', { timeout: 15000 });
    await page.fill('#loginUsername', OPERATOR.username);
    await page.fill('#loginPass', OPERATOR.password);
    await page.click('#loginForm button[type="submit"]');
    await page.waitForSelector('#page-overview:not([hidden])', { timeout: 15000 });

    await go(page, 'campaigns');
    await page.fill('#cpName', CAMPAIGN);
    await page.fill('#cpMax', '3');
    await page.click('#cpCreate');
    await waitForText(page, CAMPAIGN);
  } finally {
    await context.close();
  }
});

test('demo dialing: a simulated call is started, labeled as demo, and never reaches telephony routes', { skip }, async () => {
  const { context, page } = await newPage();
  try {
    await page.goto(BASE);
    await page.waitForSelector('#loginForm:not([hidden])', { timeout: 15000 });
    await page.fill('#loginUsername', OPERATOR.username);
    await page.fill('#loginPass', OPERATOR.password);
    await page.click('#loginForm button[type="submit"]');
    await page.waitForSelector('#page-overview:not([hidden])', { timeout: 15000 });

    await go(page, 'dialer');
    assert.match((await page.textContent('#callModeBadge')) ?? '', /DEMO/i);
    assert.match((await page.textContent('#pdMode')) ?? '', /DEMO/i);

    const before = seen.requests.length;
    await page.click('#pdStart');
    await page.waitForFunction(() => document.querySelector('#pdLead')?.textContent.includes('E2E Synthetic Lead'), null, {
      timeout: 15000,
    });
    await page.click('#pdDial');
    // The demo attempt is logged to the Activity page (not the dialer). A blocked
    // attempt shows a toast or the compliance modal instead; capture both on failure.
    await page.waitForFunction(() => !!document.querySelector('#pdState') && document.querySelector('#pdLead') !== null, null, { timeout: 8000 });
    await go(page, 'activity');
    try {
      await waitForText(page, 'No real call was placed', 8000);
    } catch (err) {
      const toast = (await page.textContent('#toastArea')) ?? '';
      const reasons = (await page.textContent('#compReasons').catch(() => '')) ?? '';
      throw new Error(`demo call not logged. toast="${toast.trim()}" reasons="${reasons.trim().slice(0, 300)}" (${err.message})`);
    }

    const during = seen.requests.slice(before);
    assert.ok(!during.some((u) => /\/api\/(telephony|voice)/.test(u)), 'demo dialing never calls telephony or voice routes');
  } finally {
    await context.close();
  }
});

test('network hygiene: every request stayed on loopback and no page errors occurred', { skip }, async () => {
  const offHost = seen.requests.filter((u) => !u.startsWith(BASE) && !u.startsWith('data:') && !u.startsWith('blob:'));
  assert.deepEqual(offHost, [], 'no request left the local server');
  assert.deepEqual(seen.pageErrors, [], 'no uncaught page errors');
});

test('readiness panel: shows demo and live status separately, lists blockers, and has no live-enable control', { skip }, async () => {
  const { context, page } = await newPage();
  try {
    await page.goto(BASE);
    await page.waitForSelector('#loginForm:not([hidden])', { timeout: 15000 });
    await page.fill('#loginUsername', OPERATOR.username);
    await page.fill('#loginPass', OPERATOR.password);
    await page.click('#loginForm button[type="submit"]');
    await page.waitForSelector('#page-overview:not([hidden])', { timeout: 15000 });

    await go(page, 'settings');
    await page.waitForSelector('#readinessBox li', { timeout: 10000 });
    assert.equal((await page.textContent('#readinessLive')).trim(), 'LIVE CALLING UNAVAILABLE');
    assert.equal((await page.textContent('#readinessDemo')).trim(), 'DEMO READY');
    const box = await page.textContent('#readinessBox');
    assert.match(box, /BLOCKER/);
    assert.match(box, /Live calling is hard-disabled/);
    assert.equal(await page.locator('#readinessCard button').count(), 0, 'the panel offers no control that enables live calling');

    // Server error: the panel says so and does not show stale or invented status.
    await page.route('**/api/settings/readiness', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"internal_error"}' })
    );
    await go(page, 'overview');
    await go(page, 'settings');
    await waitForText(page, 'Readiness is unavailable right now');
    assert.equal((await page.textContent('#readinessLive')).trim(), 'UNKNOWN');
    await page.unroute('**/api/settings/readiness');

    // Empty payload: treated as missing information, never as "ready".
    await page.route('**/api/settings/readiness', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"data":{}}' })
    );
    await go(page, 'overview');
    await go(page, 'settings');
    await waitForText(page, 'No readiness information was returned');
    assert.equal((await page.textContent('#readinessLive')).trim(), 'UNKNOWN');
    await page.unroute('**/api/settings/readiness');
  } finally {
    await context.close();
  }
});
test('cleanup: browser, server, and temporary database are released', async () => {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
