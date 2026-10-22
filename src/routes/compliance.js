import { Router } from 'express';
import { HttpError } from '../lib/errors.js';
import { audit } from '../services/auth.js';
import {
  getComplianceProfile,
  upsertComplianceProfile,
  setConsent,
  revokeConsent,
  listConsents,
} from '../services/complianceProfile.js';
import { assessOutboundCall } from '../services/dialerEligibility.js';
import { planTranscriptRetention, executeTranscriptRetention } from '../services/transcriptRetention.js';
import { requireRole } from '../middleware/auth.js';

function actor(req) {
  return req.auth?.user?.username ?? 'system';
}

function parseId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'invalid_id');
  return id;
}

// Operator-facing configuration for the fail-closed dialer compliance gate:
// a campaign's declared compliance profile and the (phone, channel, purpose)
// consent ledger. Writing consent/profile here is an operator assertion; it does
// NOT verify anything with a carrier and NEVER enables live calling or recording.
export function complianceRouter(db, cfg) {
  const router = Router();

  router.get('/campaigns/:id', (req, res) => {
    const campaignId = parseId(req.params.id);
    res.json({ data: getComplianceProfile(db, campaignId) });
  });

  router.put('/campaigns/:id', (req, res) => {
    const campaignId = parseId(req.params.id);
    const profile = upsertComplianceProfile(db, campaignId, req.body ?? {}, actor(req), cfg);
    res.json({ data: profile });
  });

  // Preview the fail-closed decision for one campaign + lead without dialing.
  router.get('/campaigns/:id/eligibility', (req, res) => {
    const campaignId = parseId(req.params.id);
    const leadId = parseId(req.query.leadId);
    const at = req.query.at === undefined ? undefined : new Date(String(req.query.at));
    if (at && Number.isNaN(at.getTime())) throw new HttpError(400, 'invalid_at');
    const decision = assessOutboundCall(db, { campaignId, leadId, now: at, cfg });
    res.json({ data: decision });
  });

  // Transcript retention: GET is always a read-only dry run. POST deletes expired
  // transcript text only with the confirmation token, and optionally only when the
  // expired count still matches what the operator reviewed.
  router.get('/retention', requireRole('admin', 'supervisor'), (req, res) => {
    const { report } = planTranscriptRetention(db, { now: new Date() });
    res.json({ data: report });
  });

  // Destructive: administrators only. Operators and AI tools cannot reach this.
  router.post('/retention/execute', requireRole('admin'), (req, res) => {
    const body = req.body ?? {};
    const result = executeTranscriptRetention(db, {
      now: new Date(),
      confirm: body.confirm,
      expectedTotal: body.expectedTotal,
      username: actor(req),
    });
    res.json({ data: result });
  });

  router.post('/consent', (req, res) => {
    const consent = setConsent(db, req.body ?? {}, actor(req));
    res.status(201).json({ data: consent });
  });

  router.get('/consent', (req, res) => {
    const phone = typeof req.query.phone === 'string' ? req.query.phone.trim() : '';
    if (!phone) throw new HttpError(400, 'phone_required');
    res.json({ data: listConsents(db, phone) });
  });

  router.post('/consent/revoke', (req, res) => {
    const consent = revokeConsent(db, req.body ?? {}, actor(req));
    if (!consent) throw new HttpError(404, 'consent_not_found');
    res.json({ data: consent });
  });

  return router;
}
