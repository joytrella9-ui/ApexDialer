import { config } from '../config.js';
import { HttpError } from '../lib/errors.js';
import { audit } from './auth.js';
import { getLead } from './leads.js';
import { evaluateLead } from './compliance.js';
import { evaluateDialerEligibility } from './dialerEligibility.js';
import { getCampaign, getCampaignLeadForApi, applyCampaignOutcome } from './campaigns.js';
import { createVoiceProvider } from '../providers/voice.js';
import { VOICE_TERMINAL_STATUSES } from '../providers/fakeVoice.js';
import { normalizeProviderEvent } from '../providers/contracts.js';
import { classifyIntent, recordTranscript } from './ai.js';
import {
  VOICE_PHASES,
  VOICE_OUTCOMES,
  voiceScript,
  greetingAction,
  processVoiceEvent,
} from './voiceAgent.js';
import { startVoiceSessionSchema, voiceTurnSchema, endVoiceSessionSchema } from '../validate/voice.js';

const ACTIVE_STATUSES = "('starting','ringing','in_progress')";

function toVoiceEvent(row) {
  let payload = {};
  try {
    payload = row.payload ? JSON.parse(row.payload) : {};
  } catch {
    payload = { raw: row.payload };
  }
  return { id: row.id, type: row.event_type, direction: row.direction, payload, createdAt: row.created_at };
}

function toVoiceSession(row) {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    leadId: row.lead_id,
    callId: row.call_id,
    provider: row.provider,
    providerCallSid: row.provider_call_sid,
    status: row.status,
    phase: row.phase,
    disclosurePlayed: row.disclosure_played === 1,
    turnCount: row.turn_count,
    silenceCount: row.silence_count,
    invalidCount: row.invalid_count,
    outcome: row.outcome,
    disconnectReason: row.disconnect_reason,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    updatedAt: row.updated_at,
  };
}

function addVoiceEvent(db, sessionId, type, direction, payload = {}) {
  db.prepare('INSERT INTO voice_events (session_id, event_type, direction, payload) VALUES (?, ?, ?, ?)').run(
    sessionId,
    type,
    direction,
    JSON.stringify(payload)
  );
}

export function getVoiceSession(db, id) {
  const row = db.prepare('SELECT * FROM voice_sessions WHERE id = ?').get(id);
  if (!row) return null;
  const session = toVoiceSession(row);
  session.events = db
    .prepare('SELECT * FROM voice_events WHERE session_id = ? ORDER BY id')
    .all(id)
    .map(toVoiceEvent);
  return session;
}

function agentStateFromRow(row) {
  return {
    phase: row.phase,
    turns: row.turn_count,
    silence: row.silence_count,
    invalid: row.invalid_count,
    disclosurePlayed: row.disclosure_played === 1,
    ended: false,
    outcome: null,
    reason: '',
  };
}

// Terminalize a session: persist the outcome, mirror it onto the linked call, and
// push the disposition back into the owning campaign. Normalizes unknown/empty
// outcomes (e.g. an abrupt stream disconnect) to `unanswered`.
export function finalizeSession(db, session, { outcome = '', reason = '', username = 'system', cfg = config } = {}) {
  const norm = VOICE_OUTCOMES.includes(outcome) ? outcome : 'unanswered';
  const sessionStatus = norm === 'failed' ? 'failed' : 'ended';
  const callStatus = norm === 'failed' ? 'aborted' : 'completed';

  const run = db.transaction(() => {
    const info = db
      .prepare(
        `UPDATE voice_sessions
            SET status = ?, outcome = ?, disconnect_reason = ?,
                ended_at = COALESCE(ended_at, datetime('now')), updated_at = datetime('now')
          WHERE id = ? AND status IN ${ACTIVE_STATUSES}`
      )
      .run(sessionStatus, norm, reason, session.id);
    if (info.changes === 0) return;

    if (session.call_id) {
      db.prepare(
        `UPDATE calls
            SET status = ?, ended_at = COALESCE(ended_at, datetime('now')), disposition = ?,
                duration_seconds = CASE WHEN duration_seconds > 0 THEN duration_seconds
                                        ELSE CAST(strftime('%s','now') - strftime('%s', COALESCE(started_at, 'now')) AS INTEGER) END
          WHERE id = ?`
      ).run(callStatus, norm, session.call_id);
      db.prepare('INSERT INTO call_events (call_id, event_type, event_data) VALUES (?, ?, ?)').run(
        session.call_id,
        'voice_session_ended',
        JSON.stringify({ outcome: norm, reason })
      );
    }
    addVoiceEvent(db, session.id, 'session_ended', 'system', { outcome: norm, reason });
    audit(db, username, 'voice_session_ended', 'voice_session', String(session.id), JSON.stringify({ outcome: norm, reason }));
  });
  run();

  if (session.campaign_id && session.lead_id) {
    applyCampaignOutcome(db, session.campaign_id, session.lead_id, norm, { username, cfg });
  }
  return getVoiceSession(db, session.id);
}

