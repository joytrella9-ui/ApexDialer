import { Router } from 'express';
import { HttpError } from '../lib/errors.js';
import { config } from '../config.js';
import {
  verifyTwilioSignature,
  TWILIO_STATUS_MAP,
  TWILIO_TERMINAL_STATUSES,
  INTERNAL_TERMINAL_STATUSES,
} from '../providers/twilio.js';
import { acceptProviderEvent } from '../services/calls.js';
import { webhookUrl } from '../lib/webhookUrl.js';
import { clickToCallTwiml, toE164 } from '../services/clickToCall.js';

const SAFE_FIELDS = ['To', 'From', 'FromCountry', 'ToCountry', 'Direction', 'CallType', 'CallerName'];

function pick(input, fields, extra = {}) {
  const out = { ...extra };
  for (const f of fields) {
    const value = input[f];
    if (value !== undefined && value !== null) out[f] = value;
  }
  return out;
}

function requireTwilioSignature(cfg, req) {
  if (!cfg.telephony.enabled && !cfg.telephony.liveEnabled) {
    throw new HttpError(404, 'not_found');
  }
  const secret = cfg.telephony.webhookSecret || cfg.telephony.authToken || '';
  if (!secret) throw new HttpError(403, 'provider_disabled');
  const url = webhookUrl(cfg, req);
  const valid = verifyTwilioSignature({
    url,
    params: req.body ?? {},
    signature: req.headers['x-twilio-signature'],
    authToken: secret,
  });
  if (!valid) throw new HttpError(401, 'invalid_signature');
}

export function telephonyRouter(db, cfg = config) {
  const router = Router();

  router.post('/webhooks/twiml/:callId', (req, res) => {
    requireTwilioSignature(cfg, req);
    const callId = Number(req.params.callId);
    if (!Number.isInteger(callId) || callId <= 0) throw new HttpError(400, 'invalid_id');
    const row = db
      .prepare(
        `SELECT c.id, c.status, l.phone AS lead_phone
           FROM calls c
           LEFT JOIN leads l ON l.id = c.lead_id
          WHERE c.id = ?`
      )
      .get(callId);
    if (!row || !['in_progress', 'paused', 'queued', 'ringing'].includes(row.status)) {
      res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
      return;
    }
    const leadPhone = toE164(row.lead_phone);
    const from = toE164(cfg.telephony.fromNumber || cfg.voice.fromNumber);
    if (!leadPhone || !from) {
      res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>This call cannot be connected.</Say><Hangup/></Response>');
      return;
    }
    res.type('text/xml').send(clickToCallTwiml({ fromNumber: from, leadPhone }));
  });

  router.post('/webhooks/twilio', (req, res) => {
    requireTwilioSignature(cfg, req);

    const body = req.body ?? {};
    const sid = String(body.CallSid ?? '').trim();
    if (!sid) {
      throw new HttpError(400, 'missing_sid');
    }

    const rawStatus = String(body.CallStatus ?? '').trim();
    const mapped = TWILIO_STATUS_MAP[rawStatus] ?? null;
    const terminal =
      TWILIO_TERMINAL_STATUSES.has(rawStatus) ||
      (mapped !== null && INTERNAL_TERMINAL_STATUSES.has(mapped));

    const result = acceptProviderEvent(db, {
      provider: 'twilio',
      eventId: `${sid}:${rawStatus}`,
      sid,
      status: mapped,
      terminal,
      rawStatus,
      details: pick(body, SAFE_FIELDS),
    });

    res.json({ data: result });
  });

  return router;
}