import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(HERE, '..');

function truthy(value, dflt = true) {
  if (value === undefined || value === null || value === '') return dflt;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

export function loadConfig(env = process.env) {
  const demoMode = truthy(env.APEX_DEMO_MODE, true);
  return {
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
  };
}

export const config = loadConfig();