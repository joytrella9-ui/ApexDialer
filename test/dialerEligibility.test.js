import test from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/db/db.js';
import { upsertComplianceProfile, setConsent, revokeConsent } from '../src/services/complianceProfile.js';
import { assessOutboundCall } from '../src/services/dialerEligibility.js';

function zoneForLocalHour(hour) {
  const utcHour = new Date().getUTCHours();
  let offset = hour - utcHour;
  if (offset > 14) offset -= 24;
  if (offset < -12) offset += 24;
  return offset >= 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
}

const PROFILE = {
  businessName: 'Acme',
  legalIdentity: 'Acme LLC',
  consentPurpose: 'sales',
  consentBasis: 'express_written',
  aiDisclosure: 'This call is handled by an automated assistant.',
  allowedCountries: ['US'],
  retentionDays: 30,
};

function seed(db, { tz = zoneForLocalHour(12), callType = 'sales' } = {}) {
  db.prepare(
    `INSERT INTO leads (name, phone, call_type, timezone, consent_status, consent_evidence, consent_source, consent_date, status)
     VALUES ('Test Lead', '+15550123456', ?, ?, 'recorded', 'signed form', 'web-form', '2026-01-01', 'pending')`
  ).run(callType, tz);
  const leadId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  db.prepare("INSERT INTO campaigns (name, status) VALUES ('Campaign', 'running')").run();
  const campaignId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  return { leadId, campaignId };
}

function grantedConsent(db) {
  setConsent(db, {
    phone: '+15550123456',
    channel: 'voice',
    purpose: 'sales',
    status: 'granted',
    evidence: 'signed form 2026-01-01',
    source: 'web-form',
    businessName: 'Acme',
    consentedAt: '2026-01-01T00:00:00Z',
  });
}

function codes(result) {
  return result.reasons.map((r) => r.code);
}

test('a campaign with no compliance profile is blocked (fail closed)', () => {
  const db = createDb(':memory:');
  try {
    const { campaignId, leadId } = seed(db);
    const result = assessOutboundCall(db, { campaignId, leadId });
    assert.equal(result.decision, 'blocked');
    assert.equal(result.eligible, false);
    assert.ok(codes(result).includes('compliance_profile_missing'));
    assert.equal(result.recording.allowed, false);
  } finally {
    db.close();
  }
});

test('a profile without a granted consent record blocks the call', () => {
  const db = createDb(':memory:');
  try {
    const { campaignId, leadId } = seed(db);
    upsertComplianceProfile(db, campaignId, PROFILE);
    const result = assessOutboundCall(db, { campaignId, leadId });
    assert.equal(result.decision, 'blocked');
    assert.ok(codes(result).includes('consent_missing'));
  } finally {
    db.close();
  }
});

test('revoked consent and incomplete consent evidence both block', () => {
  const db = createDb(':memory:');
  try {
    const { campaignId, leadId } = seed(db);
    upsertComplianceProfile(db, campaignId, PROFILE);
    grantedConsent(db);
    revokeConsent(db, { phone: '+15550123456', channel: 'voice', purpose: 'sales' });
    assert.ok(codes(assessOutboundCall(db, { campaignId, leadId })).includes('consent_missing'));

    // Regrant but with no evidence -> incomplete.
    setConsent(db, {
      phone: '+15550123456',
      channel: 'voice',
      purpose: 'sales',
      status: 'granted',
      source: 'web-form',
      businessName: 'Acme',
      consentedAt: '2026-01-01T00:00:00Z',
    });
    assert.ok(codes(assessOutboundCall(db, { campaignId, leadId })).includes('consent_incomplete'));
  } finally {
    db.close();
  }
});

