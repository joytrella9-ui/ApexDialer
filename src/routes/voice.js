import { Router } from 'express';
import { HttpError } from '../lib/errors.js';
import { config } from '../config.js';
import {
  verifyVoiceSignature,
  FAKE_VOICE_STATUS_MAP,
  VOICE_TERMINAL_STATUSES,
} from '../providers/fakeVoice.js';
import * as voice from '../services/voiceSessions.js';
import { executeAiToolCall } from '../services/aiToolExecutor.js';
import { webhookUrl } from '../lib/webhookUrl.js';
import { verifyTwilioSignature } from '../providers/twilio.js';
import { normalizeTwilioVoiceEvent } from '../providers/twilioVoice.js';
import { buildConnectStreamTwiml } from '../providers/twilioTwiml.js';
import { MEDIA_PATH } from '../providers/mediaStreamServer.js';
import { startVoiceSessionSchema, voiceTurnSchema, endVoiceSessionSchema } from '../validate/voice.js';

function actor(req) {
  return req.auth?.user?.username ?? 'system';
}

function parseId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'invalid_id');
  return id;
}

const SAFE_FIELDS = ['to', 'from', 'reason', 'callSid'];
const MAX_DETAIL_LENGTH = 512;

// Keep only known scalar fields, stringified and length-capped, so hostile or
// oversized callback bodies cannot bloat stored provider event data.
function pick(input) {
  const out = {};
  for (const f of SAFE_FIELDS) {
    const value = input?.[f];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue;
    out[f] = String(value).slice(0, MAX_DETAIL_LENGTH);
  }
  return out;
}

// Public, signature-verified provider callback endpoint. Mounted before requireAuth
// (providers cannot present cookies). It updates the call + voice session and is
// idempotent on repeated deliveries.
export function voiceWebhookRouter(db, cfg = config, tokens = null, lifecycle = null) {
  const router = Router();

  // Twilio fetches this TwiML when a call is answered. It must be signed by Twilio
  // (X-Twilio-Signature over the public URL), must name the session's own call SID,
  // and returns a <Connect><Stream> pointing at the media endpoint with a single-use
  // token. Nothing here places a call.
  router.post('/twiml/:sessionId', (req, res) => {
    if (!cfg.voice.enabled) throw new HttpError(404, 'not_found');
    if (!cfg.telephony.webhookSecret) throw new HttpError(403, 'provider_disabled');
    if (!cfg.publicBaseUrl) throw new HttpError(403, 'public_base_url_required');
    if (!tokens) throw new HttpError(503, 'media_unavailable');

    const valid = verifyTwilioSignature({
      url: webhookUrl(cfg, req),
      params: req.body ?? {},
      signature: req.headers['x-twilio-signature'],
      authToken: cfg.telephony.webhookSecret,
    });
    if (!valid) throw new HttpError(401, 'invalid_signature');

    const sessionId = Number(req.params.sessionId);
    if (!Number.isInteger(sessionId) || sessionId <= 0) throw new HttpError(400, 'invalid_id');
    const row = db
      .prepare('SELECT id, provider_call_sid, status FROM voice_sessions WHERE id = ?')
      .get(sessionId);
    if (!row || !['starting', 'ringing', 'in_progress'].includes(row.status)) {
      throw new HttpError(404, 'voice_session_not_found');
    }
    if (!row.provider_call_sid || row.provider_call_sid !== String(req.body?.CallSid ?? '')) {
      throw new HttpError(403, 'call_mismatch');
    }

    const token = tokens.issue(row.id);
    const streamUrl = `${cfg.publicBaseUrl.replace(/^https:/, 'wss:')}${MEDIA_PATH}`;
    const xml = buildConnectStreamTwiml({
      streamUrl,
      parameters: { token, sessionId: String(row.id) },
    });
    res.type('text/xml').send(xml);
  });

  // Twilio status callback for a voice session. Signed over the public URL with the
  // Twilio secret. Idempotent: a repeated delivery of the same status is recorded once
  // (provider_events unique index). Freshness is NOT verified: Twilio's callback does
  // not carry a signed timestamp, so a replayed, valid callback is absorbed as a
  // duplicate or as a no-op on a terminal session, never as a new transition.
  router.post('/twilio/status', (req, res) => {
    if (!cfg.voice.enabled) throw new HttpError(404, 'not_found');
    if (!cfg.telephony.webhookSecret) throw new HttpError(403, 'provider_disabled');
    if (!cfg.publicBaseUrl) throw new HttpError(403, 'public_base_url_required');
    const params = req.body ?? {};
    const valid = verifyTwilioSignature({
      url: webhookUrl(cfg, req),
      params,
      signature: req.headers['x-twilio-signature'],
      authToken: cfg.telephony.webhookSecret,
    });
    if (!valid) throw new HttpError(401, 'invalid_signature');

    const event = normalizeTwilioVoiceEvent(params);
    if (!event.sid) throw new HttpError(400, 'missing_sid');
    const input = {
      provider: 'twilio',
      eventId: event.eventId,
      sid: event.sid,
      status: event.status,
      terminal: event.terminal,
      rawStatus: event.rawStatus,
      details: pick(params),
    };
    const result = lifecycle ? lifecycle.onProviderStatus(input) : voice.handleProviderEvent(db, input, cfg);
    res.json({ data: result });
  });
  router.post('/fake', (req, res) => {
    if (!cfg.voice.enabled) throw new HttpError(404, 'not_found');
    if (!cfg.voice.webhookSecret) throw new HttpError(403, 'provider_disabled');

    const url = webhookUrl(cfg, req);
    const valid = verifyVoiceSignature({
      url,
      params: req.body ?? {},
      signature: req.headers['x-apex-voice-signature'],
      secret: cfg.voice.webhookSecret,
    });
    if (!valid) throw new HttpError(401, 'invalid_signature');

    const body = req.body ?? {};
    const sid = String(body.sid ?? '').trim();
    if (!sid) throw new HttpError(400, 'missing_sid');

    const rawStatus = String(body.status ?? '').trim();
    const mapped = FAKE_VOICE_STATUS_MAP[rawStatus] ?? null;
    const terminal = mapped !== null && VOICE_TERMINAL_STATUSES.has(mapped);

    const result = voice.handleProviderEvent(
      db,
      {
        provider: 'fake-voice',
        eventId: String(body.eventId ?? `${sid}:${rawStatus}`),
        sid,
        status: mapped,
        terminal,
        rawStatus,
        details: pick(body),
      },
      cfg
    );

    res.json({ data: result });
  });

  return router;
}

