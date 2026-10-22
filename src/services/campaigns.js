import { config } from '../config.js';
import { HttpError } from '../lib/errors.js';
import { audit } from './auth.js';
import { getLead, isSuppressed } from './leads.js';
import { isOptedOut, addOptOut } from './optouts.js';
import { evaluateLead } from './compliance.js';
import { evaluateDialerEligibility } from './dialerEligibility.js';
import { resolveIvrInput, recordIvrResponse, ivrAttemptCount } from './ivr.js';
import { runSimulatedTurn } from './ai.js';
import {
  createCampaignSchema,
  updateCampaignSchema,
  queueLeadsSchema,
  outcomeSchema,
  ivrSchema,
  aiTurnSchema,
  CAMPAIGN_LEAD_STATUSES,
} from '../validate/campaign.js';

const ACTIVE_LEAD_STATUSES = ['queued', 'callback', 'dialing'];

function toCampaign(row) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    createdBy: row.created_by,
    callWindowStart: row.call_window_start,
    callWindowEnd: row.call_window_end,
    defaultTimezone: row.default_timezone,
    maxAttempts: row.max_attempts,
    retryDelayMinutes: row.retry_delay_minutes,
    concurrencyLimit: row.concurrency_limit,
    pacingPerMinute: row.pacing_per_minute,
    ivrEnabled: row.ivr_enabled === 1,
    aiEnabled: row.ai_enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toCampaignLead(row) {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    leadId: row.lead_id,
    status: row.status,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    lastAttemptAt: row.last_attempt_at,
    lastOutcome: row.last_outcome,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function addEvent(db, campaignId, leadId, type, data = {}) {
  db.prepare(
    'INSERT INTO campaign_events (campaign_id, lead_id, event_type, event_data) VALUES (?, ?, ?, ?)'
  ).run(campaignId, leadId, type, JSON.stringify(data));
}

export function campaignStats(db, campaignId) {
  const rows = db
    .prepare('SELECT status, COUNT(*) AS n FROM campaign_leads WHERE campaign_id = ? GROUP BY status')
    .all(campaignId);
  const byStatus = Object.fromEntries(CAMPAIGN_LEAD_STATUSES.map((s) => [s, 0]));
  for (const r of rows) byStatus[r.status] = r.n;
  byStatus.total = rows.reduce((sum, r) => sum + r.n, 0);
  byStatus.remaining = byStatus.queued + byStatus.callback + byStatus.dialing;
  return byStatus;
}

function assertCampaignRow(db, id) {
  const row = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
  if (!row) throw new HttpError(404, 'campaign_not_found');
  return row;
}

export function getCampaign(db, id) {
  const row = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
  if (!row) return null;
  const campaign = toCampaign(row);
  campaign.stats = campaignStats(db, id);
  campaign.leads = db
    .prepare('SELECT * FROM campaign_leads WHERE campaign_id = ? ORDER BY id')
    .all(id)
    .map(toCampaignLead);
  return campaign;
}

export function listCampaigns(db) {
  return db
    .prepare('SELECT * FROM campaigns ORDER BY id DESC')
    .all()
    .map((row) => ({ ...toCampaign(row), stats: campaignStats(db, row.id) }));
}

export function createCampaign(db, user, input, cfg = config) {
  const parsed = createCampaignSchema.parse(input);
  const defaults = cfg.campaigns;
  const info = db
    .prepare(
      `INSERT INTO campaigns
         (name, created_by, call_window_start, call_window_end, default_timezone,
          max_attempts, retry_delay_minutes, concurrency_limit, pacing_per_minute,
          ivr_enabled, ai_enabled)
       VALUES (@name, @created_by, @ws, @we, @tz, @max, @retry, @conc, @pace, @ivr, @ai)`
    )
    .run({
      name: parsed.name,
      created_by: user?.id ?? null,
      ws: parsed.callWindowStart ?? cfg.compliance.callWindowStart,
      we: parsed.callWindowEnd ?? cfg.compliance.callWindowEnd,
      tz: parsed.defaultTimezone ?? '',
      max: parsed.maxAttempts ?? defaults.defaultMaxAttempts,
      retry: parsed.retryDelayMinutes ?? defaults.defaultRetryDelayMinutes,
      conc: Math.min(parsed.concurrencyLimit ?? defaults.defaultConcurrency, defaults.maxConcurrency),
      pace: parsed.pacingPerMinute ?? defaults.defaultPacingPerMinute,
      ivr: parsed.ivrEnabled === false ? 0 : 1,
      ai: parsed.aiEnabled === true ? 1 : 0,
    });
  const id = Number(info.lastInsertRowid);
  audit(db, user?.username ?? 'system', 'campaign_created', 'campaign', String(id), JSON.stringify({ name: parsed.name }));
  return getCampaign(db, id);
}

export function updateCampaign(db, id, input, username) {
  const row = assertCampaignRow(db, id);
  if (row.status === 'running') throw new HttpError(409, 'campaign_running');
  const parsed = updateCampaignSchema.parse(input);
  const map = {
    name: 'name',
    callWindowStart: 'call_window_start',
    callWindowEnd: 'call_window_end',
    defaultTimezone: 'default_timezone',
    maxAttempts: 'max_attempts',
    retryDelayMinutes: 'retry_delay_minutes',
    concurrencyLimit: 'concurrency_limit',
    pacingPerMinute: 'pacing_per_minute',
  };
  const sets = [];
  const params = { id };
  for (const [key, col] of Object.entries(map)) {
    if (parsed[key] !== undefined) {
      sets.push(`${col} = @${col}`);
      params[col] = parsed[key];
    }
  }
  if (parsed.ivrEnabled !== undefined) {
    sets.push('ivr_enabled = @ivr');
    params.ivr = parsed.ivrEnabled ? 1 : 0;
  }
  if (parsed.aiEnabled !== undefined) {
    sets.push('ai_enabled = @ai');
    params.ai = parsed.aiEnabled ? 1 : 0;
  }
  if (sets.length) {
    db.prepare(`UPDATE campaigns SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = @id`).run(params);
  }
  audit(db, username ?? 'system', 'campaign_updated', 'campaign', String(id));
  return getCampaign(db, id);
}

function setStatus(db, id, next, username, opts = {}) {
  const row = assertCampaignRow(db, id);
  const allowedFrom = opts.from;
  if (row.status === 'completed' && next !== 'stopped') {
    throw new HttpError(409, 'invalid_transition', { status: row.status });
  }
  if (allowedFrom && !allowedFrom.includes(row.status)) {
    throw new HttpError(409, 'invalid_transition', { status: row.status });
  }
  if (row.status === next) return getCampaign(db, id);
  db.prepare("UPDATE campaigns SET status = ?, updated_at = datetime('now') WHERE id = ?").run(next, id);
  addEvent(db, id, null, `campaign_${next}`, {});
  audit(db, username ?? 'system', `campaign_${next}`, 'campaign', String(id));
  return getCampaign(db, id);
}

export function startCampaign(db, id, username) {
  return setStatus(db, id, 'running', username, { from: ['draft', 'paused', 'stopped'] });
}
export function pauseCampaign(db, id, username) {
  return setStatus(db, id, 'paused', username, { from: ['running'] });
}
export function resumeCampaign(db, id, username) {
  return setStatus(db, id, 'running', username, { from: ['paused'] });
}
export function stopCampaign(db, id, username) {
  return setStatus(db, id, 'stopped', username);
}

export function emergencyStopAll(db, username) {
  const info = db
    .prepare("UPDATE campaigns SET status = 'stopped', updated_at = datetime('now') WHERE status IN ('running','paused')")
    .run();
  audit(db, username ?? 'system', 'campaign_emergency_stop', 'campaign', '', JSON.stringify({ stopped: info.changes }));
  return { stopped: info.changes };
}

export function queueLeads(db, id, input, username) {
  assertCampaignRow(db, id);
  const parsed = queueLeadsSchema.parse(input);
  const onlyEligible = parsed.onlyEligible !== false;

  const leads = parsed.leadIds?.length
    ? parsed.leadIds.map((leadId) => getLead(db, leadId)).filter(Boolean)
    : db
        .prepare('SELECT * FROM leads ORDER BY id')
        .all()
        .map((r) => getLead(db, r.id));

  const insert = db.prepare(
    "INSERT OR IGNORE INTO campaign_leads (campaign_id, lead_id, status) VALUES (?, ?, 'queued')"
  );
  let queued = 0;
  let skipped = 0;
  const run = db.transaction(() => {
    for (const lead of leads) {
      if (!lead) {
        skipped += 1;
        continue;
      }
      if (onlyEligible && (lead.status !== 'pending' || isSuppressed(db, lead.phone) || isOptedOut(db, lead.phone))) {
        skipped += 1;
        continue;
      }
      const info = insert.run(id, lead.id);
      if (info.changes > 0) queued += 1;
      else skipped += 1;
    }
    audit(db, username ?? 'system', 'campaign_leads_queued', 'campaign', String(id), JSON.stringify({ queued, skipped }));
  });
  run();
  return { queued, skipped, total: leads.length };
}

function countDialing(db, campaignId) {
  return db
    .prepare("SELECT COUNT(*) AS c FROM campaign_leads WHERE campaign_id = ? AND status = 'dialing'")
    .get(campaignId).c;
}

function pacingOk(db, campaign) {
  const recent = db
    .prepare(
      "SELECT COUNT(*) AS c FROM campaign_events WHERE campaign_id = ? AND event_type = 'dialing' AND created_at >= datetime('now','-1 minute')"
    )
    .get(campaign.id).c;
  return recent < campaign.pacing_per_minute;
}

function setLeadStatus(db, campaignLeadId, status, outcome) {
  db.prepare(
    "UPDATE campaign_leads SET status = ?, last_outcome = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(status, outcome, campaignLeadId);
}

// Terminalize a campaign lead that can never be dialed (suppression / consent).
function terminalizeBlocked(db, campaign, cl, decision) {
  const codes = new Set(decision.reasons.map((r) => r.code));
  let status = null;
  if (codes.has('opted_out')) status = 'opted_out';
  else if (codes.has('internal_dnc') || codes.has('suppression_flagged') || codes.has('lead_status_dnc')) status = 'dnc';
  else if (codes.has('lead_status_completed') || codes.has('consent_revoked') || codes.has('lead_status_blocked')) status = 'failed';
  if (!status) return false;
  setLeadStatus(db, cl.id, status, decision.decision);
  addEvent(db, campaign.id, cl.lead_id, 'blocked', { decision: decision.decision, reasons: [...codes] });
  return true;
}

// Claim one eligible lead for a dial attempt. Honors concurrency, pacing,
// calling hours/timezone, consent/suppression/opt-out, max attempts, the
// "never call an unknown-status lead" rule, and — when
// `compliance.requireComplianceProfile` is on — the full fail-closed
// dialer-eligibility gate (campaign compliance profile + scoped consent ledger).
export function claimNext(db, campaignId, { username = 'system', now, cfg = config } = {}) {
  const campaign = assertCampaignRow(db, campaignId);
  if (campaign.status !== 'running') throw new HttpError(409, 'campaign_not_running', { status: campaign.status });
  if (countDialing(db, campaignId) >= campaign.concurrency_limit) {
    return { claimed: null, reason: 'concurrency_limit' };
  }
  if (!pacingOk(db, campaign)) {
    return { claimed: null, reason: 'pacing_limit' };
  }

  const candidates = db
    .prepare(
      `SELECT * FROM campaign_leads
        WHERE campaign_id = ? AND status IN ('queued','callback')
          AND (next_attempt_at IS NULL OR next_attempt_at <= datetime('now'))
        ORDER BY COALESCE(next_attempt_at, created_at), id`
    )
    .all(campaignId);

  const claim = db.transaction((cl) => {
    db.prepare(
      "UPDATE campaign_leads SET status = 'dialing', attempt_count = attempt_count + 1, last_attempt_at = datetime('now'), last_outcome = 'dialing', updated_at = datetime('now') WHERE id = ?"
    ).run(cl.id);
    addEvent(db, campaignId, cl.lead_id, 'dialing', { attempt: cl.attempt_count + 1 });
    audit(db, username, 'campaign_dial', 'campaign', String(campaignId), JSON.stringify({ leadId: cl.lead_id }));
  });

  let blockedByCompliance = false;
  for (const cl of candidates) {
    if (cl.attempt_count >= campaign.max_attempts) {
      setLeadStatus(db, cl.id, 'failed', 'max_attempts');
      addEvent(db, campaignId, cl.lead_id, 'exhausted', { attempts: cl.attempt_count });
      continue;
    }
    const concurrent = db
      .prepare("SELECT 1 FROM campaign_leads WHERE lead_id = ? AND status = 'dialing'")
      .get(cl.lead_id);
    if (concurrent) continue;

    const lead = getLead(db, cl.lead_id);
    if (!lead) continue;

    const effectiveTimezone = lead.timezone || campaign.default_timezone;
    const effectiveLead = effectiveTimezone === lead.timezone ? lead : { ...lead, timezone: effectiveTimezone };
    // The real dialer path uses the full compliance gate (profile + consent
    // ledger); the offline simulation path uses the established lead evaluator.
    const decision = cfg.compliance.requireComplianceProfile
      ? evaluateDialerEligibility(db, { campaign, lead: effectiveLead, now, cfg })
      : evaluateLead(db, effectiveLead, {
          now,
          window: { start: campaign.call_window_start, end: campaign.call_window_end },
        });

    if (decision.decision !== 'allowed') {
      // Terminal suppressions (opt-out/DNC/completed) are finalized; a missing
      // compliance profile or consent is a campaign-configuration gap, so the
      // lead stays queued and is simply never dialed (no side effect, no retry
      // attempt) until an operator fixes the profile.
      const terminal = terminalizeBlocked(db, campaign, cl, decision);
      if (!terminal) {
        blockedByCompliance = true;
        addEvent(db, campaignId, cl.lead_id, 'compliance_blocked', {
          decision: decision.decision,
          reasons: decision.reasons.map((r) => r.code),
        });
      }
      continue;
    }

    claim(cl);
    return {
      claimed: { ...toCampaignLead({ ...cl, attempt_count: cl.attempt_count + 1, status: 'dialing' }), lead, compliance: decision },
      reason: null,
    };
  }
  return { claimed: null, reason: blockedByCompliance ? 'not_eligible' : 'no_eligible_leads' };
}

function maybeCompleteCampaign(db, campaignId) {
  const active = db
    .prepare(
      "SELECT COUNT(*) AS c FROM campaign_leads WHERE campaign_id = ? AND status IN ('queued','callback','dialing')"
    )
    .get(campaignId).c;
  const total = db.prepare('SELECT COUNT(*) AS c FROM campaign_leads WHERE campaign_id = ?').get(campaignId).c;
  if (total > 0 && active === 0) {
    db.prepare("UPDATE campaigns SET status = 'completed', updated_at = datetime('now') WHERE id = ? AND status IN ('running','paused')").run(
      campaignId
    );
    addEvent(db, campaignId, null, 'campaign_completed', {});
  }
}

function applyOutcome(db, campaign, cl, outcome, { notes = '', username = 'system', cfg = config } = {}) {
  const lead = getLead(db, cl.lead_id);
  const retryable = ['failed', 'busy', 'unanswered', 'callback'].includes(outcome);
  const attemptsLeft = cl.attempt_count < campaign.max_attempts;

  const run = db.transaction(() => {
    if (outcome === 'opted_out') {
      if (lead) addOptOut(db, lead.phone, { source: 'campaign', reason: notes, username });
      setLeadStatus(db, cl.id, 'opted_out', outcome);
    } else if (outcome === 'dnc') {
      if (lead) {
        db.prepare(
          "INSERT OR IGNORE INTO dnc_entries (phone, source, list_name, active) VALUES (?, 'campaign', 'Campaign disposition', 1)"
        ).run(lead.phone);
        db.prepare(
          "UPDATE leads SET status = 'dnc', suppression_blocked = 1, updated_at = datetime('now') WHERE id = ?"
        ).run(lead.id);
      }
      setLeadStatus(db, cl.id, 'dnc', outcome);
    } else if (outcome === 'completed') {
      setLeadStatus(db, cl.id, 'completed', outcome);
      if (lead) {
        db.prepare("UPDATE leads SET status = 'completed', updated_at = datetime('now') WHERE id = ?").run(lead.id);
      }
    } else if (outcome === 'connected') {
      setLeadStatus(db, cl.id, 'connected', outcome);
    } else if (retryable && attemptsLeft) {
      const nextStatus = outcome === 'callback' ? 'callback' : 'queued';
      db.prepare(
        `UPDATE campaign_leads
            SET status = ?, last_outcome = ?, updated_at = datetime('now'),
                next_attempt_at = datetime('now', '+' || ? || ' minutes')
          WHERE id = ?`
      ).run(nextStatus, outcome, campaign.retry_delay_minutes, cl.id);
    } else {
      setLeadStatus(db, cl.id, 'failed', outcome);
    }
    addEvent(db, campaign.id, cl.lead_id, 'outcome', { outcome, attempt: cl.attempt_count, notes });
    audit(
      db,
      username,
      'campaign_outcome',
      'campaign',
      String(campaign.id),
      JSON.stringify({ leadId: cl.lead_id, outcome, attempt: cl.attempt_count })
    );
  });
  run();
  maybeCompleteCampaign(db, campaign.id);
  return getCampaignLead(db, campaign.id, cl.lead_id);
}

function getCampaignLead(db, campaignId, leadId) {
  const row = db
    .prepare('SELECT * FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?')
    .get(campaignId, leadId);
  return row ? toCampaignLead(row) : null;
}

function requireDialingFlag(db, campaign, leadId) {
  const cl = getCampaignLeadRaw(db, campaign.id, leadId);
  if (!cl) throw new HttpError(404, 'campaign_lead_not_found');
  if (cl.status !== 'dialing') throw new HttpError(409, 'invalid_transition', { status: cl.status });
  return cl;
}

function getCampaignLeadRaw(db, campaignId, leadId) {
  return db.prepare('SELECT * FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').get(campaignId, leadId);
}

export function recordOutcome(db, campaignId, input, username, cfg = config) {
  const parsed = outcomeSchema.parse(input);
  const campaign = assertCampaignRow(db, campaignId);
  const cl = requireDialingFlag(db, campaign, parsed.leadId);
  applyOutcome(db, campaign, cl, parsed.outcome, { notes: parsed.notes, username, cfg });
  return getCampaign(db, campaignId);
}

export function handleIvr(db, campaignId, input, username, cfg = config) {
  const parsed = ivrSchema.parse(input);
  const campaign = assertCampaignRow(db, campaignId);
  const cl = requireDialingFlag(db, campaign, parsed.leadId);
  const attempt = ivrAttemptCount(db, { campaignId, leadId: parsed.leadId, callRef: '' });
  const resolved = resolveIvrInput({ digit: parsed.digit, timedOut: parsed.timedOut, attempt });

  const run = db.transaction(() => {
    recordIvrResponse(db, {
      campaignId,
      leadId: parsed.leadId,
      digit: parsed.digit ?? '',
      resolveResult: resolved,
    });
    addEvent(db, campaignId, parsed.leadId, 'ivr', { route: resolved.route, digit: parsed.digit ?? '' });
  });
  run();

  if (resolved.outcome) {
    applyOutcome(db, campaign, cl, resolved.outcome, { username, cfg });
  }
  return { ivr: { route: resolved.route, valid: resolved.valid, timedOut: resolved.timedOut }, campaign: getCampaign(db, campaignId) };
}

export function handleAiTurn(db, campaignId, input, username, cfg = config) {
  const parsed = aiTurnSchema.parse(input);
  const campaign = assertCampaignRow(db, campaignId);
  const cl = requireDialingFlag(db, campaign, parsed.leadId);
  const turn = runSimulatedTurn(db, { campaignId, leadId: parsed.leadId, text: parsed.text });
  addEvent(db, campaignId, parsed.leadId, 'ai_turn', { intent: turn.intent, route: turn.route });
  if (turn.outcome) {
    applyOutcome(db, campaign, cl, turn.outcome, { username, cfg });
  }
  return { ai: turn, campaign: getCampaign(db, campaignId) };
}

export function getCampaignLeadForApi(db, campaignId, leadId) {
  return getCampaignLead(db, campaignId, leadId);
}

// Apply a disposition to a campaign lead from a subsystem that owns its own
// lifecycle (e.g. the voice dialer). Unlike recordOutcome/handleIvr this does not
// require the lead to currently be flagged `dialing` — the caller has already
// validated the transition — but it enforces the same outcome vocabulary and
// side effects (opt-out, DNC, retry/backoff, completion, audit).
export function applyCampaignOutcome(db, campaignId, leadId, outcome, { notes = '', username = 'system', cfg = config } = {}) {
  const campaign = assertCampaignRow(db, campaignId);
  const cl = getCampaignLeadRaw(db, campaignId, leadId);
  if (!cl) throw new HttpError(404, 'campaign_lead_not_found');
  applyOutcome(db, campaign, cl, outcome, { notes, username, cfg });
  return getCampaign(db, campaignId);
}

export { ACTIVE_LEAD_STATUSES };
