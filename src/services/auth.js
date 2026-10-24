import bcrypt from 'bcryptjs';
import { HttpError } from '../lib/errors.js';
import { setupSchema, loginSchema, changePasswordSchema, localRecoverySchema } from '../validate/auth.js';
import { createSession, deleteSession, deleteUserSessions } from '../lib/sessions.js';

function operatorFromRow(row) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    createdAt: row.created_at,
  };
}

export function audit(db, actor, action, entityType = '', entityId = '', details = '{}') {
  db.prepare(
    'INSERT INTO audit_log (actor, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)'
  ).run(actor, action, entityType, entityId ?? '', details ?? '{}');
}

export function operatorCount(db) {
  return db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
}

export function operatorExists(db) {
  return operatorCount(db) > 0;
}

export function firstOperatorUsername(db) {
  const row = db
    .prepare("SELECT username FROM users WHERE disabled_at IS NULL ORDER BY id LIMIT 1")
    .get();
  return row?.username ?? null;
}

export function getOperatorById(db, userId) {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  return row ? operatorFromRow(row) : null;
}

export function getOperatorByUsername(db, username) {
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  return row ? operatorFromRow(row) : null;
}

export function setupOperator(db, input, { bcryptRounds }) {
  const parsed = setupSchema.parse(input);
  const existing = operatorExists(db) || getOperatorByUsername(db, parsed.username);
  if (existing) throw new HttpError(409, 'operator_exists');

  const create = db.transaction(() => {
    const passwordHash = bcrypt.hashSync(parsed.password, bcryptRounds);
    const info = db
      .prepare(
        "INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, 'admin')"
      )
      .run(parsed.username, passwordHash, parsed.displayName);
    const id = Number(info.lastInsertRowid);
    audit(db, parsed.username, 'operator_created', 'user', String(id));
    return getOperatorById(db, id);
  });
  return create();
}

export function verifyCredentials(db, username, password, { bcryptRounds }) {
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username ?? '');
  const candidateHash = row?.password_hash ?? bcrypt.hashSync('dummy-password-not-real', bcryptRounds);
  // Compare first so the response time does not reveal whether the account is disabled.
  const passwordOk = bcrypt.compareSync(password ?? '', candidateHash);
  if (!passwordOk || !row || row.disabled_at != null) return null;
  return operatorFromRow(row);
}

export function login(db, input, opts) {
  const parsed = loginSchema.parse(input);
  const operator = verifyCredentials(db, parsed.username, parsed.password, {
    bcryptRounds: opts.bcryptRounds,
  });
  if (!operator) throw new HttpError(401, 'invalid_credentials');
  const session = createSession(db, operator.id, { ttlHours: opts.sessionTtlHours });
  audit(db, operator.username, 'login', 'user', String(operator.id));
  return { operator, session };
}

export function changeOperatorPassword(db, userId, input, { bcryptRounds }) {
  const parsed = changePasswordSchema.parse(input);
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!row || !bcrypt.compareSync(parsed.currentPassword, row.password_hash)) {
    throw new HttpError(401, 'invalid_credentials');
  }
  const passwordHash = bcrypt.hashSync(parsed.newPassword, bcryptRounds);
  db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?").run(
    passwordHash,
    userId
  );
  audit(db, row.username, 'password_changed', 'user', String(userId));
  return { username: row.username };
}

export function logout(db, token) {
  if (token) deleteSession(db, token);
}

export function registerAccount(db, input, opts) {
  const parsed = setupSchema.parse(input);
  if (getOperatorByUsername(db, parsed.username)) throw new HttpError(409, 'username_taken');
  const first = !operatorExists(db);
  const role = first ? 'admin' : 'operator';
  const passwordHash = bcrypt.hashSync(parsed.password, opts.bcryptRounds);
  const create = db.transaction(() => {
    const info = db
      .prepare(
        'INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)'
      )
      .run(parsed.username, passwordHash, parsed.displayName, role);
    const id = Number(info.lastInsertRowid);
    audit(db, parsed.username, first ? 'operator_created' : 'guest_registered', 'user', String(id), JSON.stringify({ role }));
    return getOperatorById(db, id);
  });
  const operator = create();
  const session = createSession(db, operator.id, { ttlHours: opts.sessionTtlHours });
  audit(db, operator.username, 'login', 'user', String(operator.id));
  return { operator, session };
}

export function localRecoverPassword(db, input, { bcryptRounds }) {
  const parsed = localRecoverySchema.parse(input);
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(parsed.username);
  if (!row || row.disabled_at != null) throw new HttpError(401, 'invalid_credentials');
  const passwordHash = bcrypt.hashSync(parsed.newPassword, bcryptRounds);
  db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?").run(
    passwordHash,
    row.id
  );
  deleteUserSessions(db, row.id, null);
  audit(db, row.username, 'password_local_recovery', 'user', String(row.id));
  return { username: row.username };
}