// Start a simulated voice session for a lead that the campaign engine has already
// claimed (`dialing`). Creates the linked call row, asks the provider to begin
// the call, and on provider failure marks the attempt failed and requeues it.
export function startVoiceSession(db, { campaignId, leadId, username = 'system', cfg = config } = {}) {
  const parsed = startVoiceSessionSchema.parse({ campaignId, leadId });

  const campaign = getCampaign(db, parsed.campaignId);
  if (!campaign) throw new HttpError(404, 'campaign_not_found');
  if (campaign.status !== 'running') throw new HttpError(409, 'campaign_not_running', { status: campaign.status });

  const cl = getCampaignLeadForApi(db, parsed.campaignId, parsed.leadId);
  if (!cl) throw new HttpError(404, 'campaign_lead_not_found');
  if (cl.status !== 'dialing') throw new HttpError(409, 'invalid_transition', { status: cl.status });

  const active = db
    .prepare(`SELECT id FROM voice_sessions WHERE lead_id = ? AND status IN ${ACTIVE_STATUSES}`)
    .get(parsed.leadId);
  if (active) throw new HttpError(409, 'voice_session_active', { sessionId: active.id });

  const lead = getLead(db, parsed.leadId);
  if (!lead) throw new HttpError(404, 'lead_not_found');

  const decision = cfg.compliance.requireComplianceProfile
    ? evaluateDialerEligibility(db, { campaign, lead, cfg })
    : evaluateLead(db, lead, {
        window: { start: campaign.callWindowStart, end: campaign.callWindowEnd },
      });
  if (decision.decision !== 'allowed') {
    throw new HttpError(409, 'not_eligible', { decision: decision.decision, compliance: decision });
  }

  const provider = createVoiceProvider(cfg.voice);

  let sessionId;
  try {
    const create = db.transaction(() => {
      const callInfo = db
        .prepare(
          `INSERT INTO calls (lead_id, user_id, direction, status, call_type, disposition, provider_call_sid, started_at, notes)
           VALUES (?, NULL, 'outbound', 'queued', ?, '', '', datetime('now'), '')`
        )
        .run(lead.id, lead.callType);
      const callId = Number(callInfo.lastInsertRowid);
      db.prepare('INSERT INTO call_events (call_id, event_type, event_data) VALUES (?, ?, ?)').run(
        callId,
        'voice_session_starting',
        JSON.stringify({ campaignId: parsed.campaignId, leadId: lead.id })
      );
      const sessionInfo = db
        .prepare(
          `INSERT INTO voice_sessions (campaign_id, lead_id, call_id, provider, status, phase, started_at)
           VALUES (?, ?, ?, ?, 'starting', 'greeting', datetime('now'))`
        )
        .run(parsed.campaignId, lead.id, callId, provider.name);
      return Number(sessionInfo.lastInsertRowid);
    });
    sessionId = create();
  } catch (err) {
    if (/UNIQUE/i.test(String(err.message))) throw new HttpError(409, 'voice_session_active', {});
    throw err;
  }

  try {
    // Caller ID is the configured outbound number, never the transfer destination.
    const started = provider.startOutboundCall({ to: lead.phone, from: cfg.voice.fromNumber ?? '', sessionId });
    const run = db.transaction(() => {
      db.prepare(
        "UPDATE voice_sessions SET provider_call_sid = ?, status = 'ringing', updated_at = datetime('now') WHERE id = ?"
      ).run(started.sid, sessionId);
      const row = db.prepare('SELECT call_id FROM voice_sessions WHERE id = ?').get(sessionId);
      db.prepare("UPDATE calls SET status = 'in_progress', provider_call_sid = ? WHERE id = ?").run(
        started.sid,
        row.call_id
      );
      addVoiceEvent(db, sessionId, 'provider_started', 'system', { sid: started.sid });
    });
    run();
    audit(
      db,
      username,
      'voice_session_started',
      'voice_session',
      String(sessionId),
      JSON.stringify({ campaignId: parsed.campaignId, leadId: lead.id, sid: started.sid })
    );
    return getVoiceSession(db, sessionId);
  } catch {
    const run = db.transaction(() => {
      const row = db.prepare('SELECT call_id FROM voice_sessions WHERE id = ?').get(sessionId);
      db.prepare(
        "UPDATE voice_sessions SET status = 'failed', outcome = 'failed', disconnect_reason = 'provider_start_failed', ended_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
      ).run(sessionId);
      if (row?.call_id) {
        db.prepare("UPDATE calls SET status = 'aborted', ended_at = datetime('now') WHERE id = ?").run(row.call_id);
        db.prepare('INSERT INTO call_events (call_id, event_type, event_data) VALUES (?, ?, ?)').run(
          row.call_id,
          'voice_session_failed',
          JSON.stringify({ reason: 'provider_start_failed' })
        );
      }
      addVoiceEvent(db, sessionId, 'provider_error', 'system', { reason: 'provider_start_failed' });
    });
    run();
    applyCampaignOutcome(db, parsed.campaignId, parsed.leadId, 'failed', { username, cfg });
    throw new HttpError(502, 'provider_start_failed');
  }
}

