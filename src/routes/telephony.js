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

const SAFE_FIELDS = ['To', 'From', 'FromCountry', 'ToCountry', 'Direction', 'CallType', 'CallerName'];

function pick(input, fields, extra = {}) {
  const out = { ...extra };
  for (const f of fields) {
    const value = input[f];
    if (value !== undefined && value !== null) out[f] = value;
  }
  return out;
}

export function telephonyRouter(db, cfg = config) {
  const router = Router();

  router.post('/webhooks/twilio', (req, res) => {
    if (!cfg.telephony.enabled) {
      throw new HttpError(404, 'not_found');
    }
    if (!cfg.telephony.webhookSecret) {
      throw new HttpError(403, 'provider_disabled');
    }

    const url = webhookUrl(cfg, req);
    const valid = verifyTwilioSignature({
      url,
      params: req.body ?? {},
      signature: req.headers['x-twilio-signature'],
      authToken: cfg.telephony.webhookSecret,
    });
    if (!valid) {
      throw new HttpError(401, 'invalid_signature');
    }

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