// Authenticated control surface for voice sessions.
export function voiceRouter(db, cfg = config) {
  const router = Router();

  // When the voice subsystem is disabled (the default, and always the case in
  // demo mode) the control surface does not exist. This is the second gate that
  // guarantees no session — simulated or otherwise — can be started.
  router.use((req, res, next) => {
    if (!cfg.voice.enabled) throw new HttpError(404, 'not_found');
    next();
  });

  router.post('/sessions', (req, res) => {
    const parsed = startVoiceSessionSchema.parse(req.body ?? {});
    const session = voice.startVoiceSession(db, { ...parsed, username: actor(req), cfg });
    res.status(201).json({ data: session });
  });

  router.get('/sessions/:id', (req, res) => {
    const session = voice.getVoiceSession(db, parseId(req.params.id));
    if (!session) throw new HttpError(404, 'voice_session_not_found');
    res.json({ data: session });
  });

  router.post('/sessions/:id/turn', (req, res) => {
    const parsed = voiceTurnSchema.parse(req.body ?? {});
    const result = voice.handleTurn(db, parseId(req.params.id), parsed, actor(req), cfg);
    res.json({ data: result });
  });

  // Server-side execution of a model tool call. The body is untrusted: the name
  // must be on the allowlist and the arguments are strictly validated inside the
  // executor, which also enforces the call budget, duplicate guard, answer state,
  // suppression policy, and duration cap.
  router.post('/sessions/:id/tools', (req, res) => {
    const id = parseId(req.params.id);
    const session = voice.getVoiceSession(db, id);
    if (!session) throw new HttpError(404, 'voice_session_not_found');
    const startedMs = Date.parse(`${String(session.startedAt ?? '').replace(' ', 'T')}Z`);
    const elapsedMs = Number.isFinite(startedMs) ? Math.max(0, Date.now() - startedMs) : 0;
    const result = executeAiToolCall(db, { id }, req.body ?? {}, { cfg, elapsedMs });
    res.json({ data: result });
  });

  router.post('/sessions/:id/end', (req, res) => {
    const parsed = endVoiceSessionSchema.parse(req.body ?? {});
    const session = voice.endVoiceSession(db, parseId(req.params.id), parsed, actor(req), cfg);
    res.json({ data: session });
  });

  return router;
}
