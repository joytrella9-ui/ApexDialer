import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createDb } from '../src/db/db.js';
import { upsertComplianceProfile } from '../src/services/complianceProfile.js';
import {
  classifyRetention,
  parseSqliteUtc,
  planTranscriptRetention,
  executeTranscriptRetention,
  RETENTION_CONFIRM,
  MAX_RETENTION_DAYS,
} from '../src/services/transcriptRetention.js';
import { runRetentionCli } from '../scripts/retention.js';
import { withServer, api } from '../test-support/helpers.js';

// All retention tests use temporary or in-memory databases only.
const NOW = new Date('2026-06-15T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const nowMs = NOW.getTime();

const PROFILE = {
  businessName: 'Acme',
  legalIdentity: 'Acme LLC',
  consentPurpose: 'sales',
  consentBasis: 'express_written',
  aiDisclosure: 'This call is handled by an automated assistant.',
  allowedCountries: ['US'],
  retentionDays: 30,
};

function makeCampaign(db, name, retentionDays = 30) {
  db.prepare("INSERT INTO campaigns (name, status) VALUES (?, 'running')").run(name);
  const id = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  if (retentionDays !== null) upsertComplianceProfile(db, id, { ...PROFILE, retentionDays });
  return id;
}

function addTranscript(db, campaignId, createdAt, text = 'hello') {
  db.prepare(
    "INSERT INTO ai_transcripts (campaign_id, lead_id, call_ref, role, text, intent, created_at) VALUES (?, NULL, '', 'lead', ?, '', ?)"
  ).run(campaignId, text, createdAt);
}

let phoneSeq = 0;
function addVoiceSpeech(db, campaignId, createdAt, eventType = 'lead:speech') {
  phoneSeq += 1;
  db.prepare(
    "INSERT INTO leads (name, phone, timezone, status) VALUES ('L', ?, 'UTC', 'pending')"
  ).run(`+1555${String(phoneSeq).padStart(7, '0')}`);
  const leadId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  db.prepare("INSERT INTO calls (lead_id, direction, status, call_type) VALUES (?, 'outbound', 'completed', 'sales')").run(leadId);
  const callId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  db.prepare(
    "INSERT INTO voice_sessions (campaign_id, lead_id, call_id, provider, status, phase) VALUES (?, ?, ?, 'fake', 'ended', 'awaiting')"
  ).run(campaignId, leadId, callId);
  const sessionId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  db.prepare('INSERT INTO voice_events (session_id, event_type, direction, payload, created_at) VALUES (?, ?, ?, ?, ?)').run(
    sessionId,
    eventType,
    'inbound',
    '{"text":"hi"}',
    createdAt
  );
}

function count(db, table) {
  return db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
}

// ---- pure classification ---------------------------------------------------

test('parseSqliteUtc accepts only SQLite UTC datetimes', () => {
  assert.equal(parseSqliteUtc('2026-06-15 12:00:00'), nowMs);
  assert.equal(parseSqliteUtc('2026-06-15T12:00:00Z'), null);
  assert.equal(parseSqliteUtc('not a date'), null);
  assert.equal(parseSqliteUtc('2026-13-45 99:99:99'), null);
  assert.equal(parseSqliteUtc(null), null);
  assert.equal(parseSqliteUtc(undefined), null);
});

test('boundary: a row exactly at the cutoff expires; one second newer is kept', () => {
  const retention = new Map([[1, 30]]);
  const atCutoff = iso(nowMs - 30 * DAY);
  const justInside = iso(nowMs - 30 * DAY + 1000);
  assert.equal(classifyRetention({ campaignId: 1, createdAt: atCutoff }, retention, nowMs), 'expired');
  assert.equal(classifyRetention({ campaignId: 1, createdAt: justInside }, retention, nowMs), 'kept');
});

test('zero-day retention expires everything already written, but never future-dated rows', () => {
  const retention = new Map([[1, 0]]);
  assert.equal(classifyRetention({ campaignId: 1, createdAt: iso(nowMs) }, retention, nowMs), 'expired');
  assert.equal(classifyRetention({ campaignId: 1, createdAt: iso(nowMs - 1000) }, retention, nowMs), 'expired');
  assert.equal(classifyRetention({ campaignId: 1, createdAt: iso(nowMs + 60000) }, retention, nowMs), 'kept');
});

test('missing profile, unlinked row, invalid retention and invalid dates are kept and reported', () => {
  const retention = new Map([[1, 30], [2, -5], [3, MAX_RETENTION_DAYS + 1]]);
  const old = iso(nowMs - 400 * DAY);
  assert.equal(classifyRetention({ campaignId: 99, createdAt: old }, retention, nowMs), 'no_profile');
  assert.equal(classifyRetention({ campaignId: null, createdAt: old }, retention, nowMs), 'no_profile');
  assert.equal(classifyRetention({ campaignId: 2, createdAt: old }, retention, nowMs), 'invalid_retention');
  assert.equal(classifyRetention({ campaignId: 3, createdAt: old }, retention, nowMs), 'invalid_retention');
  assert.equal(classifyRetention({ campaignId: 1, createdAt: 'garbage' }, retention, nowMs), 'invalid_date');
  assert.equal(classifyRetention({ campaignId: 1, createdAt: null }, retention, nowMs), 'invalid_date');
});

// ---- database-backed plan (temporary in-memory db) -------------------------

test('dry run counts expirations per campaign without changing any row', () => {
  const db = createDb(':memory:');
  try {
    const a = makeCampaign(db, 'A', 30);
    const b = makeCampaign(db, 'B', 7);
    const orphan = makeCampaign(db, 'NoProfile', null);
    addTranscript(db, a, iso(nowMs - 31 * DAY)); // expired
    addTranscript(db, a, iso(nowMs - 5 * DAY)); // kept
    addTranscript(db, b, iso(nowMs - 8 * DAY)); // expired
    addTranscript(db, orphan, iso(nowMs - 999 * DAY)); // no profile -> kept
    addTranscript(db, null, iso(nowMs - 999 * DAY)); // unlinked -> kept
    addTranscript(db, a, 'not-a-date'); // invalid -> kept
    addVoiceSpeech(db, a, iso(nowMs - 40 * DAY)); // expired voice speech
    addVoiceSpeech(db, a, iso(nowMs - 40 * DAY), 'lead:dtmf'); // not a transcript event

    const before = { t: count(db, 'ai_transcripts'), v: count(db, 'voice_events') };
    const { report } = planTranscriptRetention(db, { now: NOW });
    assert.equal(report.dryRun, true);
    assert.equal(report.sources.aiTranscripts.scanned, 6);
    assert.equal(report.sources.aiTranscripts.expired, 2);
    assert.equal(report.sources.aiTranscripts.unresolved.noProfile, 2);
    assert.equal(report.sources.aiTranscripts.unresolved.invalidDate, 1);
    assert.equal(report.sources.voiceEvents.scanned, 1, 'only lead:speech/ai:say are in scope');
    assert.equal(report.sources.voiceEvents.expired, 1);
    assert.equal(report.totals.expired, 3);
    // Campaign A: one expired transcript (31d) + one expired voice speech (40d).
    // Campaign B: one expired transcript (8d).
    assert.deepEqual(
      report.byCampaign.map((c) => [c.campaignId, c.expired, c.retentionDays]),
      [
        [a, 2, 30],
        [b, 1, 7],
      ]
    );
    assert.equal(count(db, 'ai_transcripts'), before.t);
    assert.equal(count(db, 'voice_events'), before.v);
  } finally {
    db.close();
  }
});

test('zero-day and missing-profile campaigns are reported with the correct retention value', () => {
  const db = createDb(':memory:');
  try {
    const zero = makeCampaign(db, 'Zero', 0);
    addTranscript(db, zero, iso(nowMs - 1000));
    const { report } = planTranscriptRetention(db, { now: NOW });
    assert.equal(report.byCampaign.length, 1);
    assert.equal(report.byCampaign[0].retentionDays, 0);
    assert.equal(report.byCampaign[0].expired, 1);
  } finally {
    db.close();
  }
});

test('execute refuses without the confirmation token and deletes nothing', () => {
  const db = createDb(':memory:');
  try {
    const c = makeCampaign(db, 'C', 30);
    addTranscript(db, c, iso(nowMs - 90 * DAY));
    assert.throws(
      () => executeTranscriptRetention(db, { now: NOW }),
      (err) => err.status === 400 && err.message === 'retention_confirmation_required'
    );
    assert.throws(
      () => executeTranscriptRetention(db, { now: NOW, confirm: 'yes' }),
      (err) => err.status === 400
    );
    assert.equal(count(db, 'ai_transcripts'), 1);
  } finally {
    db.close();
  }
});

test('execute with a stale expected count refuses and deletes nothing', () => {
  const db = createDb(':memory:');
  try {
    const c = makeCampaign(db, 'C', 30);
    addTranscript(db, c, iso(nowMs - 90 * DAY));
    assert.throws(
      () => executeTranscriptRetention(db, { now: NOW, confirm: RETENTION_CONFIRM, expectedTotal: 5 }),
      (err) => err.status === 409 && err.message === 'retention_plan_changed'
    );
    assert.equal(count(db, 'ai_transcripts'), 1);
  } finally {
    db.close();
  }
});

test('execute deletes only expired transcript text, leaves everything else, and audits the run', () => {
  const db = createDb(':memory:');
  try {
    const c = makeCampaign(db, 'C', 30);
    addTranscript(db, c, iso(nowMs - 90 * DAY)); // expired
    addTranscript(db, c, iso(nowMs - 1 * DAY)); // kept
    addTranscript(db, null, iso(nowMs - 900 * DAY)); // unlinked, kept
    addVoiceSpeech(db, c, iso(nowMs - 90 * DAY)); // expired
    const leadsBefore = count(db, 'leads');
    const callsBefore = count(db, 'calls');
    const consentsBefore = count(db, 'dialer_consents');
    const auditBefore = count(db, 'audit_log');
    const profilesBefore = count(db, 'campaign_compliance');

    const { expiredTotal } = planTranscriptRetention(db, { now: NOW });
    const result = executeTranscriptRetention(db, {
      now: NOW,
      confirm: RETENTION_CONFIRM,
      expectedTotal: expiredTotal,
      username: 'operator',
    });
    assert.deepEqual(result.deleted, { aiTranscripts: 1, voiceEvents: 1 });
    assert.equal(result.totalDeleted, 2);
    assert.equal(count(db, 'ai_transcripts'), 2);
    assert.equal(count(db, 'voice_events'), 0);
    assert.equal(count(db, 'leads'), leadsBefore);
    assert.equal(count(db, 'calls'), callsBefore);
    assert.equal(count(db, 'dialer_consents'), consentsBefore);
    assert.equal(count(db, 'campaign_compliance'), profilesBefore);
    assert.equal(count(db, 'audit_log'), auditBefore + 1);
    const entry = db.prepare("SELECT actor, details FROM audit_log WHERE action = 'transcript_retention_executed'").get();
    assert.equal(entry.actor, 'operator');
    assert.ok(!entry.details.includes('hello'), 'audit records counts, never transcript text');
  } finally {
    db.close();
  }
});

test('a database failure mid-delete rolls back every removal (no partial retention)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'apex-ret-'));
  const file = path.join(dir, 'fail.db');
  const db = createDb(file);
  try {
    const c = makeCampaign(db, 'C', 30);
    addTranscript(db, c, iso(nowMs - 90 * DAY));
    addVoiceSpeech(db, c, iso(nowMs - 90 * DAY));
    // Simulate a storage failure on the SECOND delete (voice events). The first
    // delete (transcripts) must be rolled back as well.
    db.exec(
      "CREATE TRIGGER fail_voice_delete BEFORE DELETE ON voice_events BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END;"
    );
    const { expiredTotal } = planTranscriptRetention(db, { now: NOW });
    assert.equal(expiredTotal, 2);
    assert.throws(
      () => executeTranscriptRetention(db, { now: NOW, confirm: RETENTION_CONFIRM, expectedTotal: 2 }),
      (err) => err.status === 500 && err.message === 'retention_failed'
    );
    assert.equal(count(db, 'ai_transcripts'), 1, 'transcript delete was rolled back');
    assert.equal(count(db, 'voice_events'), 1, 'voice delete never happened');
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'transcript_retention_executed'").get().c, 0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('planning on a closed database fails loudly instead of reporting zero', () => {
  const db = createDb(':memory:');
  db.close();
  assert.throws(() => planTranscriptRetention(db, { now: NOW }));
});

test('an invalid "now" is rejected', () => {
  const db = createDb(':memory:');
  try {
    assert.throws(() => planTranscriptRetention(db, { now: new Date('nope') }), (err) => err.status === 400);
  } finally {
    db.close();
  }
});

// ---- HTTP surface -----------------------------------------------------------

test('GET /api/compliance/retention is a read-only dry run; POST requires the confirmation', async () => {
  await withServer(async (base, db) => {
    const c = makeCampaign(db, 'HTTP', 30);
    addTranscript(db, c, iso(Date.now() - 90 * DAY));
    const dry = await api(base, 'GET', '/api/compliance/retention');
    assert.equal(dry.status, 200);
    assert.equal(dry.body.data.dryRun, true);
    assert.equal(dry.body.data.totals.expired, 1);
    assert.equal(count(db, 'ai_transcripts'), 1, 'dry run deletes nothing');

    const noConfirm = await api(base, 'POST', '/api/compliance/retention/execute', {});
    assert.equal(noConfirm.status, 400);
    assert.equal(noConfirm.body.error, 'retention_confirmation_required');

    const stale = await api(base, 'POST', '/api/compliance/retention/execute', { confirm: RETENTION_CONFIRM, expectedTotal: 9 });
    assert.equal(stale.status, 409);
    assert.equal(count(db, 'ai_transcripts'), 1);

    const ok = await api(base, 'POST', '/api/compliance/retention/execute', {
      confirm: RETENTION_CONFIRM,
      expectedTotal: 1,
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.data.deleted.aiTranscripts, 1);
    assert.equal(count(db, 'ai_transcripts'), 0);
  });
});

test('retention endpoints require authentication', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/compliance/retention`);
    assert.equal(res.status, 401);
  });
});

// ---- operator CLI -----------------------------------------------------------

function fileDb(dir, name = 'ops.db') {
  const file = path.join(dir, name);
  const db = createDb(file);
  return { file, db };
}

test('CLI dry run prints the report from a read-only open and leaves the file unchanged', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'apex-cli-'));
  const { file, db } = fileDb(dir);
  const c = makeCampaign(db, 'CLI', 30);
  addTranscript(db, c, iso(Date.now() - 90 * DAY));
  db.close();
  const out = [];
  try {
    const code = await runRetentionCli(['--db', file], { log: (s) => out.push(s), error: (s) => out.push(s) });
    assert.equal(code, 0);
    const report = JSON.parse(out.join('\n'));
    assert.equal(report.dryRun, true);
    assert.equal(report.totals.expired, 1);
    const check = new Database(file, { readonly: true });
    assert.equal(check.prepare('SELECT COUNT(*) AS c FROM ai_transcripts').get().c, 1);
    check.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI execute refuses without every safety flag and never creates a backup in that case', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'apex-cli-'));
  const { file, db } = fileDb(dir);
  makeCampaign(db, 'CLI', 30);
  db.close();
  const errors = [];
  try {
    const backup = path.join(dir, 'b.db');
    const code = await runRetentionCli(['--db', file, '--execute', '--backup-to', backup], {
      log: () => {},
      error: (s) => errors.push(s),
    });
    assert.equal(code, 2);
    assert.match(errors.join('\n'), /--confirm/);
    assert.equal(existsSync(backup), false);

    const badArg = await runRetentionCli(['--nope'], { log: () => {}, error: (s) => errors.push(s) });
    assert.equal(badArg, 2);

    const missing = await runRetentionCli([path.join(dir, 'missing.db')], { log: () => {}, error: (s) => errors.push(s) });
    assert.equal(missing, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI execute writes a backup first, then deletes expired rows', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'apex-cli-'));
  const { file, db } = fileDb(dir);
  const c = makeCampaign(db, 'CLI', 30);
  addTranscript(db, c, iso(Date.now() - 90 * DAY));
  addTranscript(db, c, iso(Date.now() - 1 * DAY));
  db.close();
  const log = [];
  try {
    const backup = path.join(dir, 'pre-retention.db');
    const code = await runRetentionCli(
      ['--db', file, '--execute', '--confirm', RETENTION_CONFIRM, '--expected', '1', '--backup-to', backup],
      { log: (s) => log.push(s), error: (s) => log.push(s) }
    );
    assert.equal(code, 0, log.join('\n'));
    assert.equal(existsSync(backup), true, 'backup written before deletion');
    const backupDb = new Database(backup, { readonly: true });
    assert.equal(backupDb.prepare('SELECT COUNT(*) AS c FROM ai_transcripts').get().c, 2, 'backup keeps pre-retention data');
    backupDb.close();
    const after = new Database(file, { readonly: true });
    assert.equal(after.prepare('SELECT COUNT(*) AS c FROM ai_transcripts').get().c, 1);
    after.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI refuses to overwrite an existing backup path', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'apex-cli-'));
  const { file, db } = fileDb(dir);
  makeCampaign(db, 'CLI', 30);
  db.close();
  const errors = [];
  try {
    const code = await runRetentionCli(
      ['--db', file, '--execute', '--confirm', RETENTION_CONFIRM, '--expected', '0', '--backup-to', file],
      { log: () => {}, error: (s) => errors.push(s) }
    );
    assert.equal(code, 2);
    assert.match(errors.join('\n'), /new file path/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
