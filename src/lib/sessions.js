import { createHash, randomBytes } from 'node:crypto';

export function createSessionToken() {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function toIso(sqliteDatetime) {
  if (!sqliteDatetime) return null;
  const raw = String(sqliteDatetime);
  if (raw.includes('T') || raw.endsWith('Z')) return raw;
  const iso = raw.replace(' ', 'T');
  return iso.endsWith('Z') ? iso : `${iso}Z`;
}

export function createSession(db, userId, { ttlHours, token = createSessionToken() }) {
  db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();
  const expiresAt = db
    .prepare("SELECT datetime('now', ?) AS expires_at")
    .get(`+${ttlHours} hours`).expires_at;
  db.prepare('INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (?, ?, ?)').run(
    userId,
    hashToken(token),
    expiresAt
  );
  return { token, expiresAt: toIso(expiresAt) };
}

export function findSession(db, token) {
  if (typeof token !== 'string' || !token) return null;
  const row = db
    .prepare(
      `SELECT s.id, s.user_id, s.expires_at, s.last_seen_at,
              u.username, u.display_name, u.role
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > datetime('now') AND u.disabled_at IS NULL`
    )
    .get(hashToken(token));
  if (!row) return null;
  db.prepare('UPDATE sessions SET last_seen_at = datetime(\'now\') WHERE id = ?').run(row.id);
  return {
    id: row.id,
    userId: row.user_id,
    expiresAt: toIso(row.expires_at),
    user: { id: row.user_id, username: row.username, displayName: row.display_name, role: row.role },
  };
}

export function deleteSession(db, token) {
  if (typeof token !== 'string' || !token) return;
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

export function deleteUserSessions(db, userId, keepToken) {
  if (keepToken) {
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, hashToken(keepToken));
  } else {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }
}