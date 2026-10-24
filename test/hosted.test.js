import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { createApp, mergeConfig } from '../src/app.js';
import { createDb } from '../src/db/db.js';

test('local defaults stay loopback with insecure cookies', () => {
  const cfg = loadConfig({ APEX_DEMO_MODE: 'true' });
  assert.equal(cfg.host, '127.0.0.1');
  assert.equal(cfg.auth.cookieSecure, false);
  assert.equal(cfg.trustProxy, false);
  assert.equal(cfg.publicBaseUrl, '');
});

test('Render env binds all interfaces, secure cookies, trust proxy, and public origin', () => {
  const cfg = loadConfig({
    RENDER: 'true',
    PORT: '10000',
    RENDER_EXTERNAL_URL: 'https://apexdialer-demo.onrender.com',
  });
  assert.equal(cfg.host, '0.0.0.0');
  assert.equal(cfg.port, 10000);
  assert.equal(cfg.auth.cookieSecure, true);
  assert.equal(cfg.trustProxy, true);
  assert.equal(cfg.publicBaseUrl, 'https://apexdialer-demo.onrender.com');
});

test('explicit HOST still wins on Render', () => {
  const cfg = loadConfig({ RENDER: 'true', HOST: '127.0.0.1' });
  assert.equal(cfg.host, '127.0.0.1');
});

test('createApp enables trust proxy when configured', () => {
  const db = createDb(':memory:');
  try {
    const app = createApp(db, { trustProxy: true });
    assert.ok(app.enabled('trust proxy'));
    const local = createApp(db, mergeConfig());
    assert.equal(Boolean(local.enabled('trust proxy')), false);
  } finally {
    db.close();
  }
});
