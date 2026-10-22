import { config } from '../config.js';
import { HttpError } from '../lib/errors.js';
import { getLead, isSuppressed, phoneKey } from './leads.js';
import { isOptedOut } from './optouts.js';

export const DISCLAIMER =
  'Preliminary internal guardrail only. It is NOT a legal compliance certification. ' +
  'Consent data and imported claims are self-asserted and are not independently verified.';

const WINDOW_CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

function pad(n) {
  return String(n).padStart(2, '0');
}

function toDate(value) {
  if (value === undefined || value === null) return new Date();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timeZone.trim() });
    return true;
  } catch {
    return false;
  }
}

function parseWindowClock(value) {
  const match = WINDOW_CLOCK.exec(String(value ?? '').trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function zonedParts(date, timeZone) {
  const parts = {};
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  });
  for (const part of dtf.formatToParts(date)) parts[part.type] = part.value;

  const hour = Number(parts.hour) % 24;
  const wallAsUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hour,
    Number(parts.minute),
    Number(parts.second)
  );
  const utcMs = date.getTime() - date.getMilliseconds();
  const utcOffsetMinutes = Math.round((wallAsUTC - utcMs) / 60000);

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute: Number(parts.minute),
    weekday: parts.weekday,
    utcOffsetMinutes,
  };
}

function evaluateConsent(callType, consent, add) {
  const status = consent?.status ?? 'none';
  const evidence = String(consent?.evidence ?? '').trim();
  const source = String(consent?.source ?? '').trim();
  const date = String(consent?.date ?? '').trim();
  const base = { status, evidence: !!evidence, source: !!source, date: !!date };

  if (callType === 'existing-customer') {
    if (status === 'revoked') {
      add('consent_revoked', 'block', 'Consent was revoked for this contact.');
      return { ...base, required: false, proofLevel: 'revoked' };
    }
    add('consent_not_required', 'info', 'Existing-customer calls do not require marketing consent.');
    return { ...base, required: false, proofLevel: 'not-required' };
  }

  if (callType === 'sales') {
    if (status === 'revoked') {
      add('consent_revoked', 'block', 'Consent was revoked for this contact.');
      return { ...base, required: true, proofLevel: 'revoked' };
    }
    if (status !== 'recorded') {
      add('missing_consent', 'block', 'Sales calls require a recorded consent status.');
      return { ...base, required: true, proofLevel: 'missing' };
    }
    if (!evidence) {
      add('insufficient_consent_evidence', 'block', 'Consent is marked recorded but no evidence is on file.');
      return { ...base, required: true, proofLevel: 'insufficient' };
    }
    if (!source || !date) {
      add(
        'consent_metadata_incomplete',
        'review',
        'Consent evidence exists but the source and/or date is incomplete; a human should verify before dialing.'
      );
      return { ...base, required: true, proofLevel: 'self-asserted' };
    }
    return { ...base, required: true, proofLevel: 'self-asserted' };
  }

  add('unknown_call_type', 'block', `Unknown call type "${callType ?? ''}"; compliance cannot be evaluated.`);
  return { ...base, required: true, proofLevel: 'unknown' };
}

function evaluateSchedule(timeZone, now, window, add) {
  const tz = typeof timeZone === 'string' ? timeZone.trim() : '';
  if (!tz) {
    add('missing_timezone', 'block', 'Lead has no timezone; recipient-local calling hours cannot be verified.');
    return { timeZone: null, valid: false };
  }
  if (!isValidTimeZone(tz)) {
    add('invalid_timezone', 'block', `"${tz}" is not a valid IANA timezone.`);
    return { timeZone: tz, valid: false };
  }

  const startMinutes = parseWindowClock(window.start);
  const endMinutes = parseWindowClock(window.end);
  if (startMinutes === null || endMinutes === null) {
    add('invalid_calling_window_config', 'block', 'Calling window configuration is invalid.');
    return { timeZone: tz, valid: true, window: { start: window.start, end: window.end, valid: false } };
  }

  const p = zonedParts(now, tz);
  const localMinutes = p.hour * 60 + p.minute;
  const open =
    startMinutes <= endMinutes
      ? localMinutes >= startMinutes && localMinutes < endMinutes
      : localMinutes >= startMinutes || localMinutes < endMinutes;

  if (open) {
    add('within_calling_window', 'info', 'Recipient-local time is inside the calling window.');
  } else {
    add(
      'outside_calling_window',
      'block',
      `Recipient-local time ${pad(p.hour)}:${pad(p.minute)} is outside the ${window.start}-${window.end} window.`
    );
  }

  return {
    timeZone: tz,
    valid: true,
    localTime: `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`,
    localWeekday: p.weekday,
    localHour: p.hour,
    localMinute: p.minute,
    utcOffsetMinutes: p.utcOffsetMinutes,
    window: {
      start: window.start,
      end: window.end,
      startMinutes,
      endMinutes,
      open,
    },
  };
}

export function evaluateLead(db, lead, options = {}) {
  const now = toDate(options.now);
  if (!now) throw new HttpError(400, 'invalid_time');
  const window =
    options.window ?? { start: config.compliance.callWindowStart, end: config.compliance.callWindowEnd };

  const reasons = [];
  const add = (code, severity, message) => reasons.push({ code, severity, message });

  const callType = lead.callType;
  const dncMatched = isSuppressed(db, lead.phone);
  const optedOut = isOptedOut(db, lead.phone);
  const row = db.prepare('SELECT suppression_blocked FROM leads WHERE id = ?').get(lead.id) ?? {};
  const suppressionFlagged = row.suppression_blocked === 1;

  if (optedOut) {
    add('opted_out', 'block', 'Contact has persistently opted out and must not be called.');
  }
  if (dncMatched) {
    add('internal_dnc', 'block', 'Phone number matches the internal Do Not Call list.');
  }
  if (suppressionFlagged) {
    add('suppression_flagged', 'block', 'Lead is flagged as suppressed.');
  }

  if (lead.status === 'completed') {
    add('lead_status_completed', 'block', 'Lead is already marked completed.');
  } else if (lead.status === 'dnc') {
    add('lead_status_dnc', 'block', 'Lead is marked Do Not Call.');
  } else if (lead.status === 'blocked' && !dncMatched && !suppressionFlagged) {
    add('lead_status_blocked', 'block', 'Lead status is blocked.');
  }

  const consent = evaluateConsent(callType, lead.consent, add);
  const schedule = evaluateSchedule(lead.timezone, now, window, add);

  const blocked = reasons.some((r) => r.severity === 'block');
  const review = reasons.some((r) => r.severity === 'review');
  const decision = blocked ? 'blocked' : review ? 'review' : 'allowed';
  const mayDial = decision === 'allowed';

  return {
    decision,
    allowed: mayDial,
    mayDial,
    leadId: lead.id,
    callType,
    leadStatus: lead.status,
    phoneKey: phoneKey(lead.phone),
    reasons,
    details: {
      evaluatedAt: now.toISOString(),
      dnc: { matched: dncMatched },
      optOut: { matched: optedOut },
      suppression: { flagged: suppressionFlagged },
      consent,
      schedule,
    },
    disclaimer: DISCLAIMER,
  };
}

export function evaluateLeadById(db, id, options) {
  const lead = getLead(db, id);
  if (!lead) return null;
  return evaluateLead(db, lead, options);
}
