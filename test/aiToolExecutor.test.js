import test from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/db/db.js';
import { mergeConfig } from '../src/app.js';
import { executeAiToolCall } from '../src/services/aiToolExecutor.js';
import { voiceScript } from '../src/services/voiceAgent.js';

function seed(db) {
  db.prepare("INSERT INTO leads (name, phone, timezone, status) VALUES ('Lead', '+15550123456', 'Etc/GMT+0', 'pending')").run();
  const leadId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  db.prepare("INSERT INTO campaigns (name, status) VALUES ('C', 'running')").run();
  const campaignId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  db.prepare("INSERT INTO campaign_leads (campaign_id, lead_id, status) VALUES (?, ?, 'dialing')").run(campaignId, leadId);
  db.prepare("INSERT INTO calls (lead_id, direction, status, call_type, started_at) VALUES (?, 'outbound', 'in_progress', 'sales', datetime('now'))").run(leadId);
  const callId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  db.prepare(
    "INSERT INTO voice_sessions (campaign_id, lead_id, call_id, provider, status, phase, started_at) VALUES (?, ?, ?, 'fake', 'in_progress', 'awaiting', datetime('now'))"
  ).run(campaignId, leadId, callId);
  const sessionId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  return { leadId, campaignId, callId, sessionId };
}

function sessionStatus(db, id) {
  return db.prepare('SELECT status, outcome FROM voice_sessions WHERE id = ?').get(id);
}

const cfg = mergeConfig({});

test('approved_response speaks only a configured script line and never model text', () => {
  const db = createDb(':memory:');
  try {
    const { sessionId } = seed(db);
    const result = executeAiToolCall(db, { id: sessionId }, { name: 'approved_response', arguments: { lineKey: 'goodbye' } }, { cfg });
    assert.equal(result.ok, true);
    assert.deepEqual(result.say, [voiceScript(cfg.voice).goodbye]);
    const say = db.prepare("SELECT COUNT(*) AS c FROM voice_events WHERE session_id = ? AND event_type = 'ai:say'").get(sessionId);
    assert.equal(say.c, 1);
    // Free text cannot ride along.
    assert.throws(
      () => executeAiToolCall(db, { id: sessionId }, { name: 'approved_response', arguments: { lineKey: 'goodbye', text: '50% off' } }, { cfg }),
      (err) => err.status === 400
    );
  } finally {
    db.close();
  }
});

test('opt_out persists suppression and finalizes the session as opted_out', () => {
  const db = createDb(':memory:');
  try {
    const { sessionId } = seed(db);
    const result = executeAiToolCall(
      db,
      { id: sessionId },
      { name: 'opt_out', arguments: { confirm: true, reason: 'caller said stop' } },
      { cfg }
    );
    assert.equal(result.end, true);
    assert.equal(result.outcome, 'opted_out');
    assert.equal(sessionStatus(db, sessionId).status, 'ended');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM opt_outs').get().c, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM dnc_entries WHERE active = 1").get().c, 1);
  } finally {
    db.close();
  }
});

test('callback and end_call map to the correct dispositions', () => {
  const db = createDb(':memory:');
  try {
    const a = seed(db);
    const cb = executeAiToolCall(db, { id: a.sessionId }, { name: 'callback_request', arguments: {} }, { cfg });
    assert.equal(cb.outcome, 'callback');

    const b = seed(db);
    const end = executeAiToolCall(db, { id: b.sessionId }, { name: 'end_call', arguments: { reason: 'done' } }, { cfg });
    assert.equal(end.outcome, 'unanswered');
    assert.equal(sessionStatus(db, b.sessionId).status, 'ended');
  } finally {
    db.close();
  }
});

test('a transfer request requires a configured, valid transfer number', () => {
  const db = createDb(':memory:');
  try {
    const a = seed(db);
    const noNumber = executeAiToolCall(db, { id: a.sessionId }, { name: 'transfer_request', arguments: {} }, { cfg });
    assert.equal(noNumber.ok, false);
    assert.equal(noNumber.rejected, 'transfer_unavailable');
    assert.equal(sessionStatus(db, a.sessionId).status, 'in_progress', 'a rejected transfer must not end the session');

    const b = seed(db);
    const withNumber = executeAiToolCall(
      db,
      { id: b.sessionId },
      { name: 'transfer_request', arguments: {} },
      { cfg: mergeConfig({ voice: { transferNumber: '+15559990000' } }) }
    );
    assert.equal(withNumber.outcome, 'connected');
  } finally {
    db.close();
  }
});

