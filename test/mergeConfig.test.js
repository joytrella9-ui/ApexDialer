import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeConfig } from '../src/app.js';
import { config } from '../src/config.js';

test('mergeConfig always forces telephony and voice liveEnabled to false', () => {
  const cfg = mergeConfig({
    telephony: { liveEnabled: true, enabled: true },
    voice: { liveEnabled: true, provider: 'twilio', enabled: true },
  });
  assert.equal(cfg.telephony.liveEnabled, false);
  assert.equal(cfg.voice.liveEnabled, false);
  // Other nested overrides still apply as intended.
  assert.equal(cfg.telephony.enabled, true);
  assert.equal(cfg.voice.provider, 'twilio');
  assert.equal(cfg.voice.enabled, true);
});

test('mergeConfig deep-merges known sections, passes through other keys, and keeps defaults', () => {
  const cfg = mergeConfig({ demoMode: false, host: '0.0.0.0', voice: { maxTurns: 5 } });
  assert.equal(cfg.demoMode, false);
  assert.equal(cfg.host, '0.0.0.0');
  assert.equal(cfg.voice.maxTurns, 5);
  // Untouched defaults survive the merge.
  assert.equal(cfg.voice.provider, config.voice.provider);
  assert.equal(cfg.auth.cookieName, config.auth.cookieName);
  assert.equal(cfg.compliance.callWindowStart, config.compliance.callWindowStart);
  assert.equal(cfg.telephony.liveEnabled, false);
  assert.equal(cfg.voice.liveEnabled, false);
});

test('mergeConfig ignores an attempt to inject an unknown live flag shape', () => {
  const cfg = mergeConfig({ liveEnabled: true, voice: { live: true }, telephony: { live: true } });
  assert.equal(cfg.voice.liveEnabled, false);
  assert.equal(cfg.telephony.liveEnabled, false);
});
