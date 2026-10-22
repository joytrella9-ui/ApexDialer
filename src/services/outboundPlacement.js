import { HttpError } from '../lib/errors.js';
import { audit } from './auth.js';
import { applyCampaignOutcome } from './campaigns.js';
import { getVoiceSession } from './voiceSessions.js';
import { assessOutboundCall } from './dialerEligibility.js';
import { assertPublicHttpsUrl } from '../providers/twilioRest.js';

// =============================================================================
// OUTBOUND CALL PLACEMENT (two-phase, claim-first, never auto-retried)
// =============================================================================
// Phase 1 (synchronous, DB only): a voice session exists in status `starting` with
// no provider SID. Phase 2 (async, network): this module CLAIMS the session in one
// atomic UPDATE, then awaits exactly one provider create call, then records the SID.
//
// Guarantees:
//   - One claim per session. A second placement for the same session is refused
//     (409 attempt_already_claimed) and never reaches the provider.
//     The claim writes a sentinel `PENDING:<id>` into provider_call_sid, which the
//     existing partial unique index also protects.
//   - The provider receives the call creation exactly once. No automatic retry.
//   - A DEFINITIVE rejection (no call was created) fails the session and lets the
//     campaign's normal retry policy apply.
//   - An AMBIGUOUS outcome (timeout, connection loss, 5xx, bad response) leaves the
//     sentinel in place, marks the session failed with reason `ambiguous_create`,
//     records the campaign lead as `failed` with outcome `ambiguous` (NOT requeued),
//     and returns 502 with `reconcile: true`. An operator must reconcile with the
//     provider console before any further action.
//   - The Twilio route only serves TwiML for a session whose recorded SID equals the
//     posted CallSid, so a sentinel never matches.
//
// Known race (documented, fail-closed): a provider status callback that arrives
// before the SID is recorded finds no matching session and is ignored. It is not
// replayed. Reconciliation would require a provider lookup, which is not implemented.
export const SENTINEL_PREFIX = 'PENDING:';

export function sentinelFor(sessionId) {
  return `${SENTINEL_PREFIX}${Number(sessionId)}`;
}

// Build a Twilio-backed provider from the REST transport. The public origin must be
// https and is never taken from a request header. Returns an async adapter.
export function createTwilioCallProvider({ transport, publicBaseUrl, maxCallSeconds = 600 } = {}) {
  if (!transport || typeof transport.createCall !== 'function') throw new Error('transport required');
  const origin = (() => {
    const u = new URL(assertPublicHttpsUrl(publicBaseUrl, 'publicBaseUrl'));
    return `${u.protocol}//${u.host}`;
  })();
  return {
    name: 'twilio',
    async startOutboundCall({ to, from, sessionId }) {
      const id = Number(sessionId);
      if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'invalid_id');
      return transport.createCall({
        to,
        from,
        twimlUrl: `${origin}/api/voice/webhooks/twiml/${id}`,
        statusCallbackUrl: `${origin}/api/voice/webhooks/twilio/status`,
        timeLimitSeconds: maxCallSeconds,
      });
    },
    async endCall(sid) {
      return transport.endCall(sid);
    },
  };
}

