import { HttpError } from '../lib/errors.js';
import { isE164 } from '../providers/twilioVoice.js';
import { TwilioRestTransport } from '../providers/twilioRest.js';
import { loadWorkspaceSecrets, workspaceIsLiveReady } from './workspace.js';
import { audit } from './auth.js';

export function toE164(phone) {
  const raw = String(phone ?? '').trim();
  if (isE164(raw)) return raw;
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  if (raw.startsWith('+') && isE164(`+${digits}`)) return `+${digits}`;
  if (digits.length === 11 && digits.startsWith('1') && isE164(`+${digits}`)) return `+${digits}`;
  if (digits.length === 10 && isE164(`+1${digits}`)) return `+1${digits}`;
  if (isE164(`+${digits}`)) return `+${digits}`;
  return '';
}

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function createLiveTransport(cfg, fetchImpl) {
  return new TwilioRestTransport({
    accountSid: cfg.telephony?.accountSid || '',
    authToken: cfg.telephony?.authToken || cfg.telephony?.webhookSecret || '',
    liveEnabled: cfg.telephony?.liveEnabled === true,
    fetchImpl,
  });
}

export function clickToCallTwiml({ fromNumber, leadPhone }) {
  const from = xmlEscape(fromNumber);
  const to = xmlEscape(leadPhone);
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Say>Connecting your ApexDialer call.</Say>` +
    `<Dial callerId="${from}" timeout="45" hangupOnStar="true">` +
    `<Number>${to}</Number>` +
    `</Dial>` +
    `</Response>`
  );
}

export async function placeClickToCall(db, { callId, leadPhone, cfg, fetchImpl } = {}) {
  const ws = loadWorkspaceSecrets(db);
  if (!workspaceIsLiveReady(ws)) {
    throw new HttpError(409, 'live_calling_not_ready', { missing: ['integrations'] });
  }
  const toAgent = toE164(ws.agentPhone);
  const from = toE164(ws.fromNumber);
  const lead = toE164(leadPhone);
  if (!toAgent || !from || !lead) throw new HttpError(400, 'invalid_phone');
  if (toAgent === lead) throw new HttpError(409, 'agent_matches_lead');

  const transport = createLiveTransport(cfg, fetchImpl);
  const origin = ws.publicBaseUrl.replace(/\/+$/, '');
  const created = await transport.createCall({
    to: toAgent,
    from,
    twimlUrl: `${origin}/api/telephony/webhooks/twiml/${Number(callId)}`,
    statusCallbackUrl: `${origin}/api/telephony/webhooks/twilio`,
  });

  db.prepare('UPDATE calls SET provider_call_sid = ? WHERE id = ?').run(created.sid, callId);
  audit(db, 'system', 'provider_call_created', 'call', String(callId), JSON.stringify({ sid: created.sid }));
  return { sid: created.sid, status: created.status, to: toAgent, lead };
}

export async function hangupProviderCall(cfg, sid, fetchImpl) {
  const callSid = String(sid ?? '');
  if (!/^CA[0-9a-fA-F]{32}$/.test(callSid)) return { skipped: true };
  if (cfg?.telephony?.liveEnabled !== true) return { skipped: true };
  const transport = createLiveTransport(cfg, fetchImpl);
  try {
    await transport.endCall(callSid);
    return { hungUp: true, sid: callSid };
  } catch {
    return { hungUp: false, sid: callSid };
  }
}