// Apply one caller/agent turn to a live session and persist the result. When the
// agent decides the conversation is over the session is finalized with the
// resulting campaign disposition.
export function handleTurn(db, sessionId, input, username = 'system', cfg = config) {
  const parsed = voiceTurnSchema.parse(input);
  const row = db.prepare('SELECT * FROM voice_sessions WHERE id = ?').get(sessionId);
  if (!row) throw new HttpError(404, 'voice_session_not_found');
  if (VOICE_TERMINAL_STATUSES.has(row.status)) throw new HttpError(409, 'voice_session_ended', { status: row.status });

  // Caller-driven turns are only meaningful once the provider has confirmed the
  // call was answered. Without this, an operator could "complete" a call that
  // never connected — the session must never be advanced past ring-back on
  // anything other than an authoritative provider event.
  const callerTypes = ['speech', 'dtmf', 'silence', 'interrupt'];
  if (callerTypes.includes(parsed.type) && row.status !== 'in_progress') {
    throw new HttpError(409, 'voice_not_answered', { status: row.status });
  }

  const script = voiceScript(cfg.voice);
  const result = processVoiceEvent(agentStateFromRow(row), { type: parsed.type, text: parsed.text, digit: parsed.digit }, {
    script,
    maxTurns: cfg.voice.maxTurns,
    maxSilenceRetries: cfg.voice.maxSilenceRetries,
    maxInvalid: cfg.voice.maxInvalid,
  });

  const run = db.transaction(() => {
    if (parsed.type === 'speech' && parsed.text) {
      recordTranscript(db, {
        campaignId: row.campaign_id,
        leadId: row.lead_id,
        callRef: row.provider_call_sid,
        role: 'lead',
        text: parsed.text,
        intent: classifyIntent(parsed.text),
      });
    }
    addVoiceEvent(db, row.id, `lead:${parsed.type}`, 'inbound', { text: parsed.text ?? '', digit: parsed.digit ?? '' });
    for (const line of result.say) {
      addVoiceEvent(db, row.id, 'ai:say', 'outbound', { text: line });
      recordTranscript(db, {
        campaignId: row.campaign_id,
        leadId: row.lead_id,
        callRef: row.provider_call_sid,
        role: 'ai',
        text: line,
        intent: '',
      });
    }
    db.prepare(
      `UPDATE voice_sessions
          SET phase = ?, turn_count = ?, silence_count = ?, invalid_count = ?,
              disclosure_played = MAX(disclosure_played, ?), updated_at = datetime('now')
        WHERE id = ?`
    ).run(
      result.state.phase,
      result.state.turns,
      result.state.silence,
      result.state.invalid,
      result.state.disclosurePlayed ? 1 : 0,
      row.id
    );
  });
  run();

  if (result.end) {
    finalizeSession(db, row, { outcome: result.outcome, reason: result.reason, username, cfg });
  }

  return {
    session: getVoiceSession(db, row.id),
    agent: {
      phase: result.state.phase,
      ended: result.end,
      outcome: result.outcome,
      reason: result.reason,
      say: result.say,
    },
  };
}

