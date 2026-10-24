import { HttpError } from '../lib/errors.js';
import { encryptSecret, decryptSecret, maskSecret } from '../lib/secrets.js';
import { integrationsUpdateSchema } from '../validate/workspace.js';
import { isE164 } from '../providers/twilioVoice.js';
import { audit } from './auth.js';

const SECRET_KEYS = Object.freeze({
  accountSid: 'twilio_account_sid',
  authToken: 'twilio_auth_token',
});

const CONFIG_KEYS = Object.freeze({
  fromNumber: 'twilio_from_number',
  agentPhone: 'agent_phone',
  publicBaseUrl: 'public_base_url',
  liveEnabled: 'live_outbound_enabled',
});

function getSecret(db, key) {
  const row = db.prepare('SELECT value FROM workspace_secrets WHERE key = ?').get(key);
  return row ? decryptSecret(row.value) : '';
}

function getConfig(db, key) {
  const row = db.prepare('SELECT value FROM workspace_config WHERE key = ?').get(key);
  return row ? String(row.value) : '';
}

function putSecret(db, key, value) {
  if (value === undefined) return;
  const text = String(value ?? '');
  if (text === '') return;
  db.prepare(
    `INSERT INTO workspace_secrets (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  ).run(key, encryptSecret(text));
}

function putConfig(db, key, value) {
  if (value === undefined) return;
  db.prepare(
    `INSERT INTO workspace_config (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  ).run(key, String(value ?? ''));
}

export function loadWorkspaceSecrets(db) {
  return {
    accountSid: getSecret(db, SECRET_KEYS.accountSid),
    authToken: getSecret(db, SECRET_KEYS.authToken),
    fromNumber: getConfig(db, CONFIG_KEYS.fromNumber),
    agentPhone: getConfig(db, CONFIG_KEYS.agentPhone),
    publicBaseUrl: getConfig(db, CONFIG_KEYS.publicBaseUrl),
    liveEnabled: getConfig(db, CONFIG_KEYS.liveEnabled) === 'true',
  };
}

export function missingLiveRequirements(ws) {
  const missing = [];
  if (!ws.accountSid) missing.push('twilioAccountSid');
  if (!ws.authToken) missing.push('twilioAuthToken');
  if (!isE164(ws.fromNumber)) missing.push('twilioFromNumber');
  if (!isE164(ws.agentPhone)) missing.push('agentPhone');
  if (!ws.publicBaseUrl) missing.push('publicBaseUrl');
  return missing;
}

export function workspaceIsLiveReady(ws) {
  return ws.liveEnabled === true && missingLiveRequirements(ws).length === 0;
}

export function publicWorkspace(db) {
  const ws = loadWorkspaceSecrets(db);
  const missing = missingLiveRequirements(ws);
  return {
    liveOutboundEnabled: ws.liveEnabled,
    ready: workspaceIsLiveReady(ws),
    missing,
    twilioAccountSidSet: Boolean(ws.accountSid),
    twilioAccountSidMasked: ws.accountSid ? maskSecret(ws.accountSid, { prefix: 2, suffix: 4 }) : '',
    twilioAuthTokenSet: Boolean(ws.authToken),
    twilioFromNumber: ws.fromNumber,
    agentPhone: ws.agentPhone,
    publicBaseUrl: ws.publicBaseUrl,
    mode: workspaceIsLiveReady(ws) ? 'live' : 'demo',
  };
}

export function saveIntegrations(db, input, actor) {
  const parsed = integrationsUpdateSchema.parse(input ?? {});
  const current = loadWorkspaceSecrets(db);

  const next = {
    accountSid: parsed.twilioAccountSid !== undefined && parsed.twilioAccountSid !== '' ? parsed.twilioAccountSid : current.accountSid,
    authToken: parsed.twilioAuthToken !== undefined && parsed.twilioAuthToken !== '' ? parsed.twilioAuthToken : current.authToken,
    fromNumber: parsed.twilioFromNumber !== undefined ? parsed.twilioFromNumber : current.fromNumber,
    agentPhone: parsed.agentPhone !== undefined ? parsed.agentPhone : current.agentPhone,
    publicBaseUrl: parsed.publicBaseUrl !== undefined ? parsed.publicBaseUrl : current.publicBaseUrl,
    liveEnabled: parsed.liveOutboundEnabled !== undefined ? parsed.liveOutboundEnabled : current.liveEnabled,
  };

  if (next.liveEnabled) {
    const missing = missingLiveRequirements(next);
    if (missing.length) {
      throw new HttpError(400, 'integrations_incomplete', {
        missing,
        message: 'Real outbound calling cannot be enabled until every required field is saved.',
      });
    }
  }

  const apply = db.transaction(() => {
    putSecret(db, SECRET_KEYS.accountSid, parsed.twilioAccountSid);
    putSecret(db, SECRET_KEYS.authToken, parsed.twilioAuthToken);
    putConfig(db, CONFIG_KEYS.fromNumber, parsed.twilioFromNumber);
    putConfig(db, CONFIG_KEYS.agentPhone, parsed.agentPhone);
    putConfig(db, CONFIG_KEYS.publicBaseUrl, parsed.publicBaseUrl);
    if (parsed.liveOutboundEnabled !== undefined) {
      putConfig(db, CONFIG_KEYS.liveEnabled, parsed.liveOutboundEnabled ? 'true' : 'false');
    }
    audit(
      db,
      actor,
      'integrations_updated',
      'workspace',
      'telephony',
      JSON.stringify({
        liveOutboundEnabled: next.liveEnabled,
        fields: Object.keys(parsed).filter((k) => parsed[k] !== undefined && k !== 'twilioAuthToken'),
      })
    );
  });
  apply();
  return publicWorkspace(db);
}

// Overlay operator-saved workspace values onto the process config object.
// Env/mergeConfig still cannot turn live calling on by itself; this can, but
// only after credentials exist and the admin enabled the live switch.
export function applyWorkspaceConfig(db, cfg) {
  let ws;
  try {
    ws = loadWorkspaceSecrets(db);
  } catch {
    return cfg;
  }
  cfg.workspace = {
    liveOutboundEnabled: ws.liveEnabled,
    ready: workspaceIsLiveReady(ws),
    missing: missingLiveRequirements(ws),
    mode: workspaceIsLiveReady(ws) ? 'live' : 'demo',
  };
  if (ws.publicBaseUrl) cfg.publicBaseUrl = ws.publicBaseUrl;
  if (ws.accountSid) cfg.telephony.accountSid = ws.accountSid;
  if (ws.authToken) {
    cfg.telephony.authToken = ws.authToken;
    cfg.telephony.webhookSecret = ws.authToken;
  }
  if (ws.fromNumber) {
    cfg.telephony.fromNumber = ws.fromNumber;
    cfg.voice.fromNumber = ws.fromNumber;
  }
  cfg.telephony.agentPhone = ws.agentPhone || '';
  if (workspaceIsLiveReady(ws)) {
    cfg.demoMode = false;
    cfg.telephony.enabled = true;
    cfg.telephony.provider = 'twilio';
    cfg.telephony.liveEnabled = true;
    cfg.voice.provider = 'twilio';
    cfg.voice.liveEnabled = true;
    cfg.voice.fromNumber = ws.fromNumber;
    if (ws.authToken) cfg.voice.webhookSecret = cfg.voice.webhookSecret || ws.authToken;
  }
  return cfg;
}
