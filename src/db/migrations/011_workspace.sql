-- Workspace telephony settings. Secrets are stored encrypted (see src/lib/secrets.js)
-- and never returned by the API. Non-secret flags live in the existing settings table
-- or here as plaintext configuration the operator typed (E.164 numbers, public URL).
CREATE TABLE IF NOT EXISTS workspace_secrets (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS workspace_config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
