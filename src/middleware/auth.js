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

export function optionalAuth(db) {
  return function optionalAuthGuard(req, _res, next) {
    const token = readCookie(req);
    const session = findSession(db, token);
    if (session) req.auth = session;
    next();
  };
}

export { readCookie };