-- Compliance profile + channel consent ledger for real outbound voice/AI calling.
-- These tables drive a fail-closed eligibility gate (see
-- src/services/dialerEligibility.js). They are configuration/declaration data only:
-- nothing here contacts a carrier, and no row can enable recording or live calling.
--
-- A campaign MUST have a `campaign_compliance` row before any real sales call is
-- eligible. Jurisdiction is operator-declared (`allowed_countries`); the lead's
-- country is never inferred from the phone number, and legal review is required
-- per market.
CREATE TABLE IF NOT EXISTS campaign_compliance (
  campaign_id          INTEGER PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
  business_name        TEXT NOT NULL DEFAULT '',
  legal_identity       TEXT NOT NULL DEFAULT '',
  consent_purpose      TEXT NOT NULL DEFAULT 'sales',
  consent_basis        TEXT NOT NULL DEFAULT 'none'
                       CHECK (consent_basis IN ('none','express_written','express_verbal','existing_customer')),
  ai_disclosure        TEXT NOT NULL DEFAULT '',
  recording_allowed    INTEGER NOT NULL DEFAULT 0,
  recording_disclosure TEXT NOT NULL DEFAULT '',
  allowed_countries    TEXT NOT NULL DEFAULT 'US',
  retention_days       INTEGER NOT NULL DEFAULT 30,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Persistent, purpose- and channel-scoped consent ledger. A consent record
-- authorizes exactly one (channel, purpose) pair for one normalized phone number;
-- presence of a lead in a CSV never implies consent.
CREATE TABLE IF NOT EXISTS dialer_consents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  phone         TEXT NOT NULL,
  channel       TEXT NOT NULL DEFAULT 'voice' CHECK (channel IN ('voice','sms')),
  purpose       TEXT NOT NULL DEFAULT 'sales',
  status        TEXT NOT NULL DEFAULT 'granted' CHECK (status IN ('granted','revoked')),
  evidence      TEXT NOT NULL DEFAULT '',
  source        TEXT NOT NULL DEFAULT '',
  business_name TEXT NOT NULL DEFAULT '',
  consented_at  TEXT,
  revoked_at    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (phone, channel, purpose)
);
CREATE INDEX IF NOT EXISTS idx_dialer_consents_phone ON dialer_consents(phone);
