-- Indexes for reports, audit browsing, and operator-scoped call lists.
CREATE INDEX IF NOT EXISTS idx_calls_user_id ON calls(user_id);
CREATE INDEX IF NOT EXISTS idx_calls_created ON calls(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