test('a fully configured campaign with granted consent is eligible, but recording stays off', () => {
  const db = createDb(':memory:');
  try {
    const { campaignId, leadId } = seed(db);
    upsertComplianceProfile(db, campaignId, PROFILE);
    grantedConsent(db);
    const result = assessOutboundCall(db, { campaignId, leadId });
    assert.equal(result.decision, 'allowed', JSON.stringify(result.reasons));
    assert.equal(result.eligible, true);
    assert.ok(codes(result).includes('consent_verified'));
    assert.ok(codes(result).includes('jurisdiction_declared'));
    assert.equal(result.recording.allowed, false);
    assert.equal(result.recording.reason, 'recording_disabled_by_default');
    assert.equal(result.retentionDays, 30);
    assert.equal(result.jurisdiction.inferred, false);
    assert.equal(result.jurisdiction.leadCountry, null);
  } finally {
    db.close();
  }
});

test('internal DNC and an outside calling window both block a would-be-valid call', () => {
  const db = createDb(':memory:');
  try {
    const { campaignId, leadId } = seed(db);
    upsertComplianceProfile(db, campaignId, PROFILE);
    grantedConsent(db);
    db.prepare("INSERT INTO dnc_entries (phone, source, list_name, active) VALUES ('+15550123456', 'internal', 'Test', 1)").run();
    assert.ok(codes(assessOutboundCall(db, { campaignId, leadId })).includes('internal_dnc'));
  } finally {
    db.close();
  }

  const db2 = createDb(':memory:');
  try {
    const { campaignId, leadId } = seed(db2, { tz: zoneForLocalHour(3) });
    upsertComplianceProfile(db2, campaignId, PROFILE);
    grantedConsent(db2);
    const result = assessOutboundCall(db2, { campaignId, leadId });
    assert.equal(result.decision, 'blocked');
    assert.ok(codes(result).includes('outside_calling_window'));
  } finally {
    db2.close();
  }
});

test('an existing-customer basis is allowed without a marketing consent record', () => {
  const db = createDb(':memory:');
  try {
    const { campaignId, leadId } = seed(db, { callType: 'existing-customer' });
    upsertComplianceProfile(db, campaignId, { ...PROFILE, consentBasis: 'existing_customer' });
    const result = assessOutboundCall(db, { campaignId, leadId });
    assert.equal(result.decision, 'allowed', JSON.stringify(result.reasons));
    assert.ok(codes(result).includes('consent_existing_customer'));
  } finally {
    db.close();
  }
});

test('an empty jurisdiction allowlist blocks pending legal review', () => {
  const db = createDb(':memory:');
  try {
    const { campaignId, leadId } = seed(db);
    upsertComplianceProfile(db, campaignId, { ...PROFILE, allowedCountries: [] });
    grantedConsent(db);
    const result = assessOutboundCall(db, { campaignId, leadId });
    assert.equal(result.decision, 'blocked');
    assert.ok(codes(result).includes('missing_jurisdiction'));
  } finally {
    db.close();
  }
});

test('a consent record for a different purpose does not authorize the call', () => {
  const db = createDb(':memory:');
  try {
    const { campaignId, leadId } = seed(db);
    upsertComplianceProfile(db, campaignId, PROFILE);
    // Grant consent only for a different purpose.
    setConsent(db, {
      phone: '+15550123456',
      channel: 'voice',
      purpose: 'support',
      status: 'granted',
      evidence: 'x',
      source: 'y',
      businessName: 'Acme',
      consentedAt: '2026-01-01',
    });
    assert.ok(codes(assessOutboundCall(db, { campaignId, leadId })).includes('consent_missing'));
  } finally {
    db.close();
  }
});

test('assessOutboundCall requires real campaign and lead rows', () => {
  const db = createDb(':memory:');
  try {
    assert.throws(() => assessOutboundCall(db, { campaignId: 999, leadId: 1 }), (err) => err.status === 404);
    const { campaignId } = seed(db);
    assert.throws(() => assessOutboundCall(db, { campaignId, leadId: 999 }), (err) => err.status === 404);
  } finally {
    db.close();
  }
});
