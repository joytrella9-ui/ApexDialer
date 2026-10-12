import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(HERE, '..');

function truthy(value, dflt = true) {
  if (value === undefined || value === null || value === '') return dflt;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function positiveNumber(value, dflt) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

export function loadConfig(env = process.env) {
  const demoMode = truthy(env.APEX_DEMO_MODE, true);
  const sessionTtlHours = positiveNumber(env.APEX_SESSION_TTL_HOURS, 12);
  return {
    host: env.HOST || '127.0.0.1',
    port: Number(env.PORT || 3210),
    demoMode,
    dbPath: env.APEX_DB_PATH
      ? path.resolve(env.APEX_DB_PATH)
      : path.join(PROJECT_ROOT, 'data', 'apexdialer.db'),
    telephony: {
      provider: null,
      enabled: false,
      liveEnabled: false,
    },
    compliance: {
      callWindowStart: env.APEX_CALL_WINDOW_START || '08:00',
      callWindowEnd: env.APEX_CALL_WINDOW_END || '21:00',
    },
    auth: {
      sessionTtlHours,
      bcryptRounds: positiveNumber(env.APEX_BCRYPT_ROUNDS, 10),
      cookieName: 'apexdialer_session',
      cookieSecure: truthy(env.APEX_COOKIE_SECURE, false),
      loginWindowMs: positiveNumber(env.APEX_LOGIN_WINDOW_MS, 15 * 60 * 1000),
      loginMaxPerIp: positiveNumber(env.APEX_LOGIN_MAX_PER_IP, 20),
      loginFailureMax: positiveNumber(env.APEX_LOGIN_FAILURE_MAX, 5),
      setupWindowMs: positiveNumber(env.APEX_SETUP_WINDOW_MS, 60 * 60 * 1000),
      setupMax: positiveNumber(env.APEX_SETUP_MAX, 10),
    },
  };
}

export const config = loadConfig();