-- IVR + simulated AI conversation records, and the persistent opt-out list.
-- These are written only by the campaign engine / engagement sandbox and are
-- never populated with data from a real carrier.
CREATE TABLE IF NOT EXISTS ivr_responses (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
  lead_id     INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  call_ref    TEXT NOT NULL DEFAULT '',
  menu_key    TEXT NOT NULL DEFAULT 'default',
  digit       TEXT NOT NULL DEFAULT '',
  is_valid    INTEGER NOT NULL DEFAULT 1,
  timed_out   INTEGER NOT NULL DEFAULT 0,
  route       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ivr_responses_lead ON ivr_responses(lead_id);

CREATE TABLE IF NOT EXISTS ai_transcripts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
  lead_id     INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  call_ref    TEXT NOT NULL DEFAULT '',
  role        TEXT NOT NULL CHECK (role IN ('ai','lead','system')),
  text        TEXT NOT NULL DEFAULT '',
  intent      TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_transcripts_lead ON ai_transcripts(lead_id);

-- Persistent opt-out. Enforced independently of the internal DNC list so a
-- request to stop is honored across every campaign and every future import.
CREATE TABLE IF NOT EXISTS opt_outs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  phone      TEXT NOT NULL UNIQUE,
  reason     TEXT NOT NULL DEFAULT '',
  source     TEXT NOT NULL DEFAULT 'ivr',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);