// Phase 2. Resolves to the updated session. Throws HttpError on refusal or failure.
export async function placeOutboundCall(db, { sessionId, provider, username = 'system', cfg } = {}) {
  const id = Number(sessionId);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'invalid_id');
  if (!provider || typeof provider.startOutboundCall !== 'function') throw new HttpError(503, 'provider_not_configured');

  const row = db.prepare('SELECT * FROM voice_sessions WHERE id = ?').get(id);
  if (!row) throw new HttpError(404, 'voice_session_not_found');
  if (row.status !== 'starting') throw new HttpError(409, 'invalid_transition', { status: row.status });

  // Revalidate eligibility immediately before the claim. Consent, suppression, hours,
  // and the profile can change after the session was created. A failure here fails the
  // session without touching the provider.
  const decision = assessOutboundCall(db, { campaignId: row.campaign_id, leadId: row.lead_id, cfg });
  if (!decision.allowed) {
    db.prepare("UPDATE voice_sessions SET status = 'failed', outcome = 'failed', disconnect_reason = 'not_eligible_at_placement', ended_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status = 'starting'").run(id);
    if (row.call_id) db.prepare("UPDATE calls SET status = 'aborted', ended_at = datetime('now') WHERE id = ?").run(row.call_id);
    audit(db, username, 'outbound_call_refused', 'voice_session', String(id), JSON.stringify({ reason: 'not_eligible_at_placement' }));
    applyCampaignOutcome(db, row.campaign_id, row.lead_id, 'failed', { username, cfg });
    throw new HttpError(409, 'not_eligible', { decision: decision.decision, reasons: decision.reasons.map((r) => r.code) });
  }

  // Atomic claim: exactly one caller can move the SID from empty to the sentinel.
  const claim = db
    .prepare(
      `UPDATE voice_sessions SET provider_call_sid = ?, updated_at = datetime('now')
        WHERE id = ? AND status = 'starting' AND (provider_call_sid IS NULL OR provider_call_sid = '')`
    )
    .run(sentinelFor(id), id);
  if (claim.changes !== 1) throw new HttpError(409, 'attempt_already_claimed');

  const lead = db.prepare('SELECT phone FROM leads WHERE id = ?').get(row.lead_id);
  let created;
  try {
    created = await provider.startOutboundCall({
      to: lead?.phone ?? '',
      from: cfg?.voice?.fromNumber ?? '',
      sessionId: id,
    });
  } catch (err) {
    if (err?.details?.ambiguous === true) {
      markAmbiguous(db, id, row, { username, cfg });
      throw new HttpError(502, 'provider_create_ambiguous', { reconcile: true });
    }
    // Definitive: no call was created. Release the claim and fail the session.
    markDefinitiveFailure(db, id, row, { username, cfg });
    throw new HttpError(502, 'provider_start_failed');
  }

  const sid = String(created?.sid ?? '');
  if (!/^CA[0-9a-fA-F]{32}$/.test(sid) && !/^FV[0-9a-fA-F]+$/.test(sid)) {
    markAmbiguous(db, id, row, { username, cfg });
    throw new HttpError(502, 'provider_create_ambiguous', { reconcile: true });
  }

  const record = db.transaction(() => {
    const info = db
      .prepare(
        `UPDATE voice_sessions SET provider_call_sid = ?, status = 'ringing', updated_at = datetime('now')
          WHERE id = ? AND provider_call_sid = ?`
      )
      .run(sid, id, sentinelFor(id));
    if (info.changes !== 1) throw new Error('claim lost before the SID was recorded');
    db.prepare("UPDATE calls SET status = 'in_progress', provider_call_sid = ? WHERE id = ?").run(sid, row.call_id);
    db.prepare('INSERT INTO call_events (call_id, event_type, event_data) VALUES (?, ?, ?)').run(
      row.call_id,
      'provider_call_created',
      JSON.stringify({ provider: provider.name ?? 'unknown' })
    );
    audit(db, username, 'outbound_call_placed', 'voice_session', String(id), JSON.stringify({ provider: provider.name ?? 'unknown' }));
  });
  record();
  return getVoiceSession(db, id);
}

function markAmbiguous(db, id, row, { username, cfg }) {
  db.transaction(() => {
    db.prepare(
      `UPDATE voice_sessions SET status = 'failed', outcome = 'failed', disconnect_reason = 'ambiguous_create',
              ended_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
    ).run(id);
    if (row.call_id) {
      db.prepare("UPDATE calls SET status = 'aborted', ended_at = datetime('now') WHERE id = ?").run(row.call_id);
      db.prepare('INSERT INTO call_events (call_id, event_type, event_data) VALUES (?, ?, ?)').run(
        row.call_id,
        'provider_create_ambiguous',
        JSON.stringify({ reconcile: true })
      );
    }
    audit(db, username, 'outbound_call_ambiguous', 'voice_session', String(id), JSON.stringify({ reconcile: true }));
  })();
  if (row.campaign_id && row.lead_id) {
    // 'ambiguous' is not a retryable outcome, so the lead is NOT requeued.
    applyCampaignOutcome(db, row.campaign_id, row.lead_id, 'ambiguous', { username, cfg });
  }
}

function markDefinitiveFailure(db, id, row, { username, cfg }) {
  db.transaction(() => {
    db.prepare(
      `UPDATE voice_sessions SET provider_call_sid = '', status = 'failed', outcome = 'failed',
              disconnect_reason = 'provider_start_failed', ended_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ?`
    ).run(id);
    if (row.call_id) {
      db.prepare("UPDATE calls SET status = 'aborted', ended_at = datetime('now') WHERE id = ?").run(row.call_id);
    }
    audit(db, username, 'outbound_call_rejected', 'voice_session', String(id), JSON.stringify({ reason: 'provider_start_failed' }));
  })();
  if (row.campaign_id && row.lead_id) {
    applyCampaignOutcome(db, row.campaign_id, row.lead_id, 'failed', { username, cfg });
  }
}
