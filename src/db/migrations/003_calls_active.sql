-- Power dialer: enforce at most one live attempt per operator.
-- A partial unique index means the database itself refuses a second
-- in_progress/paused call for the same user, even if application checks race.
CREATE UNIQUE INDEX IF NOT EXISTS idx_calls_one_active
  ON calls(user_id)
  WHERE status IN ('in_progress', 'paused');

CREATE INDEX IF NOT EXISTS idx_calls_user ON calls(user_id);
