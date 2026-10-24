import { HttpError } from '../lib/errors.js';
import { audit } from './auth.js';
import { evaluateLead } from './compliance.js';
import { getLead, listLeads } from './leads.js';
import { INTERNAL_TERMINAL_STATUSES } from '../providers/twilio.js';
import {
  ACTIVE_STATUSES,
  attemptSchema,
  endAttemptSchema,
  abortSchema,
  skipSchema,
} from '../validate/call.js';
import { hangupProviderCall, placeClickToCall } from './clickToCall.js';

function toCall(row) {
  return {
    id: row.id,
    leadId: row.lead_id,
    userId: row.user_id,
    direction: row.direction,
    status: row.status,
    callType: row.call_type,
    disposition: row.disposition,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationSeconds: row.duration_seconds,
    notes: row.notes,
    providerCallSid: row.provider_call_sid || '',
    createdAt: row.created_at,
  };
}

function addEvent(db, callId, type, data = {}) {
  db.prepare('INSERT INTO call_events (call_id, event_type, event_data) VALUES (?, ?, ?)').run(
    callId,
    type,
    JSON.stringify(data)
  );
}

function toEvent(row) {
  let data = {};
  try {
    data = row.event_data ? JSON.parse(row.event_data) : {};
  } catch {
    data = { raw: row.event_data };
  }
  return { id: row.id, type: row.event_type, data, createdAt: row.created_at };
}

export function getCall(db, id) {
  const row = db.prepare('SELECT * FROM calls WHERE id = ?').get(id);
  if (!row) return null;
  const call = toCall(row);
  call.events = db
    .prepare('SELECT * FROM call_events WHERE call_id = ? ORDER BY id')
    .all(id)
    .map(toEvent);
  return call;
}

function isStale(row, maxMinutes) {
  if (!row.started_at) return false;
  const started = Date.parse(`${String(row.started_at).replace(' ', 'T')}Z`);
  if (Number.isNaN(started)) return false;
  return Date.now() - started > maxMinutes * 60 * 1000;
}

function abandonStale(db, row) {
  db.prepare(
    "UPDATE calls SET status = 'aborted', ended_at = datetime('now') WHERE id = ? AND status IN ('in_progress','paused')"
  ).run(row.id);
  addEvent(db, row.id, 'attempt_aborted', { reason: 'stale' });
  audit(db, 'system', 'call_aborted', 'call', String(row.id), JSON.stringify({ reason: 'stale' }));
}

export function getActiveCall(db, userId, opts = {}) {
  const row = db
    .prepare(
      "SELECT * FROM calls WHERE user_id = ? AND status IN ('in_progress','paused') ORDER BY id DESC LIMIT 1"
    )
    .get(userId);
  if (!row) return null;
  if (opts.maxAttemptMinutes && isStale(row, opts.maxAttemptMinutes)) {
    abandonStale(db, row);
    return null;
  }
  return toCall(row);
}

export function getActiveContext(db, userId, opts = {}) {
  const active = getActiveCall(db, userId, opts);
  if (!active) return null;
  const lead = active.leadId != null ? getLead(db, active.leadId) : null;
  const compliance = lead ? evaluateLead(db, lead, { now: opts.now, window: opts.window }) : null;
  return { call: getCall(db, active.id), lead, compliance };
}

export function listCalls(db, userId, { limit = 50, allUsers = false } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 500);
  if (allUsers) {
    return db.prepare('SELECT * FROM calls ORDER BY id DESC LIMIT ?').all(lim).map(toCall);
  }
  return db
    .prepare('SELECT * FROM calls WHERE user_id = ? ORDER BY id DESC LIMIT ?')
    .all(userId, lim)
    .map(toCall);
}

export function nextEligibleLead(db, { exclude = [], window, now } = {}) {
  const excludeSet = new Set(exclude.map(Number));
  const candidates = listLeads(db, { eligible: true })
    .slice()
    .reverse()
    .filter((lead) => !excludeSet.has(lead.id));
  for (const lead of candidates) {
    const compliance = evaluateLead(db, lead, { now, window });
    if (compliance.decision === 'allowed') return { lead, compliance };
  }
  return null;
}

// Manual (power-dialer) attempts have no campaign and therefore no campaign
// compliance profile, so the profile/consent gate cannot evaluate them. They are
// permitted ONLY as the offline simulation: demo mode, the in-process fake provider,
// and live calling off. Any other configuration is refused before a row is written.
// Fail closed: a missing dialing context is treated as live.
export function assertSimulatedManualDialing(dialing) {
  const simulated =
    dialing?.demoMode === true && dialing?.provider === 'fake' && dialing?.liveEnabled !== true;
  if (!simulated) {
    throw new HttpError(409, 'manual_dial_requires_campaign_gate', {
      reason: 'Manual dialing has no campaign compliance profile. Live dialing must run through a campaign.',
    });
  }
  return 'simulated';
}

function isLiveDialing(dialing) {
  return dialing?.liveEnabled === true && String(dialing?.provider ?? '') === 'twilio';
}

