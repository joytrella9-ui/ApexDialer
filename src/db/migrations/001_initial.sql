CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  role          TEXT    NOT NULL DEFAULT 'operator' CHECK (role IN ('admin','supervisor','operator')),
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  display_name  TEXT    NOT NULL DEFAULT '',
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE leads (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT    NOT NULL,
  phone             TEXT    NOT NULL,
  company           TEXT    NOT NULL DEFAULT '',
  call_type         TEXT    NOT NULL DEFAULT 'sales' CHECK (call_type IN ('sales','existing-customer')),
  timezone          TEXT    NOT NULL DEFAULT '',
  consent_status    TEXT    NOT NULL DEFAULT 'none' CHECK (consent_status IN ('none','recorded','revoked')),
  consent_evidence  TEXT    NOT NULL DEFAULT '',
  consent_source    TEXT    NOT NULL DEFAULT '',
  consent_date      TEXT    NOT NULL DEFAULT '',
  status            TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','dnc','blocked')),
  disposition       TEXT    NOT NULL DEFAULT '',
  notes             TEXT    NOT NULL DEFAULT '',
  suppression_blocked INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_leads_status    ON leads(status);
CREATE INDEX idx_leads_call_type ON leads(call_type);
CREATE INDEX idx_leads_phone     ON leads(phone);
CREATE INDEX idx_leads_name      ON leads(name);

CREATE TABLE consent_records (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id       INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  consent_type  TEXT    NOT NULL CHECK (consent_type IN ('marketing','existing-customer')),
  evidence      TEXT    NOT NULL DEFAULT '',
  source        TEXT    NOT NULL DEFAULT '',
  date          TEXT    NOT NULL DEFAULT '',
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_consent_lead ON consent_records(lead_id);

CREATE TABLE dnc_entries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  phone      TEXT    NOT NULL UNIQUE,
  source     TEXT    NOT NULL DEFAULT 'internal',
  list_name  TEXT    NOT NULL DEFAULT '',
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE calls (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id           INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  user_id           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  direction         TEXT    NOT NULL DEFAULT 'outbound' CHECK (direction IN ('outbound','inbound')),
  status            TEXT    NOT NULL DEFAULT 'queued',
  call_type         TEXT    NOT NULL DEFAULT 'sales',
  disposition       TEXT    NOT NULL DEFAULT '',
  started_at        TEXT,
  ended_at          TEXT,
  duration_seconds  INTEGER NOT NULL DEFAULT 0,
  provider_call_sid TEXT    NOT NULL DEFAULT '',
  recording_uri     TEXT    NOT NULL DEFAULT '',
  notes             TEXT    NOT NULL DEFAULT '',
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_calls_lead   ON calls(lead_id);
CREATE INDEX idx_calls_status ON calls(status);

CREATE TABLE call_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id    INTEGER NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  event_type TEXT    NOT NULL,
  event_data TEXT    NOT NULL DEFAULT '',
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_call_events_call ON call_events(call_id);

CREATE TABLE audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  actor        TEXT NOT NULL DEFAULT 'system',
  action       TEXT NOT NULL,
  entity_type  TEXT NOT NULL DEFAULT '',
  entity_id    TEXT NOT NULL DEFAULT '',
  details      TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_audit_created ON audit_log(created_at);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);