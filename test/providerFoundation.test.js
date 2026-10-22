import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { mergeConfig } from '../src/app.js';
import { VOICE_STACKS, createVoiceStack, describeVoiceStack } from '../src/providers/voiceStack.js';
import { VOICE_PROVIDERS } from '../src/providers/voice.js';
import { withServer, api, raw } from '../test-support/helpers.js';

const LIVE_ENV = {
  APEX_TWILIO_ENABLED: '1',
  APEX_TWILIO_PROVIDER: 'twilio',
  APEX_VOICE_ENABLED: '1',
  APEX_VOICE_PROVIDER: 'twilio',
  APEX_TWILIO_ACCOUNT_SID: 'ACdummy',
  APEX_TWILIO_AUTH_TOKEN: 'dummy-token',
  APEX_TWILIO_FROM_NUMBER: '+15550000000',
  APEX_VOICE_WEBHOOK_SECRET: 'dummy-secret',
};

test('no environment variable can enable live calling or recording', () => {
  const cfg = loadConfig(LIVE_ENV);
  assert.equal(cfg.telephony.liveEnabled, false);
  assert.equal(cfg.voice.liveEnabled, false);
  assert.equal(cfg.voice.recordingEnabled, false);
  assert.equal(cfg.compliance.recordingAllowed, false);
});

test('no config override can enable live calling or recording', () => {
  const cfg = mergeConfig({
    telephony: { liveEnabled: true, enabled: true },
    voice: { liveEnabled: true, recordingEnabled: true, provider: 'twilio', enabled: true },
    compliance: { recordingAllowed: true },
  });
  assert.equal(cfg.telephony.liveEnabled, false);
  assert.equal(cfg.voice.liveEnabled, false);
  assert.equal(cfg.voice.recordingEnabled, false);
  assert.equal(cfg.compliance.recordingAllowed, false);
});

test('only the offline fake stack/provider is registered by default', () => {
  assert.deepEqual(Object.keys(VOICE_STACKS), ['fake']);
  assert.deepEqual(Object.keys(VOICE_PROVIDERS), ['fake']);
  assert.throws(
    () => createVoiceStack({ provider: 'fake', liveEnabled: true }),
    (err) => err.status === 400 && err.message === 'live_voice_disabled'
  );
  assert.throws(
    () => createVoiceStack({ provider: 'twilio' }),
    (err) => err.status === 400 && err.message === 'voice_provider_not_implemented'
  );
});

test('a fully credentialed live provider still reports never-ready', () => {
  const described = describeVoiceStack({ provider: 'twilio' }, LIVE_ENV);
  assert.equal(described.mode, 'not_implemented');
  assert.equal(described.implemented, false);
  assert.equal(described.ready, false);
  assert.equal(described.liveEnabled, false);
  assert.equal(described.credentialsPresent, true);
  assert.ok(!JSON.stringify(described).includes('dummy-token'));
});

test('the HTTP surface never reports live calling or recording, even with hostile overrides', async () => {
  await withServer(
    async (base) => {
      const settings = await api(base, 'GET', '/api/settings');
      assert.equal(settings.status, 200);
      assert.equal(settings.body.data.voice.liveEnabled, false);
      assert.equal(settings.body.data.voice.recordingEnabled, false);
      assert.equal(settings.body.data.compliance.recordingAllowed, false);

      const health = await raw(base, 'GET', '/api/health/config');
      assert.equal(health.body.voice.liveEnabled, false);
      assert.equal(health.body.voice.recordingEnabled, false);
      assert.equal(health.body.dialer.liveCalling, false);
      assert.equal(health.body.dialer.complianceProfileRequired, true);
    },
    undefined,
    { voice: { liveEnabled: true, recordingEnabled: true }, telephony: { liveEnabled: true } }
  );
});

test('the real-adapter provider modules contain no static network access', () => {
  const files = ['aiTools.js', 'openaiRealtime.js', 'twilioMediaStream.js', 'twilioVoice.js'];
  const forbidden = [
    /from 'node:http'/,
    /from 'node:https'/,
    /from 'node:net'/,
    /from 'node:dgram'/,
    /from 'node:tls'/,
    /new WebSocket\s*\(/,
    /\bfetch\s*\(/,
    /require\('https?'\)/,
  ];
  for (const file of files) {
    const source = readFileSync(new URL(`../src/providers/${file}`, import.meta.url), 'utf8');
    for (const re of forbidden) {
      assert.ok(!re.test(source), `${file} must not contain network access (${re})`);
    }
  }
});
