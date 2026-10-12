import 'dotenv/config';
import { config } from './config.js';
import { createDb } from './db/db.js';
import { createApp } from './app.js';

const db = createDb(config.dbPath);
const app = createApp(db);
const server = app.listen(config.port, () => {
  console.log(`ApexDialer backend listening on http://localhost:${config.port}`);
  console.log(
    `Demo mode: ${config.demoMode ? 'ON' : 'OFF'} · Telephony: ${config.telephony.provider ?? 'none'} · DB: ${config.dbPath}`
  );
});

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