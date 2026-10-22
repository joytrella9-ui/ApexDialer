-- AI-powered outbound campaigns (simulated engine). A campaign owns its calling
-- policy and a queue of leads; no carrier is contacted by these tables. Every
-- status change is journaled in campaign_events for an auditable timeline.
CREATE TABLE IF NOT EXISTS campaigns (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','running','paused','stopped','completed')),
  created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  call_window_start   TEXT NOT NULL DEFAULT '08:00',
  call_window_end     TEXT NOT NULL DEFAULT '21:00',
  default_timezone    TEXT NOT NULL DEFAULT '',
  max_attempts        INTEGER NOT NULL DEFAULT 3,
  retry_delay_minutes INTEGER NOT NULL DEFAULT 60,
  concurrency_limit   INTEGER NOT NULL DEFAULT 1,
  pacing_per_minute   INTEGER NOT NULL DEFAULT 30,
  ivr_enabled         INTEGER NOT NULL DEFAULT 1,
  ai_enabled          INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS campaign_leads (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id     INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  lead_id         INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','dialing','connected','completed',
                                    'failed','busy','unanswered','callback','opted_out','dnc')),
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_attempt_at TEXT,
  last_outcome    TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (campaign_id, lead_id)
);
CREATE INDEX IF NOT EXISTS idx_campaign_leads_campaign ON campaign_leads(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_leads_status ON campaign_leads(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS campaign_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  lead_id     INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  event_type  TEXT NOT NULL,
  event_data  TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_campaign_events_campaign ON campaign_events(campaign_id);