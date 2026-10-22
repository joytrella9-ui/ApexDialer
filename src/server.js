import 'dotenv/config';
import { config } from './config.js';
import { createDb } from './db/db.js';
import { createApp } from './app.js';
import { claimNext } from './services/campaigns.js';
import { attachLifecycleMedia } from './services/callLifecycle.js';

const db = createDb(config.dbPath);
const app = createApp(db);
const server = app.listen(config.port, config.host, () => {
  console.log(`ApexDialer backend listening on http://${config.host}:${config.port}`);
  console.log(
    `Demo mode: ${config.demoMode ? 'ON' : 'OFF'} · Telephony: ${config.telephony.provider ?? 'none'} · DB: ${config.dbPath}`
  );
});

// Media Streams WebSocket endpoint. Mounted only when the voice subsystem is enabled
// AND a public HTTPS origin is configured. It accepts only streams that present a
// single-use token issued by the signed TwiML route, and it places no calls.
if (config.voice.enabled && config.publicBaseUrl) {
  attachLifecycleMedia(server, app.locals.lifecycle, app.locals.streamTokens);
  console.log('Media Streams endpoint: ON (token-authenticated; no live calls are placed)');
}

// Optional campaign runner. OFF by default so nothing dials automatically.
// When explicitly enabled, it claims the next eligible lead for running campaigns
// on an interval. It never places a real call — the dial attempt is simulated and
// outcomes are recorded through the IVR/AI engagement endpoints.
let runnerTimer = null;
if (config.campaigns.runnerEnabled) {
  const tick = () => {
    try {
      const running = db.prepare("SELECT id FROM campaigns WHERE status = 'running'").all();
      for (const { id } of running) {
        const result = claimNext(db, id, { username: 'runner', cfg: config });
        if (result.claimed) {
          console.log(
            `[campaign-runner] campaign ${id}: simulated dial for lead ${result.claimed.lead.id} (attempt ${result.claimed.attemptCount})`
          );
        }
      }
    } catch (err) {
      console.error('[campaign-runner] tick failed:', err.message);
    }
  };
  runnerTimer = setInterval(tick, config.campaigns.runnerIntervalMs);
  runnerTimer.unref();
  console.log(
    `Campaign runner: ON (every ${config.campaigns.runnerIntervalMs}ms) — simulated dials only`
  );
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `Port ${config.port} is already in use. Set a different PORT in .env (see .env.example) and try again.`
    );
  } else {
    console.error('[apexdialer] server error:', err);
  }
  process.exit(1);
});

function shutdown(signal) {
  console.log(`\n[apexdialer] received ${signal}; draining connections...`);
  if (runnerTimer) clearInterval(runnerTimer);
  const force = setTimeout(() => {
    console.error('[apexdialer] forced exit after shutdown timeout');
    process.exit(1);
  }, 10000);
  force.unref();
  server.close(() => {
    clearTimeout(force);
    try {
      db.close();
    } catch {
      // already closed
    }
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));