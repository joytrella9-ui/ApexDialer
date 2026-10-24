import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer, api } from '../test-support/helpers.js';

const SID = 'ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CALL_SID = 'CAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TOKEN = 'test-auth-token-not-a-real-secret';

function mockTwilioFetch() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: String(init?.body ?? '') });
    if (String(url).includes('/Calls.json') && !String(url).includes('/Calls/CA')) {
      return {
        ok: true,
        status: 201,
        text: async () => JSON.stringify({ sid: CALL_SID, status: 'queued' }),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ sid: CALL_SID, status: 'completed' }),
    };
  };
  return { fetchImpl, calls };
}

async function eligibleLead(base) {
  const utcHour = new Date().getUTCHours();
  let offset = 12 - utcHour;
  if (offset > 14) offset -= 24;
  if (offset < -12) offset += 24;
  const timezone = offset >= 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
  const res = await api(base, 'POST', '/api/leads', {
    name: 'Live Lead',
    phone: '5550199888',
    company: 'Live Co',
    callType: 'existing-customer',
    timezone,
    consent: { status: 'none' },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
}

test('integrations can be saved incomplete and never return the auth token', async () => {
  await withServer(async (base) => {
    const saved = await api(base, 'PUT', '/api/settings/integrations', {
      twilioAccountSid: SID,
      twilioAuthToken: TOKEN,
      twilioFromNumber: '+15551234567',
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.data.twilioAccountSidSet, true);
    assert.equal(saved.body.data.twilioAuthTokenSet, true);
    assert.equal(saved.body.data.ready, false);
    assert.ok(saved.body.data.missing.includes('agentPhone'));
    assert.equal(JSON.stringify(saved.body).includes(TOKEN), false);

    const got = await api(base, 'GET', '/api/settings/integrations');
    assert.equal(got.status, 200);
    assert.equal(got.body.data.twilioAuthTokenSet, true);
    assert.equal(JSON.stringify(got.body).includes(TOKEN), false);
    assert.ok(got.body.data.twilioAccountSidMasked);
    assert.equal(got.body.data.twilioAccountSidMasked.includes(SID.slice(8, 16)), false);
  });
});

test('live calling cannot be enabled until every required field is present', async () => {
  await withServer(async (base) => {
    const res = await api(base, 'PUT', '/api/settings/integrations', {
      liveOutboundEnabled: true,
      twilioAccountSid: SID,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'integrations_incomplete');
  });
});

test('operators cannot change telephony credentials', async () => {
  await withServer(async (base, db) => {
    const bcrypt = (await import('bcryptjs')).default;
    const { cookieHeader, raw } = await import('../test-support/helpers.js');
    db.prepare('INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)').run(
      'agent',
      bcrypt.hashSync('correct horse battery staple', 4),
      'agent',
      'operator'
    );
    const login = await raw(base, 'POST', '/api/auth/login', {
      body: { username: 'agent', password: 'correct horse battery staple' },
    });
    const denied = await api(
      base,
      'PUT',
      '/api/settings/integrations',
      { agentPhone: '+15551111111' },
      { cookie: cookieHeader(login.headers.get('set-cookie')) }
    );
    assert.equal(denied.status, 403);
  });
});

test('a live attempt places one Twilio click-to-call and stores the Call SID', async () => {
  const { fetchImpl, calls } = mockTwilioFetch();
  await withServer(
    async (base) => {
      const setup = await api(base, 'PUT', '/api/settings/integrations', {
        twilioAccountSid: SID,
        twilioAuthToken: TOKEN,
        twilioFromNumber: '+15551234567',
        agentPhone: '+15559876543',
        publicBaseUrl: 'https://apexdialer-test.example.com',
        liveOutboundEnabled: true,
      });
      assert.equal(setup.status, 200, JSON.stringify(setup.body));
      assert.equal(setup.body.data.ready, true);

      const lead = await eligibleLead(base);
      const attempt = await api(base, 'POST', '/api/calls/attempt', { leadId: lead.id });
      assert.equal(attempt.status, 201, JSON.stringify(attempt.body));
      assert.equal(attempt.body.data.dialingMode, 'live');
      assert.equal(attempt.body.data.call.providerCallSid, CALL_SID);
      assert.equal(calls.length, 1);
      assert.match(calls[0].url, /Calls\.json/);
      assert.match(calls[0].body, /To=%2B15559876543/);
      assert.match(calls[0].body, /apexdialer-test\.example\.com/);
    },
    undefined,
    { telephony: { fetchImpl } }
  );
});
