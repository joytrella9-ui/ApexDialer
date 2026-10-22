import { HttpError } from '../lib/errors.js';
import { audit } from './auth.js';

// =============================================================================
// TRANSCRIPT RETENTION
// =============================================================================
// Expires conversation text after the retention period declared by the owning
// campaign's compliance profile (`campaign_compliance.retention_days`).
//
// Scope: text-bearing rows only.
//   - ai_transcripts                       (all rows)
//   - voice_events of type lead:speech and ai:say (session transcript text)
// Leads, calls, consents, opt-outs, provider events, and the audit log are never
// touched by this service.
//
// Fail-closed rules: a row is expired only when its campaign has a valid profile,
// its timestamp parses, and it is at or before `now - retention_days`. Anything
// else (no profile, unlinked row, invalid retention, unparseable or future
// timestamp) is kept and reported.
//
// `plan` is read-only. `execute` requires an explicit confirmation token, may
// require the exact count the operator reviewed in a dry run, and deletes in one
// transaction so a failure leaves all rows in place.
export const RETENTION_CONFIRM = 'DELETE_EXPIRED_TRANSCRIPTS';
export const MAX_RETENTION_DAYS = 3650;
const DAY_MS = 24 * 60 * 60 * 1000;
const VOICE_TEXT_EVENTS = Object.freeze(['lead:speech', 'ai:say']);
const DELETE_CHUNK = 500;
const SQLITE_UTC = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

// Parse a SQLite `datetime('now')` value (UTC, no timezone marker).
export function parseSqliteUtc(value) {
  if (typeof value !== 'string' || !SQLITE_UTC.test(value)) return null;
  const ms = Date.parse(`${value.replace(' ', 'T')}Z`);
  return Number.isFinite(ms) ? ms : null;
}

export function toSqliteUtc(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

// Classify one row. Returns 'expired', 'kept', or an unresolved reason.
export function classifyRetention({ campaignId, createdAt }, retentionByCampaign, nowMs) {
  if (campaignId === null || campaignId === undefined) return 'no_profile';
  if (!retentionByCampaign.has(campaignId)) return 'no_profile';
  const days = retentionByCampaign.get(campaignId);
  if (!Number.isInteger(days) || days < 0 || days > MAX_RETENTION_DAYS) return 'invalid_retention';
  const createdMs = parseSqliteUtc(createdAt);
  if (createdMs === null) return 'invalid_date';
  if (createdMs > nowMs) return 'kept'; // future-dated (clock skew): never expire
  return createdMs <= nowMs - days * DAY_MS ? 'expired' : 'kept';
}

function emptySource() {
  return {
    scanned: 0,
    expired: 0,
    kept: 0,
    unresolved: { noProfile: 0, invalidRetention: 0, invalidDate: 0 },
  };
}

function tally(source, outcome) {
  source.scanned += 1;
  if (outcome === 'expired') source.expired += 1;
  else if (outcome === 'kept') source.kept += 1;
  else if (outcome === 'no_profile') {
    source.kept += 1;
    source.unresolved.noProfile += 1;
  } else if (outcome === 'invalid_retention') {
    source.kept += 1;
    source.unresolved.invalidRetention += 1;
  } else if (outcome === 'invalid_date') {
    source.kept += 1;
    source.unresolved.invalidDate += 1;
  }
}

// Read-only plan: what would expire at `now`. Throws if the database cannot be read.
export function planTranscriptRetention(db, { now = new Date() } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(nowMs)) throw new HttpError(400, 'invalid_now');

  const retentionByCampaign = new Map(
    db.prepare('SELECT campaign_id, retention_days FROM campaign_compliance').all().map((r) => [r.campaign_id, r.retention_days])
  );

  const transcriptRows = db.prepare('SELECT id, campaign_id, created_at FROM ai_transcripts ORDER BY id').all();
  const voiceRows = db
    .prepare(
      `SELECT e.id, vs.campaign_id AS campaign_id, e.created_at
         FROM voice_events e
         LEFT JOIN voice_sessions vs ON vs.id = e.session_id
        WHERE e.event_type IN (?, ?)
        ORDER BY e.id`
    )
    .all(...VOICE_TEXT_EVENTS);

  const sources = { aiTranscripts: emptySource(), voiceEvents: emptySource() };
  const ids = { aiTranscripts: [], voiceEvents: [] };
  const byCampaign = new Map();

  const scan = (name, rows) => {
    for (const row of rows) {
      const outcome = classifyRetention({ campaignId: row.campaign_id, createdAt: row.created_at }, retentionByCampaign, nowMs);
      tally(sources[name], outcome);
      if (outcome === 'expired') {
        ids[name].push(row.id);
        const key = row.campaign_id;
        byCampaign.set(key, (byCampaign.get(key) ?? 0) + 1);
      }
    }
  };
  scan('aiTranscripts', transcriptRows);
  scan('voiceEvents', voiceRows);

  const expiredTotal = sources.aiTranscripts.expired + sources.voiceEvents.expired;
  const report = {
    asOf: new Date(nowMs).toISOString(),
    dryRun: true,
    policy: 'per-campaign compliance profile retention_days; unresolved rows are kept',
    sources,
    totals: {
      scanned: sources.aiTranscripts.scanned + sources.voiceEvents.scanned,
      expired: expiredTotal,
      kept: sources.aiTranscripts.kept + sources.voiceEvents.kept,
    },
    byCampaign: [...byCampaign.entries()]
      .map(([campaignId, expired]) => ({
        campaignId,
        retentionDays: retentionByCampaign.get(campaignId) ?? null,
        expired,
      }))
      .sort((a, b) => (a.campaignId ?? 0) - (b.campaignId ?? 0)),
  };
  return { report, ids, expiredTotal, nowMs };
}

function deleteIds(db, table, ids) {
  let removed = 0;
  for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
    const chunk = ids.slice(i, i + DELETE_CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    // `table` is always one of two fixed internal names, never user input.
    removed += db.prepare(`DELETE FROM ${table} WHERE id IN (${placeholders})`).run(...chunk).changes;
  }
  return removed;
}

// Delete the expired rows. Requires the confirmation token. When `expectedTotal`
// is provided it must equal the count the operator reviewed, otherwise nothing is
// deleted (409). Deletion and the audit entry share one transaction.
export function executeTranscriptRetention(db, { now = new Date(), confirm, expectedTotal, username = 'system' } = {}) {
  if (confirm !== RETENTION_CONFIRM) throw new HttpError(400, 'retention_confirmation_required');
  const plan = planTranscriptRetention(db, { now });
  if (expectedTotal !== undefined && expectedTotal !== null && Number(expectedTotal) !== plan.expiredTotal) {
    throw new HttpError(409, 'retention_plan_changed', { expected: Number(expectedTotal), current: plan.expiredTotal });
  }

  const deleted = { aiTranscripts: 0, voiceEvents: 0 };
  const run = db.transaction(() => {
    deleted.aiTranscripts = deleteIds(db, 'ai_transcripts', plan.ids.aiTranscripts);
    deleted.voiceEvents = deleteIds(db, 'voice_events', plan.ids.voiceEvents);
    audit(
      db,
      username,
      'transcript_retention_executed',
      'system',
      '',
      JSON.stringify({ asOf: plan.report.asOf, deleted })
    );
  });
  try {
    run();
  } catch (err) {
    // Transaction rolled back: no rows were removed.
    console.error('[apexdialer] transcript retention failed; no rows removed:', err.message);
    throw new HttpError(500, 'retention_failed');
  }
  return { asOf: plan.report.asOf, deleted, totalDeleted: deleted.aiTranscripts + deleted.voiceEvents };
}