export async function startAttempt(db, userId, username, input, opts = {}) {
  const parsed = attemptSchema.parse(input);
  const live = isLiveDialing(opts.dialing);
  const dialingMode = live ? 'live' : assertSimulatedManualDialing(opts.dialing);

  const existing = getActiveCall(db, userId, opts);
  if (existing) {
    throw new HttpError(409, 'attempt_in_progress', {
      callId: existing.id,
      status: existing.status,
    });
  }

  const lead = getLead(db, parsed.leadId);
  if (!lead) throw new HttpError(404, 'lead_not_found');

  const compliance = evaluateLead(db, lead, { now: opts.now, window: opts.window });
  if (compliance.decision !== 'allowed') {
    throw new HttpError(409, 'not_eligible', {
      decision: compliance.decision,
      compliance,
      lead: { id: lead.id, name: lead.name, phone: lead.phone },
    });
  }

  const create = db.transaction(() => {
    let info;
    try {
      info = db
        .prepare(
          `INSERT INTO calls (lead_id, user_id, direction, status, call_type, disposition, started_at, notes)
           VALUES (?, ?, 'outbound', 'in_progress', ?, '', datetime('now'), '')`
        )
        .run(lead.id, userId, lead.callType);
    } catch (err) {
      if (/UNIQUE/i.test(String(err.message))) {
        throw new HttpError(409, 'attempt_in_progress', {});
      }
      throw err;
    }
    const callId = Number(info.lastInsertRowid);
    addEvent(db, callId, 'attempt_started', { leadId: lead.id, decision: compliance.decision });
    addEvent(db, callId, 'eligibility_allowed', { decision: compliance.decision });
    audit(
      db,
      username,
      'call_started',
      'call',
      String(callId),
      JSON.stringify({ leadId: lead.id, decision: compliance.decision })
    );
    return callId;
  });

  const id = create();
  if (live) {
    try {
      await placeClickToCall(db, {
        callId: id,
        leadPhone: lead.phone,
        cfg: opts.cfg,
        fetchImpl: opts.fetchImpl,
      });
      addEvent(db, id, 'provider_call_placed', { provider: 'twilio' });
    } catch (err) {
      db.prepare(
        `UPDATE calls SET status = 'aborted', ended_at = datetime('now') WHERE id = ?`
      ).run(id);
      addEvent(db, id, 'attempt_aborted', { reason: err.message || 'provider_start_failed' });
      throw err;
    }
  }
  return { call: getCall(db, id), lead: getLead(db, lead.id), compliance, dialingMode };
}

