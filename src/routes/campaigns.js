import { Router } from 'express';
import { HttpError } from '../lib/errors.js';
import * as campaigns from '../services/campaigns.js';
import { endActiveVoiceSessions } from '../services/voiceSessions.js';

function actor(req) {
  return req.auth?.user?.username ?? 'system';
}

function user(req) {
  return req.auth?.user ?? { username: 'system', id: null };
}

function parseId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'invalid_id');
  return id;
}

function parseLeadId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'invalid_id');
  return id;
}

export function campaignsRouter(db, cfg) {
  const router = Router();

  router.get('/', (req, res) => {
    const data = campaigns.listCampaigns(db);
    res.json({ data, count: data.length });
  });

  router.post('/', (req, res) => {
    const campaign = campaigns.createCampaign(db, user(req), req.body, cfg);
    res.status(201).json({ data: campaign });
  });

  router.post('/emergency-stop', (req, res) => {
    const result = campaigns.emergencyStopAll(db, actor(req));
    const voiceEnded = endActiveVoiceSessions(db, actor(req), cfg);
    res.json({ data: { ...result, voiceEnded: voiceEnded.ended } });
  });

  router.get('/:id', (req, res) => {
    const campaign = campaigns.getCampaign(db, parseId(req.params.id));
    if (!campaign) throw new HttpError(404, 'campaign_not_found');
    res.json({ data: campaign });
  });

  router.put('/:id', (req, res) => {
    const campaign = campaigns.updateCampaign(db, parseId(req.params.id), req.body, actor(req));
    res.json({ data: campaign });
  });

  router.post('/:id/start', (req, res) => {
    res.json({ data: campaigns.startCampaign(db, parseId(req.params.id), actor(req)) });
  });
  router.post('/:id/pause', (req, res) => {
    res.json({ data: campaigns.pauseCampaign(db, parseId(req.params.id), actor(req)) });
  });
  router.post('/:id/resume', (req, res) => {
    res.json({ data: campaigns.resumeCampaign(db, parseId(req.params.id), actor(req)) });
  });
  router.post('/:id/stop', (req, res) => {
    res.json({ data: campaigns.stopCampaign(db, parseId(req.params.id), actor(req)) });
  });

  router.post('/:id/queue', (req, res) => {
    const summary = campaigns.queueLeads(db, parseId(req.params.id), req.body ?? {}, actor(req));
    res.status(201).json({ data: summary });
  });

  router.post('/:id/tick', (req, res) => {
    const result = campaigns.claimNext(db, parseId(req.params.id), { username: actor(req), cfg });
    res.json({ data: result });
  });

  router.post('/:id/outcome', (req, res) => {
    const campaign = campaigns.recordOutcome(db, parseId(req.params.id), req.body ?? {}, actor(req), cfg);
    res.json({ data: campaign });
  });

  router.post('/:id/ivr', (req, res) => {
    const result = campaigns.handleIvr(db, parseId(req.params.id), req.body ?? {}, actor(req), cfg);
    res.json({ data: result });
  });

  router.post('/:id/ai', (req, res) => {
    const result = campaigns.handleAiTurn(db, parseId(req.params.id), req.body ?? {}, actor(req), cfg);
    res.json({ data: result });
  });

  router.get('/:id/leads/:leadId', (req, res) => {
    const lead = campaigns.getCampaignLeadForApi(db, parseId(req.params.id), parseLeadId(req.params.leadId));
    if (!lead) throw new HttpError(404, 'campaign_lead_not_found');
    res.json({ data: lead });
  });

  return router;
}
