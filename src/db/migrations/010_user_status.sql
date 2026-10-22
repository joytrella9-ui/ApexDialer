-- Users can be disabled without being deleted. A disabled user cannot sign in and
-- any existing session stops resolving (see services/auth.js and lib/sessions.js).
ALTER TABLE users ADD COLUMN disabled_at TEXT;