// Consume a verified provider callback. Idempotency and call-status updates are
// delegated to calls.acceptProviderEvent (dedup via provider_events); this layer
// additionally advances/finishes the voice session. Callbacks for an already
// terminal session are ignored without touching the linked call.
export function handleProviderEvent(db, input, cfg = config) {
  // Validate everything crossing the provider boundary against the typed event
  // contract. Malformed or oversized payloads throw a ZodError (→ 400) at the
  // edge instead of reaching the state machine or the database.
  const event = normalizeProviderEvent({
    provider: input?.provider ?? 'fake-voice',
    eventId: input?.eventId ?? '',
    sid: input?.sid ?? '',
    status: input?.status ?? null,
    rawStatus: input?.rawStatus ?? '',
    terminal: Boolean(input?.terminal),
    details: input?.details ?? {},
  });
  const { sid, provider, eventId, status, rawStatus } = event;
  const terminal = event.terminal;

  const session = db.prepare('SELECT * FROM voice_sessions WHERE provider_call_sid = ?').get(sid);
  if (!session) return { type: 'ignored', reason: 'session_not_found' };
  if (VOICE_TERMINAL_STATUSES.has(session.status)) {
    return { type: 'ignored', reason: 'session_terminal', sessionId: session.id };
  }

  if (status === null) {
    addVoiceEvent(db, session.id, 'provider:unknown', 'inbound', { rawStatus });
    return { type: 'recorded', reason: 'unknown_status', sessionId: session.id };
  }

  const already = db
    .prepare('SELECT 1 FROM provider_events WHERE provider = ? AND event_id = ?')
    .get(provider, eventId);
  if (already) return { type: 'ignored', reason: 'duplicate', sessionId: session.id };

  const applyCall = db.transaction(() => {
    db.prepare(
      'INSERT INTO provider_events (provider, event_id, call_id, event_type, event_data) VALUES (?, ?, ?, ?, ?)'
    ).run(provider, eventId, session.call_id, rawStatus, JSON.stringify(event.details));
    db.prepare('INSERT INTO call_events (call_id, event_type, event_data) VALUES (?, ?, ?)').run(
      session.call_id,
      'provider_status',
      JSON.stringify({ provider, sid, status, rawStatus })
    );
    if (terminal) {
      db.prepare(
        `UPDATE calls
            SET status = ?, ended_at = COALESCE(ended_at, datetime('now')),
                duration_seconds = CASE WHEN duration_seconds > 0 THEN duration_seconds
                                        ELSE CAST(strftime('%s','now') - strftime('%s', COALESCE(started_at, 'now')) AS INTEGER) END
          WHERE id = ?`
      ).run(status, session.call_id);
    } else {
      // Forward-only: a late/out-of-order ring must not pull a call that has
      // already connected (or finished) back to an earlier state.
      db.prepare(
        "UPDATE calls SET status = ? WHERE id = ? AND status NOT IN ('in_progress','completed','aborted')"
      ).run(status, session.call_id);
    }
    addVoiceEvent(db, session.id, `provider:${status}`, 'inbound', { rawStatus, eventId });
    audit(db, 'provider', 'provider_status', 'call', String(session.call_id), JSON.stringify({ provider, sid, status, rawStatus }));
  });
  try {
    applyCall();
  } catch (err) {
    // The unique index on (provider, event_id) is the ultimate idempotency guard;
    // treat any insert collision as a duplicate delivery.
    if (/UNIQUE/i.test(String(err.message))) {
      return { type: 'ignored', reason: 'duplicate', sessionId: session.id };
    }
    throw err;
  }

  if (status === 'starting' || status === 'ringing') {
    // Forward-only session transition: only advance from `starting`, never
    // downgrade a session that has already been answered.
    db.prepare(
      "UPDATE voice_sessions SET status = ?, updated_at = datetime('now') WHERE id = ? AND status = 'starting'"
    ).run(status, session.id);
    return { type: 'applied', sessionId: session.id, callId: session.call_id, status };
  }

  if (status === 'in_progress') {
    const fresh = db.prepare('SELECT * FROM voice_sessions WHERE id = ?').get(session.id);
    if (fresh.status !== 'in_progress') {
      const greeting = greetingAction(voiceScript(cfg.voice));
      const run = db.transaction(() => {
        for (const line of greeting.say) {
          addVoiceEvent(db, session.id, 'ai:say', 'outbound', { text: line });
          recordTranscript(db, {
            campaignId: session.campaign_id,
            leadId: session.lead_id,
            callRef: sid,
            role: 'ai',
            text: line,
            intent: '',
          });
        }
        db.prepare(
          "UPDATE voice_sessions SET status = 'in_progress', phase = ?, disclosure_played = 1, updated_at = datetime('now') WHERE id = ?"
        ).run(greeting.state.phase, session.id);
      });
      run();
    }
    return { type: 'applied', sessionId: session.id, callId: session.call_id, status };
  }

  finalizeSession(db, session, {
    outcome: status === 'failed' ? 'failed' : '',
    reason: status === 'failed' ? 'provider_failed' : 'provider_ended',
    username: 'provider',
    cfg,
  });
  return { type: 'applied', sessionId: session.id, callId: session.call_id, status: status === 'failed' ? 'failed' : 'ended' };
}

