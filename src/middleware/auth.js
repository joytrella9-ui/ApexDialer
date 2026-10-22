import { HttpError } from '../lib/errors.js';
import { findSession } from '../lib/sessions.js';
import { config } from '../config.js';

function readCookie(req) {
  return req.cookies?.[config.auth.cookieName] ?? null;
}

export function requireAuth(db) {
  return function authGuard(req, _res, next) {
    const token = readCookie(req);
    const session = findSession(db, token);
    if (!session) return next(new HttpError(401, 'authentication_required'));
    req.auth = session;
    next();
  };
}

// Authorization by role. Must run after requireAuth. Unknown or missing roles are
// denied (fail closed).
export function requireRole(...roles) {
  return function roleGuard(req, _res, next) {
    const role = req.auth?.user?.role;
    if (!role || !roles.includes(role)) return next(new HttpError(403, 'forbidden'));
    next();
  };
}

export function optionalAuth(db) {
  return function optionalAuthGuard(req, _res, next) {
    const token = readCookie(req);
    const session = findSession(db, token);
    if (session) req.auth = session;
    next();
  };
}

export { readCookie };