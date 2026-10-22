import { config } from '../config.js';
import { HttpError } from '../lib/errors.js';
import { getLead } from './leads.js';
import { getCampaign } from './campaigns.js';
import { evaluateLead, DISCLAIMER } from './compliance.js';
import { getComplianceProfile, getConsent } from './complianceProfile.js';

// =============================================================================
// FAIL-CLOSED OUTBOUND DIALER ELIGIBILITY
// =============================================================================
// The single server-side gate every real (live) outbound AI/voice call must pass.
// It fails closed: any missing required information (no compliance profile, no
// granted consent, DNC/opt-out, outside calling hours, unconfigured jurisdiction)
// blocks the call. It NEVER infers the lead's country from the phone number and
// can NEVER enable recording. Presence of a lead in a CSV/campaign is not consent.
const CONSENT_REQUIRED_BASES = new Set(['express_written', 'express_verbal']);

export function evaluateDialerEligibility(db, { campaign, lead, now, cfg = config } = {}) {
  if (!campaign || !lead) throw new HttpError(400, 'missing_eligibility_context');
  const reasons = [];
  const add = (code, severity, message) => reasons.push({ code, severity, message });

  const profile = getComplianceProfile(db, campaign.id);

  // 1. Compliance profile must exist and be complete.
  let profileComplete = false;
  if (!profile) {
    add('compliance_profile_missing', 'block', 'Campaign has no compliance profile; live outbound calling is blocked.');
  } else {
    const missing = [];
    if (!profile.businessName) missing.push('business_name');
    if (!profile.legalIdentity) missing.push('legal_identity');
    if (!profile.aiDisclosure) missing.push('ai_disclosure');
    if (missing.length) {
      add('compliance_profile_incomplete', 'block', `Compliance profile is missing: ${missing.join(', ')}.`);
    }
    if (!profile.allowedCountries.length) {
      add('missing_jurisdiction', 'block', 'No allowed countries are declared; legal review is required before calling.');
    } else {
      add(
        'jurisdiction_declared',
        'info',
        `Allowed countries (operator-declared): ${profile.allowedCountries.join(', ')}. The lead's country is not inferred from the phone number.`
      );
    }
    profileComplete = missing.length === 0 && profile.allowedCountries.length > 0;
  }

  // 2. Consent, scoped to channel + purpose. A permissive basis must be explicit.
  const basis = profile?.consentBasis ?? 'none';
  const purpose = profile?.consentPurpose ?? 'sales';
  const consent = getConsent(db, lead.phone, { channel: 'voice', purpose });
  let consentOk = false;
  if (basis === 'none') {
    add('consent_basis_none', 'block', 'Consent basis is "none"; sales calls require an explicit recorded basis.');
  } else if (basis === 'existing_customer') {
    add('consent_existing_customer', 'info', 'Existing-customer basis declared; marketing consent is not required.');
    consentOk = true;
  } else if (!consent || consent.status !== 'granted') {
    add('consent_missing', 'block', 'No granted consent record for this number/channel/purpose.');
  } else if (!consent.evidence || !consent.source || !consent.consentedAt) {
    add('consent_incomplete', 'block', 'Consent record is missing evidence, source, or timestamp.');
  } else if (!consent.businessName) {
    add('consent_identity_missing', 'block', 'Consent record does not identify the seller/business.');
  } else {
    consentOk = true;
    add('consent_verified', 'info', 'A recorded, evidenced consent matches this number/channel/purpose.');
  }

  // 3. Reuse the established evaluator for DNC, opt-out, suppression, lead status,
  //    timezone, and calling hours. Its block reasons are incorporated verbatim.
  const base = evaluateLead(db, lead, {
    now,
    window: {
      start: campaign.callWindowStart ?? campaign.call_window_start,
      end: campaign.callWindowEnd ?? campaign.call_window_end,
    },
  });
  for (const r of base.reasons) add(r.code, r.severity, r.message);

  // 4. Recording gate. Never allowed by this foundation: it stays off until a
  //    future explicit, code-reviewed disclosure/consent path is added.
  const recording = {
    allowed: false,
    reason: profile?.recordingAllowed
      ? 'recording_requires_explicit_enablement'
      : 'recording_disabled_by_default',
    disclosureConfigured: Boolean(profile?.recordingDisclosure),
  };

  const blocked = reasons.some((r) => r.severity === 'block');
  const review = reasons.some((r) => r.severity === 'review');
  const decision = blocked ? 'blocked' : review ? 'review' : 'allowed';

  return {
    eligible: decision === 'allowed',
    decision,
    allowed: decision === 'allowed',
    campaignId: campaign.id,
    leadId: lead.id,
    phoneKey: base.phoneKey,
    profileComplete,
    consentOk,
    reasons,
    consent: consent
      ? {
          status: consent.status,
          hasEvidence: Boolean(consent.evidence),
          hasSource: Boolean(consent.source),
          hasTimestamp: Boolean(consent.consentedAt),
          identifiedBusiness: Boolean(consent.businessName),
        }
      : null,
    jurisdiction: {
      declared: profile?.allowedCountries ?? [],
      leadCountry: null,
      basis: 'operator-declared',
      inferred: false,
    },
    recording,
    retentionDays: profile?.retentionDays ?? cfg.compliance.transcriptRetentionDays,
    disclaimer: DISCLAIMER,
  };
}

// Convenience wrapper: resolve live rows then assess. `now` is injectable so
// calling-hours behavior is deterministic in tests.
export function assessOutboundCall(db, { campaignId, leadId, now, cfg = config } = {}) {
  const campaign = getCampaign(db, campaignId);
  if (!campaign) throw new HttpError(404, 'campaign_not_found');
  const lead = getLead(db, leadId);
  if (!lead) throw new HttpError(404, 'lead_not_found');
  const tz = lead.timezone || campaign.defaultTimezone || '';
  const effectiveLead = tz === lead.timezone ? lead : { ...lead, timezone: tz };
  return evaluateDialerEligibility(db, { campaign, lead: effectiveLead, now, cfg });
}

export { CONSENT_REQUIRED_BASES };
