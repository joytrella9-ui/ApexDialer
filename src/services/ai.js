// Simulated AI conversation engine. This is intentionally a deterministic,
// offline intent classifier — it contacts NO external model, downloads no model
// weights, and processes no audio. It exists so the AI-dialer turn loop, routing,
// and persistence can be built and tested end-to-end without a live AI provider.
// A real integration would replace `classifyIntent` with a provider call while
// keeping the same turn/route contract.
export const AI_OBJECTIVES = Object.freeze({
  default: 'Confirm interest, offer a callback, transfer to a representative, or honor an opt-out.',
});

const INTENT_RULES = [
  { intent: 'opt_out', patterns: [/\bopt[\s-]?out\b/i, /\bstop\b/i, /\bremove me\b/i, /\bdo ?n'?t call\b/i, /\bunsubscribe\b/i] },
  { intent: 'representative', patterns: [/\b(speak|talk) to (a )?(human|person|agent|representative|someone)\b/i, /\brepresentative\b/i, /\breal person\b/i] },
  { intent: 'callback', patterns: [/\bcall (me )?(back|later)\b/i, /\bcallback\b/i, /\bbusy\b/i, /\btomorrow\b/i, /\bnot (a )?good time\b/i] },
  { intent: 'interested', patterns: [/\binterested\b/i, /\btell me more\b/i, /\byes\b/i, /\bsounds good\b/i, /\bsign me up\b/i] },
];

export const INTENT_ROUTES = Object.freeze({
  interested: { route: 'interested', outcome: 'completed' },
  callback: { route: 'callback', outcome: 'callback' },
  representative: { route: 'representative', outcome: 'connected' },
  opt_out: { route: 'opt_out', outcome: 'opted_out' },
  unknown: { route: 'unknown', outcome: null },
});

export function classifyIntent(text) {
  const value = String(text ?? '');
  for (const rule of INTENT_RULES) {
    if (rule.patterns.some((p) => p.test(value))) return rule.intent;
  }
  return 'unknown';
}

function firstName(lead) {
  const name = String(lead?.name ?? '').trim();
  return name ? name.split(/\s+/)[0] : 'there';
}

export function aiOpening(lead) {
  return `Hello ${firstName(lead)}, this is an automated assistant. Do you have a moment?`;
}

export function aiReplyFor(intent) {
  switch (intent) {
    case 'interested':
      return 'Great — I will mark you as interested and a specialist will follow up.';
    case 'callback':
      return 'Understood. When would be a good time for us to call you back?';
    case 'representative':
      return 'Of course — transferring you to a representative now.';
    case 'opt_out':
      return 'I am sorry to have bothered you. I have added you to our do-not-call list and you will not be contacted again.';
    default:
      return 'I did not quite catch that. Would you like to hear more, request a callback, or speak with a representative?';
  }
}

export function recordTranscript(db, { campaignId = null, leadId = null, callRef = '', role, text, intent = '' }) {
  db.prepare(
    'INSERT INTO ai_transcripts (campaign_id, lead_id, call_ref, role, text, intent) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(campaignId, leadId, callRef, role, text, intent);
}

// One simulated turn: classify the (provided) lead utterance, persist both sides
// of the exchange, and return the workflow route the caller should take.
export function runSimulatedTurn(db, { campaignId = null, leadId = null, callRef = '', text = '' }) {
  const intent = classifyIntent(text);
  const route = INTENT_ROUTES[intent] ?? INTENT_ROUTES.unknown;
  recordTranscript(db, { campaignId, leadId, callRef, role: 'lead', text, intent });
  recordTranscript(db, { campaignId, leadId, callRef, role: 'ai', text: aiReplyFor(intent), intent });
  return { intent, route: route.route, outcome: route.outcome };
}
