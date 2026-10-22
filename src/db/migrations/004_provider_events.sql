-- Provider webhook events (telephony sandbox). Every verified status callback
-- is recorded here so retries from the provider are idempotent and the call
-- timeline keeps a durable audit trail. Not related to call_events; this table
-- is written only by the provider webhook path.
CREATE TABLE IF NOT EXISTS provider_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  provider   TEXT    NOT NULL,
  event_id   TEXT    NOT NULL DEFAULT '',
  call_id    INTEGER REFERENCES calls(id) ON DELETE CASCADE,
  event_type TEXT    NOT NULL DEFAULT '',
  event_data TEXT    NOT NULL DEFAULT '',
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (provider, event_id)
);

CREATE INDEX IF NOT EXISTS idx_provider_events_call ON provider_events(call_id);