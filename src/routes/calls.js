import { Router } from 'express';
import { HttpError } from '../lib/errors.js';
import * as calls from '../services/calls.js';

function parseId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'invalid_id');
  return id;
}

function parseExclude(value) {
  if (value === undefined) return [];
  const raw = Array.isArray(value) ? value.join(',') : String(value);
  return raw
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

export function callsRouter(db, cfg) {
  const router = Router();
  const window = () => ({
    start: cfg.compliance.callWindowStart,
    end: cfg.compliance.callWindowEnd,
  });
  const opts = () => ({
    window: window(),
    maxAttemptMinutes: cfg.calls.maxAttemptMinutes,
    dialing: {
      demoMode: cfg.demoMode,
      provider: cfg.voice.provider,
      liveEnabled: cfg.voice.liveEnabled === true || cfg.telephony.liveEnabled === true,
    },
    cfg,
    fetchImpl: cfg.telephony?.fetchImpl,
  });

  router.get('/', (req, res) => {
    const limit = req.query.limit !== undefined ? Number(req.query.limit) : undefined;
    const data = calls.listCalls(db, req.auth.userId, { limit });
    res.json({ data, count: data.length });
  });

  router.get('/active', (req, res) => {
    res.json({ data: calls.getActiveContext(db, req.auth.userId, opts()) });
  });

  router.get('/next', (req, res) => {
    const data = calls.nextEligibleLead(db, {
      exclude: parseExclude(req.query.exclude),
      window: window(),
    });
    res.json({ data });
  });

  router.post('/attempt', async (req, res) => {
    const data = await calls.startAttempt(db, req.auth.userId, req.auth.user.username, req.body, opts());
    res.status(201).json({ data });
  });

  router.post('/skip', (req, res) => {
    const data = calls.skipLead(db, req.auth.userId, req.auth.user.username, req.body, {
      window: window(),
    });
    res.json({ data });
  });

  router.get('/:id', (req, res) => {
    const call = calls.getCall(db, parseId(req.params.id));
    if (!call || call.userId !== req.auth.userId) throw new HttpError(404, 'call_not_found');
    res.json({ data: call });
  });

  router.post('/:id/pause', (req, res) => {
    const data = calls.pauseAttempt(db, req.auth.userId, req.auth.user.username, parseId(req.params.id));
    res.json({ data });
  });

  router.post('/:id/resume', (req, res) => {
    const data = calls.resumeAttempt(db, req.auth.userId, req.auth.user.username, parseId(req.params.id));
    res.json({ data });
  });

  router.post('/:id/end', async (req, res) => {
    const data = await calls.endAttempt(
      db,
      req.auth.userId,
      req.auth.user.username,
      parseId(req.params.id),
      req.body,
      opts()
    );
    res.json({ data });
  });

  router.post('/:id/abort', async (req, res) => {
    const data = await calls.abortAttempt(
      db,
      req.auth.userId,
      req.auth.user.username,
      parseId(req.params.id),
      req.body,
      opts()
    );
    res.json({ data });
  });

  return router;
}
