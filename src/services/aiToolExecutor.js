import { config } from '../config.js';
import { HttpError } from '../lib/errors.js';
import { audit } from './auth.js';
import { getLead, isSuppressed } from './leads.js';
import { isOptedOut, addOptOut } from './optouts.js';
import { resolveIvrInput } from './ivr.js';
import { voiceScript } from './voiceAgent.js';
import { finalizeSession } from './voiceSessions.js';
import { normalizeToolCall, resolveApprovedResponse } from '../providers/aiTools.js';
import { isE164 } from '../providers/twilioVoice.js';

// =============================================================================
// BOUNDED, AUDITABLE AI TOOL EXECUTOR
// =============================================================================
// The server is authoritative. Every model tool call is re-validated against the
// allowlist (see providers/aiTools.js), then subject to policy: a per-session
// tool-call budget, a duplicate-call guard, a call-duration cap, and a rule that a
// suppressed/opted-out contact may only be ended or opted out. The model can
// never override eligibility, consent, opt-out, calling-hour, or transfer policy.
const TERMINAL_ACTIONS = new Set(['opt_out', 'end_call']);
const TERMINAL_STATUSES = new Set(['ended', 'failed']);
const MAX_PAYLOAD = 4000;

function writeEvent(db, sessionId, eventType, direction, payload) {
  db.prepare('INSERT INTO voice_events (session_id, event_type, direction, payload) VALUES (?, ?, ?, ?)').run(
    sessionId,
    eventType,
    direction,
    JSON.stringify(payload).slice(0, MAX_PAYLOAD)
  );
}

function recordTool(db, sessionId, entry) {
  writeEvent(db, sessionId, 'ai:tool', 'system', entry);
}

function priorCallIds(db, sessionId) {
  const rows = db
    .prepare("SELECT payload FROM voice_events WHERE session_id = ? AND event_type = 'ai:tool'")
    .all(sessionId);
  const ids = new Set();
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.payload);
      if (parsed?.callId) ids.add(parsed.callId);
    } catch {
      // ignore unparseable historical payloads
    }
  }
  return ids;
}

function reject(db, session, call, code) {
  recordTool(db, session.id, { name: call.name, callId: call.callId ?? '', rejected: code });
  audit(db, 'ai', 'ai_tool_rejected', 'voice_session', String(session.id), JSON.stringify({ tool: call.name, code }));
  return { action: call.name, ok: false, rejected: code };
}

function finish(db, session, call, outcome, reason, cfg) {
  const updated = finalizeSession(db, session, { outcome, reason, username: 'ai', cfg });
  recordTool(db, session.id, { name: call.name, callId: call.callId ?? '', outcome, reason });
  return { action: call.name, ok: true, end: true, outcome, reason, session: updated };
}

// Execute one raw tool call against a live voice session. Returns a structured
// result; it does not throw for policy rejections (those are audited and
// returned), but does throw a 400 for a disallowed/invalid tool call.
export function executeAiToolCall(db, session, rawToolCall, { cfg = config, script, elapsedMs } = {}) {
  const call = normalizeToolCall(rawToolCall); // allowlist + strict args (throws 400)
  const row = db.prepare('SELECT * FROM voice_sessions WHERE id = ?').get(session?.id);
  if (!row) throw new HttpError(404, 'voice_session_not_found');
  if (TERMINAL_STATUSES.has(row.status)) return reject(db, row, call, 'session_ended');
  // No model action (speech, routing, or disposition) before the provider has
  // confirmed the call was answered. Nothing may be "said" to a ringing line.
  if (row.status !== 'in_progress') return reject(db, row, call, 'call_not_answered');

  const activeScript = script ?? voiceScript(cfg.voice);
  const budget = cfg.voice.maxToolCalls ?? 12;
  const prior = db
    .prepare("SELECT COUNT(*) AS c FROM voice_events WHERE session_id = ? AND event_type = 'ai:tool'")
    .get(row.id).c;
  if (prior >= budget) return reject(db, row, call, 'tool_budget_exhausted');

  if (call.callId && priorCallIds(db, row.id).has(call.callId)) {
    return reject(db, row, call, 'duplicate_tool_call');
  }

  const lead = row.lead_id ? getLead(db, row.lead_id) : null;
  const suppressed = lead
    ? isOptedOut(db, lead.phone) || isSuppressed(db, lead.phone) || ['dnc', 'blocked'].includes(lead.status)
    : false;
  if (suppressed && !TERMINAL_ACTIONS.has(call.name)) return reject(db, row, call, 'policy_blocked');

  const maxMs = (cfg.voice.maxCallSeconds ?? 600) * 1000;
  if (typeof elapsedMs === 'number' && elapsedMs > maxMs && !TERMINAL_ACTIONS.has(call.name)) {
    return reject(db, row, call, 'call_duration_exceeded');
  }

  switch (call.name) {
    case 'approved_response': {
      const text = resolveApprovedResponse(call.args.lineKey, activeScript);
      recordTool(db, row.id, { name: call.name, callId: call.callId ?? '', lineKey: call.args.lineKey });
      writeEvent(db, row.id, 'ai:say', 'outbound', { text });
      audit(db, 'ai', 'ai_tool', 'voice_session', String(row.id), JSON.stringify({ tool: call.name, lineKey: call.args.lineKey }));
      return { action: call.name, ok: true, say: [text] };
    }
    case 'keypad_routing': {
      const resolved = resolveIvrInput({ digit: call.args.digit, attempt: row.invalid_count ?? 0 });
      if (resolved.outcome) {
        return finish(db, row, call, resolved.outcome, `tool:dtmf:${resolved.route}`, cfg);
      }
      recordTool(db, row.id, { name: call.name, callId: call.callId ?? '', digit: call.args.digit, route: resolved.route });
      audit(db, 'ai', 'ai_tool', 'voice_session', String(row.id), JSON.stringify({ tool: call.name, route: resolved.route }));
      return { action: call.name, ok: true, route: resolved.route };
    }
    case 'opt_out': {
      if (lead) addOptOut(db, lead.phone, { source: 'ai', reason: call.args.reason, username: 'ai' });
      return finish(db, row, call, 'opted_out', 'tool:opt_out', cfg);
    }
    case 'callback_request':
      return finish(db, row, call, 'callback', 'tool:callback', cfg);
    case 'transfer_request': {
      if (!isE164(String(cfg.voice.transferNumber ?? '').trim())) {
        return reject(db, row, call, 'transfer_unavailable');
      }
      return finish(db, row, call, 'connected', 'tool:transfer', cfg);
    }
    case 'end_call':
      return finish(db, row, call, 'unanswered', 'tool:end_call', cfg);
    default:
      return reject(db, row, call, 'tool_not_allowed');
  }
}

export { TERMINAL_ACTIONS };