// End every live voice session immediately (emergency stop). Each affected sheet
// is finalized as `unanswered`/`emergency_stop` so it does not masquerade as a
// connected call.
export function endActiveVoiceSessions(db, username = 'system', cfg = config) {
  const rows = db.prepare(`SELECT * FROM voice_sessions WHERE status IN ${ACTIVE_STATUSES}`).all();
  let ended = 0;
  for (const row of rows) {
    try {
      const provider = createVoiceProvider(cfg.voice);
      if (row.provider_call_sid) provider.endCall(row.provider_call_sid, 'emergency_stop');
    } catch {
      // Provider teardown is best-effort; the DB state is what matters here.
    }
    finalizeSession(db, row, { outcome: 'unanswered', reason: 'emergency_stop', username, cfg });
    ended += 1;
  }
  return { ended };
}

export function endVoiceSession(db, sessionId, input, username = 'system', cfg = config) {
  const parsed = endVoiceSessionSchema.parse(input ?? {});
  const row = db.prepare('SELECT * FROM voice_sessions WHERE id = ?').get(sessionId);
  if (!row) throw new HttpError(404, 'voice_session_not_found');
  if (VOICE_TERMINAL_STATUSES.has(row.status)) throw new HttpError(409, 'voice_session_ended', { status: row.status });
  try {
    const provider = createVoiceProvider(cfg.voice);
    if (row.provider_call_sid) provider.endCall(row.provider_call_sid, parsed.reason);
  } catch {
    // best-effort provider teardown
  }
  return finalizeSession(db, row, { outcome: 'unanswered', reason: parsed.reason, username, cfg });
}

export { VOICE_PHASES };
