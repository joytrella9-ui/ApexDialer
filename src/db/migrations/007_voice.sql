-- Real-time AI voice dialer (Phase 0: simulated media/agent, offline). A voice
-- session represents one outbound call driven by the conversational agent. No
-- carrier and no external model are contacted by these tables; the only provider
-- available is the in-process "fake" adapter. Every transition is journaled in
-- voice_events (and mirrored onto the linked calls row) for an auditable timeline.
CREATE TABLE IF NOT EXISTS voice_sessions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id       INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
  lead_id           INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  call_id           INTEGER REFERENCES calls(id) ON DELETE SET NULL,
  provider          TEXT NOT NULL DEFAULT 'fake',
  provider_call_sid TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'starting'
                    CHECK (status IN ('starting','ringing','in_progress','ended','failed')),
  phase             TEXT NOT NULL DEFAULT 'greeting',
  disclosure_played INTEGER NOT NULL DEFAULT 0,
  turn_count        INTEGER NOT NULL DEFAULT 0,
  silence_count     INTEGER NOT NULL DEFAULT 0,
  invalid_count     INTEGER NOT NULL DEFAULT 0,
  outcome           TEXT NOT NULL DEFAULT '',
  disconnect_reason TEXT NOT NULL DEFAULT '',
  started_at        TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at          TEXT,
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_voice_sessions_campaign ON voice_sessions(campaign_id);
CREATE INDEX IF NOT EXISTS idx_voice_sessions_lead ON voice_sessions(lead_id);
CREATE INDEX IF NOT EXISTS idx_voice_sessions_call ON voice_sessions(call_id);
CREATE INDEX IF NOT EXISTS idx_voice_sessions_status ON voice_sessions(status);

-- One provider call id maps to exactly one session.
CREATE UNIQUE INDEX IF NOT EXISTS idx_voice_sessions_sid
  ON voice_sessions(provider_call_sid) WHERE provider_call_sid != '';

-- A single lead may have at most one live session, even across campaigns. This is
-- the backstop behind the claimNext() cross-campaign guard.
CREATE UNIQUE INDEX IF NOT EXISTS idx_voice_sessions_active_lead
  ON voice_sessions(lead_id)
  WHERE status IN ('starting','ringing','in_progress') AND lead_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS voice_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES voice_sessions(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  direction  TEXT NOT NULL DEFAULT 'system' CHECK (direction IN ('inbound','outbound','system')),
  payload    TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_voice_events_session ON voice_events(session_id);
