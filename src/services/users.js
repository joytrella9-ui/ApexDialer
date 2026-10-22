import bcrypt from 'bcryptjs';
import { HttpError } from '../lib/errors.js';
import { deleteUserSessions } from '../lib/sessions.js';
import { audit } from './auth.js';
import { createUserSchema, updateUserSchema } from '../validate/users.js';

function toUser(row) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    disabled: row.disabled_at != null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listUsers(db) {
  return db
    .prepare('SELECT * FROM users ORDER BY id')
    .all()
    .map(toUser);
}

export function getUser(db, id) {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!row) throw new HttpError(404, 'user_not_found');
  return toUser(row);
}

export function createUser(db, actor, input, { bcryptRounds }) {
  const parsed = createUserSchema.parse(input);
  const taken = db.prepare('SELECT 1 FROM users WHERE username = ?').get(parsed.username);
  if (taken) throw new HttpError(409, 'username_taken');

  const create = db.transaction(() => {
    const info = db
      .prepare('INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)')
      .run(
        parsed.username,
        bcrypt.hashSync(parsed.password, bcryptRounds),
        parsed.displayName,
        parsed.role
      );
    const id = Number(info.lastInsertRowid);
    audit(db, actor, 'user_created', 'user', String(id), JSON.stringify({ role: parsed.role }));
    return getUser(db, id);
  });
  return create();
}

// Changes a user's role and/or disabled state. Guards:
//   - nobody can change their own role or disable themselves (prevents lock-out by accident)
//   - the system must always keep at least one enabled admin
//   - disabling a user ends all of their sessions immediately
export function updateUser(db, actor, { targetId, actorId }, input) {
  const parsed = updateUserSchema.parse(input);
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  if (!target) throw new HttpError(404, 'user_not_found');

  const self = targetId === actorId;
  const roleChanges = parsed.role !== undefined && parsed.role !== target.role;
  const disableChanges = parsed.disabled !== undefined && (parsed.disabled === true) !== (target.disabled_at != null);
  if (self && (roleChanges || parsed.disabled === true)) {
    throw new HttpError(409, 'cannot_modify_self');
  }

  const nextRole = parsed.role ?? target.role;
  const nextDisabled = parsed.disabled ?? target.disabled_at != null;
  const losesAdmin = target.role === 'admin' && (nextRole !== 'admin' || nextDisabled);
  if (losesAdmin) {
    const otherActiveAdmins = db
      .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled_at IS NULL AND id != ?")
      .get(targetId).n;
    if (otherActiveAdmins === 0) throw new HttpError(409, 'last_admin');
  }

  if (!roleChanges && !disableChanges) return getUser(db, targetId);

  const apply = db.transaction(() => {
    if (roleChanges) {
      db.prepare("UPDATE users SET role = ?, updated_at = datetime('now') WHERE id = ?").run(nextRole, targetId);
      audit(db, actor, 'user_role_changed', 'user', String(targetId), JSON.stringify({ from: target.role, to: nextRole }));
    }
    if (disableChanges) {
      db.prepare(
        "UPDATE users SET disabled_at = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(nextDisabled ? new Date().toISOString() : null, targetId);
      if (nextDisabled) deleteUserSessions(db, targetId, null);
      audit(db, actor, nextDisabled ? 'user_disabled' : 'user_enabled', 'user', String(targetId));
    }
  });
  apply();
  return getUser(db, targetId);
}
