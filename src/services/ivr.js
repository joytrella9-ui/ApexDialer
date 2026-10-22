// Simulated IVR. The menu is configurable data; DTMF input is validated against
// it, invalid input and timeouts are handled with a bounded number of retries, and
// each selection maps to a defined workflow. Nothing here touches a carrier — the
// digits arrive from the signed webhook sandbox or the engagement API.
export const DEFAULT_IVR_MENU = Object.freeze({
  key: 'default',
  prompt:
    'Press 1 if interested, press 2 for a callback, press 3 to speak with a representative, or press 9 to opt out.',
  options: Object.freeze({
    '1': { route: 'interested', outcome: 'completed' },
    '2': { route: 'callback', outcome: 'callback' },
    '3': { route: 'representative', outcome: 'connected' },
    '9': { route: 'opt_out', outcome: 'opted_out' },
  }),
  invalidRoute: 'invalid',
  timeoutRoute: 'timeout',
  timeoutOutcome: 'unanswered',
  maxRetries: 2,
});

export const DTMF = /^[0-9*#]$/;

export function isValidDigit(digit, menu = DEFAULT_IVR_MENU) {
  return typeof digit === 'string' && DTMF.test(digit.trim());
}

// Pure resolution: given an input event, return the route + internal outcome.
// `attempt` is the number of prior responses on this call (for timeout/invalid
// retry accounting).
export function resolveIvrInput({ digit, timedOut = false, attempt = 0 }, menu = DEFAULT_IVR_MENU) {
  if (timedOut) {
    const exhausted = attempt + 1 > menu.maxRetries;
    return {
      valid: false,
      timedOut: true,
      route: exhausted ? 'opt-retry-exhausted' : menu.timeoutRoute,
      outcome: exhausted ? menu.timeoutOutcome : null,
      prompt: menu.prompt,
    };
  }
  const key = typeof digit === 'string' ? digit.trim() : '';
  const option = menu.options[key];
  if (option) {
    return { valid: true, timedOut: false, route: option.route, outcome: option.outcome, menuKey: menu.key };
  }
  const exhausted = attempt + 1 > menu.maxRetries;
  return {
    valid: false,
    timedOut: false,
    route: exhausted ? 'opt-retry-exhausted' : menu.invalidRoute,
    outcome: exhausted ? menu.timeoutOutcome : null,
    prompt: menu.prompt,
    menuKey: menu.key,
  };
}

export function recordIvrResponse(
  db,
  { campaignId = null, leadId = null, callRef = '', digit = '', resolveResult }
) {
  db.prepare(
    `INSERT INTO ivr_responses (campaign_id, lead_id, call_ref, menu_key, digit, is_valid, timed_out, route)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    campaignId,
    leadId,
    callRef,
    resolveResult.menuKey ?? DEFAULT_IVR_MENU.key,
    digit,
    resolveResult.valid ? 1 : 0,
    resolveResult.timedOut ? 1 : 0,
    resolveResult.route
  );
}

export function ivrAttemptCount(db, { campaignId = null, leadId = null, callRef = '' }) {
  if (callRef) {
    return db
      .prepare('SELECT COUNT(*) AS c FROM ivr_responses WHERE call_ref = ?')
      .get(callRef).c;
  }
  return db
    .prepare('SELECT COUNT(*) AS c FROM ivr_responses WHERE campaign_id IS ? AND lead_id IS ?')
    .get(campaignId, leadId).c;
}