function applyLeadOutcome(db, leadId, { disposition, notes, addToDnc }) {
  if (addToDnc) {
    const lead = db.prepare('SELECT phone FROM leads WHERE id = ?').get(leadId);
    if (lead) {
      db.prepare(
        "INSERT OR IGNORE INTO dnc_entries (phone, source, list_name, active) VALUES (?, 'dialer', 'Dialer disposition', 1)"
      ).run(lead.phone);
    }
    db.prepare(
      `UPDATE leads SET status = 'dnc', disposition = ?, notes = ?, suppression_blocked = 1,
         updated_at = datetime('now') WHERE id = ?`
    ).run(disposition, notes, leadId);
  } else {
    db.prepare(
      `UPDATE leads SET status = 'completed', disposition = ?, notes = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(disposition, notes, leadId);
  }
}

export async function endAttempt(db, userId, username, callId, input, opts = {}) {
  const parsed = endAttemptSchema.parse(input);
  const row = db.prepare('SELECT * FROM calls WHERE id = ? AND user_id = ?').get(callId, userId);
  if (!row) throw new HttpError(404, 'call_not_found');
  if (!ACTIVE_STATUSES.includes(row.status)) {
    throw new HttpError(409, 'invalid_transition', { status: row.status });
  }
  const disposition = String(parsed.disposition ?? '').trim();
  if (!disposition) throw new HttpError(400, 'disposition_required');

  const addToDnc = parsed.addToDnc === true || disposition.toLowerCase() === 'add to dnc';
  const duration = Number.isInteger(parsed.durationSeconds) ? parsed.durationSeconds : null;

  const run = db.transaction(() => {
    db.prepare(
      `UPDATE calls
          SET status = 'completed',
              ended_at = datetime('now'),
              duration_seconds = COALESCE(?, CAST(strftime('%s','now') - strftime('%s', started_at) AS INTEGER)),
              disposition = ?,
              notes = ?
        WHERE id = ?`
    ).run(duration, disposition, parsed.notes ?? '', callId);
    addEvent(db, callId, 'disposition_recorded', { disposition });
    addEvent(db, callId, 'attempt_ended', { disposition, addToDnc });
    if (row.lead_id != null) {
      applyLeadOutcome(db, row.lead_id, { disposition, notes: parsed.notes ?? '', addToDnc });
    }
    audit(
      db,
      username,
      'call_ended',
      'call',
      String(callId),
      JSON.stringify({ disposition, addToDnc })
    );
  });
  await hangupProviderCall(opts.cfg, row.provider_call_sid, opts.fetchImpl);
  run();

  const lead = row.lead_id != null ? getLead(db, row.lead_id) : null;
  return { call: getCall(db, callId), lead };
}

function transition(db, userId, username, callId, from, to, eventType, action) {
  const row = db.prepare('SELECT * FROM calls WHERE id = ? AND user_id = ?').get(callId, userId);
  if (!row) throw new HttpError(404, 'call_not_found');
  if (row.status !== from) throw new HttpError(409, 'invalid_transition', { status: row.status });
  db.prepare('UPDATE calls SET status = ? WHERE id = ?').run(to, callId);
  addEvent(db, callId, eventType, {});
  audit(db, username, action, 'call', String(callId));
  return { call: getCall(db, callId) };
}

export function pauseAttempt(db, userId, username, callId) {
  return transition(db, userId, username, callId, 'in_progress', 'paused', 'attempt_paused', 'call_paused');
}

export function resumeAttempt(db, userId, username, callId) {
  return transition(db, userId, username, callId, 'paused', 'in_progress', 'attempt_resumed', 'call_resumed');
}

export async function abortAttempt(db, userId, username, callId, input = {}, opts = {}) {
  const parsed = abortSchema.parse(input);
  const row = db.prepare('SELECT * FROM calls WHERE id = ? AND user_id = ?').get(callId, userId);
  if (!row) throw new HttpError(404, 'call_not_found');
  if (!ACTIVE_STATUSES.includes(row.status)) {
    throw new HttpError(409, 'invalid_transition', { status: row.status });
  }
  await hangupProviderCall(opts.cfg, row.provider_call_sid, opts.fetchImpl);
  db.prepare(
    `UPDATE calls SET status = 'aborted', ended_at = datetime('now'),
       duration_seconds = CAST(strftime('%s','now') - strftime('%s', started_at) AS INTEGER)
     WHERE id = ?`
  ).run(callId);
  addEvent(db, callId, 'attempt_aborted', { reason: parsed.reason || '' });
  audit(
    db,
    username,
    'call_aborted',
    'call',
    String(callId),
    JSON.stringify({ reason: parsed.reason || '' })
  );
  return { call: getCall(db, callId) };
}

export function skipLead(db, userId, username, input, opts = {}) {
  const parsed = skipSchema.parse(input);
  audit(db, username, 'lead_skipped', 'lead', String(parsed.leadId));
  return nextEligibleLead(db, { exclude: [parsed.leadId], window: opts.window, now: opts.now });
}

// Records a verified provider status callback (telephony sandbox). The route
// layer authenticates the webhook; this service maps the state transition onto
// the call and appends a durable, deduplicated provider_events row so retries
// from the provider are harmless.
export function acceptProviderEvent(db, input) {
  const provider = String(input.provider ?? '');
  const sid = String(input.sid ?? '');
  if (!sid) return { type: 'ignored', reason: 'missing_sid' };

  const call = db.prepare('SELECT * FROM calls WHERE provider_call_sid = ?').get(sid);
  if (!call) return { type: 'ignored', reason: 'call_not_found' };

  const eventId = String(input.eventId ?? '');
  const duplicate = db.prepare('SELECT 1 FROM provider_events WHERE provider = ? AND event_id = ?').get(
    provider,
    eventId
  );
  if (duplicate) return { type: 'ignored', reason: 'duplicate', callId: call.id };

  const status = input.status ?? null;
  const rawStatus = String(input.rawStatus ?? status ?? '');

  const apply = db.transaction(() => {
    db.prepare(
      'INSERT INTO provider_events (provider, event_id, call_id, event_type, event_data) VALUES (?, ?, ?, ?, ?)'
    ).run(provider, eventId, call.id, rawStatus, JSON.stringify(input.details ?? {}));

    if (status === null) {
      return { type: 'recorded', reason: 'unknown_status', callId: call.id };
    }
    if (INTERNAL_TERMINAL_STATUSES.has(call.status) && status === 'in_progress') {
      return { type: 'ignored', reason: 'call_terminal', callId: call.id };
    }

    if (input.terminal) {
      db.prepare(
        `UPDATE calls
            SET status = ?,
                ended_at = COALESCE(ended_at, datetime('now')),
                duration_seconds = CASE WHEN duration_seconds > 0 THEN duration_seconds
                                        ELSE CAST(strftime('%s','now') - strftime('%s', COALESCE(started_at, 'now')) AS INTEGER) END
          WHERE id = ?`
      ).run(status, call.id);
    } else {
      db.prepare('UPDATE calls SET status = ? WHERE id = ?').run(status, call.id);
    }

    addEvent(db, call.id, 'provider_status', {
      provider,
      sid,
      eventId,
      status,
      rawStatus,
      ...(input.details ?? {}),
    });
    audit(
      db,
      'provider',
      'provider_status',
      'call',
      String(call.id),
      JSON.stringify({ provider, sid, eventId, status, rawStatus })
    );
    return { type: 'applied', callId: call.id, status };
  });

  return { ...apply(), call: getCall(db, call.id) };
}