test('keypad routing maps a valid digit to an outcome', () => {
  const db = createDb(':memory:');
  try {
    const { sessionId } = seed(db);
    const result = executeAiToolCall(db, { id: sessionId }, { name: 'keypad_routing', arguments: { digit: '1' } }, { cfg });
    assert.equal(result.ok, true);
    assert.equal(result.end, true);
    assert.equal(result.outcome, 'completed');
  } finally {
    db.close();
  }
});

test('disallowed tools throw and invalid arguments are rejected', () => {
  const db = createDb(':memory:');
  try {
    const { sessionId } = seed(db);
    assert.throws(
      () => executeAiToolCall(db, { id: sessionId }, { name: 'wire_transfer', arguments: {} }, { cfg }),
      (err) => err.status === 400 && err.message === 'tool_not_allowed'
    );
    assert.throws(
      () => executeAiToolCall(db, { id: sessionId }, { name: 'opt_out', arguments: { confirm: false } }, { cfg }),
      (err) => err.status === 400
    );
  } finally {
    db.close();
  }
});

test('duplicate tool calls and an exhausted tool budget are rejected and audited', () => {
  const db = createDb(':memory:');
  try {
    const { sessionId } = seed(db);
    const first = executeAiToolCall(
      db,
      { id: sessionId },
      { name: 'approved_response', callId: 'call_1', arguments: { lineKey: 'reprompt' } },
      { cfg }
    );
    assert.equal(first.ok, true);
    const dup = executeAiToolCall(
      db,
      { id: sessionId },
      { name: 'approved_response', callId: 'call_1', arguments: { lineKey: 'reprompt' } },
      { cfg }
    );
    assert.equal(dup.rejected, 'duplicate_tool_call');

    const tiny = mergeConfig({ voice: { maxToolCalls: 1 } });
    const other = seed(db);
    executeAiToolCall(db, { id: other.sessionId }, { name: 'approved_response', arguments: { lineKey: 'reprompt' } }, { cfg: tiny });
    const over = executeAiToolCall(db, { id: other.sessionId }, { name: 'approved_response', arguments: { lineKey: 'reprompt' } }, { cfg: tiny });
    assert.equal(over.rejected, 'tool_budget_exhausted');
  } finally {
    db.close();
  }
});

test('a suppressed/opted-out contact may only be ended or opted out', () => {
  const db = createDb(':memory:');
  try {
    const { sessionId, leadId } = seed(db);
    db.prepare("UPDATE leads SET status = 'dnc', suppression_blocked = 1 WHERE id = ?").run(leadId);
    const blocked = executeAiToolCall(db, { id: sessionId }, { name: 'approved_response', arguments: { lineKey: 'greeting' } }, { cfg });
    assert.equal(blocked.rejected, 'policy_blocked');
    const allowed = executeAiToolCall(db, { id: sessionId }, { name: 'end_call', arguments: {} }, { cfg });
    assert.equal(allowed.ok, true);
    assert.equal(allowed.end, true);
  } finally {
    db.close();
  }
});

test('a call past its duration cap may only be ended, and a terminal session rejects further calls', () => {
  const db = createDb(':memory:');
  try {
    const { sessionId } = seed(db);
    const over = executeAiToolCall(
      db,
      { id: sessionId },
      { name: 'approved_response', arguments: { lineKey: 'greeting' } },
      { cfg, elapsedMs: (cfg.voice.maxCallSeconds + 1) * 1000 }
    );
    assert.equal(over.rejected, 'call_duration_exceeded');

    executeAiToolCall(db, { id: sessionId }, { name: 'end_call', arguments: {} }, { cfg });
    const after = executeAiToolCall(db, { id: sessionId }, { name: 'approved_response', arguments: { lineKey: 'reprompt' } }, { cfg });
    assert.equal(after.rejected, 'session_ended');
  } finally {
    db.close();
  }
});
