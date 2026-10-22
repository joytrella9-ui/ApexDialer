import { Router } from 'express';
import { HttpError } from '../lib/errors.js';
import { createRateLimiter } from '../lib/rateLimit.js';
import { readCookie, requireAuth, optionalAuth } from '../middleware/auth.js';
import { deleteUserSessions } from '../lib/sessions.js';
import * as auth from '../services/auth.js';

export function authRouter(db, cfg) {
  const router = Router();

  const loginPerIp = createRateLimiter({
    windowMs: cfg.auth.loginWindowMs,
    max: cfg.auth.loginMaxPerIp,
  });
  const loginFailures = createRateLimiter({
    windowMs: cfg.auth.loginWindowMs,
    max: cfg.auth.loginFailureMax,
  });
  const setupLimiter = createRateLimiter({
    windowMs: cfg.auth.setupWindowMs,
    max: cfg.auth.setupMax,
  });
  const passwordLimiter = createRateLimiter({
    windowMs: cfg.auth.loginWindowMs,
    max: cfg.auth.loginFailureMax,
  });

  router.get('/config', (req, res) => {
    res.json({
      setupRequired: !auth.operatorExists(db),
      sessionTtlHours: cfg.auth.sessionTtlHours,
      cookieSecure: cfg.auth.cookieSecure,
    });
  });

  router.post('/setup', (req, res) => {
    const attempt = setupLimiter.check(`setup:${req.ip}`);
    if (!attempt.allowed) {
      res.setHeader('Retry-After', String(attempt.retryAfterSeconds));
      throw new HttpError(429, 'too_many_attempts');
    }
    const operator = auth.setupOperator(db, req.body, { bcryptRounds: cfg.auth.bcryptRounds });
    setupLimiter.reset(`setup:${req.ip}`);
    res
      .status(201)
      .json({ data: { operator, message: 'Operator account created. Log in with /api/auth/login.' } });
  });

  router.post('/login', (req, res) => {
    const ip = req.ip;
    const attempt = loginPerIp.check(`login:ip:${ip}`);
    if (!attempt.allowed) {
      res.setHeader('Retry-After', String(attempt.retryAfterSeconds));
      throw new HttpError(429, 'too_many_attempts');
    }

    let result;
    try {
      result = auth.login(db, req.body, {
        bcryptRounds: cfg.auth.bcryptRounds,
        sessionTtlHours: cfg.auth.sessionTtlHours,
      });
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) {
        const username = req.body?.username ?? 'unknown';
        const failure = loginFailures.check(`login:user:${ip}:${username}`);
        if (!failure.allowed) {
          res.setHeader('Retry-After', String(failure.retryAfterSeconds));
          throw new HttpError(429, 'too_many_attempts');
        }
        auth.audit(db, username, 'login_failed', 'user', String(username));
      }
      throw err;
    }

    loginFailures.reset(`login:user:${ip}:${result.operator.username}`);
    const maxAgeMs = cfg.auth.sessionTtlHours * 3600 * 1000;
    res.cookie(cfg.auth.cookieName, result.session.token, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      maxAge: maxAgeMs,
      secure: cfg.auth.cookieSecure,
    });
    res.json({ data: { operator: result.operator, expiresAt: result.session.expiresAt } });
  });

  router.post('/logout', optionalAuth(db), (req, res) => {
    auth.logout(db, readCookie(req));
    res.clearCookie(cfg.auth.cookieName, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      secure: cfg.auth.cookieSecure,
    });
    res.status(204).end();
  });

  router.get('/me', requireAuth(db), (req, res) => {
    res.json({ data: { operator: req.auth.user, expiresAt: req.auth.expiresAt } });
  });

  router.put('/password', requireAuth(db), (req, res) => {
    const currentToken = readCookie(req);
    const attempt = passwordLimiter.check(`password:${req.ip}`);
    if (!attempt.allowed) {
      res.setHeader('Retry-After', String(attempt.retryAfterSeconds));
      throw new HttpError(429, 'too_many_attempts');
    }
    auth.changeOperatorPassword(db, req.auth.userId, req.body, {
      bcryptRounds: cfg.auth.bcryptRounds,
    });
    passwordLimiter.reset(`password:${req.ip}`);
    deleteUserSessions(db, req.auth.userId, currentToken);
    res.json({ data: { changed: true } });
  });

  return router;
}