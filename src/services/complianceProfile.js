import { audit } from './auth.js';
import { HttpError } from '../lib/errors.js';
import { phoneKey } from './leads.js';
import { getCampaign } from './campaigns.js';
import {
  complianceProfileSchema,
  consentRecordSchema,
  revokeConsentSchema,
} from '../validate/compliance.js';

function toProfile(row) {
  if (!row) return null;
  return {
    campaignId: row.campaign_id,
    businessName: row.business_name,
    legalIdentity: row.legal_identity,
    consentPurpose: row.consent_purpose,
    consentBasis: row.consent_basis,
    aiDisclosure: row.ai_disclosure,
    recordingAllowed: row.recording_allowed === 1,
    recordingDisclosure: row.recording_disclosure,
    allowedCountries: String(row.allowed_countries ?? '')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean),
    retentionDays: row.retention_days,
    updatedAt: row.updated_at,
  };
}

function toConsent(row) {
  if (!row) return null;
  return {
    id: row.id,
    phone: row.phone,
    channel: row.channel,
    purpose: row.purpose,
    status: row.status,
    evidence: row.evidence,
    source: row.source,
    businessName: row.business_name,
    consentedAt: row.consented_at ?? '',
    revokedAt: row.revoked_at ?? '',
    updatedAt: row.updated_at,
  };
}

export function getComplianceProfile(db, campaignId) {
  const row = db.prepare('SELECT * FROM campaign_compliance WHERE campaign_id = ?').get(campaignId);
  return toProfile(row);
}

export function upsertComplianceProfile(db, campaignId, input, username = 'system', cfg = {}) {
  const campaign = getCampaign(db, campaignId);
  if (!campaign) throw new HttpError(404, 'campaign_not_found');
  const parsed = complianceProfileSchema.parse(input);
  const retention = parsed.retentionDays ?? cfg?.compliance?.transcriptRetentionDays ?? 30;
  db.prepare(
    `INSERT INTO campaign_compliance
       (campaign_id, business_name, legal_identity, consent_purpose, consent_basis,
        ai_disclosure, recording_allowed, recording_disclosure, allowed_countries, retention_days)
     VALUES (@campaign_id, @business_name, @legal_identity, @purpose, @basis,
             @disclosure, @recording, @recording_disclosure, @countries, @retention)
     ON CONFLICT(campaign_id) DO UPDATE SET
       business_name = @business_name,
       legal_identity = @legal_identity,
       consent_purpose = @purpose,
       consent_basis = @basis,
       ai_disclosure = @disclosure,
       recording_allowed = @recording,
       recording_disclosure = @recording_disclosure,
       allowed_countries = @countries,
       retention_days = @retention,
       updated_at = datetime('now')`
  ).run({
    campaign_id: campaignId,
    business_name: parsed.businessName,
    legal_identity: parsed.legalIdentity,
    purpose: parsed.consentPurpose,
    basis: parsed.consentBasis,
    disclosure: parsed.aiDisclosure,
    // Recording can never be turned on here; the column is retained for the
    // future, explicitly code-reviewed enablement path only.
    recording: 0,
    recording_disclosure: parsed.recordingDisclosure ?? '',
    countries: parsed.allowedCountries.join(','),
    retention,
  });
  audit(db, username, 'compliance_profile_updated', 'campaign', String(campaignId), JSON.stringify({
    consentBasis: parsed.consentBasis,
    allowedCountries: parsed.allowedCountries,
  }));
  return getComplianceProfile(db, campaignId);
}

export function setConsent(db, input, username = 'system') {
  const parsed = consentRecordSchema.parse(input);
  const key = phoneKey(parsed.phone);
  if (!key) throw new HttpError(400, 'invalid_phone');
  db.prepare(
    `INSERT INTO dialer_consents
       (phone, channel, purpose, status, evidence, source, business_name, consented_at, revoked_at)
     VALUES (@phone, @channel, @purpose, @status, @evidence, @source, @business, @consented, @revoked)
     ON CONFLICT(phone, channel, purpose) DO UPDATE SET
       status = @status,
       evidence = @evidence,
       source = @source,
       business_name = @business,
       consented_at = @consented,
       revoked_at = @revoked,
       updated_at = datetime('now')`
  ).run({
    phone: key,
    channel: parsed.channel,
    purpose: parsed.purpose,
    status: parsed.status,
    evidence: parsed.evidence,
    source: parsed.source,
    business: parsed.businessName,
    consented: parsed.consentedAt || (parsed.status === 'granted' ? new Date().toISOString() : ''),
    revoked: parsed.status === 'revoked' ? new Date().toISOString() : '',
  });
  audit(db, username, 'consent_recorded', 'consent', key, JSON.stringify({ channel: parsed.channel, purpose: parsed.purpose, status: parsed.status }));
  return getConsent(db, parsed.phone, { channel: parsed.channel, purpose: parsed.purpose });
}

export function revokeConsent(db, input, username = 'system') {
  const parsed = revokeConsentSchema.parse(input);
  const key = phoneKey(parsed.phone);
  const row = db
    .prepare('SELECT id FROM dialer_consents WHERE phone = ? AND channel = ? AND purpose = ?')
    .get(key, parsed.channel, parsed.purpose);
  if (!row) return null;
  db.prepare(
    "UPDATE dialer_consents SET status = 'revoked', revoked_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
  ).run(row.id);
  audit(db, username, 'consent_revoked', 'consent', key, JSON.stringify({ channel: parsed.channel, purpose: parsed.purpose }));
  return getConsent(db, parsed.phone, { channel: parsed.channel, purpose: parsed.purpose });
}

export function getConsent(db, phone, { channel = 'voice', purpose = 'sales' } = {}) {
  const key = phoneKey(phone);
  if (!key) return null;
  const row = db
    .prepare('SELECT * FROM dialer_consents WHERE phone = ? AND channel = ? AND purpose = ?')
    .get(key, channel, purpose);
  return toConsent(row);
}

export function listConsents(db, phone) {
  const key = phoneKey(phone);
  if (!key) return [];
  return db
    .prepare('SELECT * FROM dialer_consents WHERE phone = ? ORDER BY id')
    .all(key)
    .map(toConsent);
}

export { toProfile, toConsent };
