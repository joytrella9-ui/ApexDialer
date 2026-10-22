import { Router } from 'express';
import { HttpError } from '../lib/errors.js';
import * as leads from '../services/leads.js';
import * as calls from '../services/calls.js';
import { audit } from '../services/auth.js';
import { importLeads, previewLeads, leadsToCsv } from '../services/csv.js';
import { evaluateLeadById } from '../services/compliance.js';

function actor(req) {
  return req.auth?.user?.username ?? 'system';
}

function parseId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new HttpError(400, 'invalid_id');
  }
  return id;
}

function parseAt(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new HttpError(400, 'invalid_at');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new HttpError(400, 'invalid_at');
  return date;
}

function boolParam(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

export function leadsRouter(db) {
  const router = Router();

  router.get('/', (req, res) => {
    const filters = {
      q: typeof req.query.q === 'string' ? req.query.q.trim() : undefined,
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
      callType: typeof req.query.callType === 'string' ? req.query.callType : undefined,
      eligible: boolParam(req.query.eligible),
    };
    const all = leads.listLeads(db, filters);
    const total = all.length;
    const offset = req.query.offset !== undefined ? Math.max(Number(req.query.offset) || 0, 0) : 0;
    const limitRaw = req.query.limit !== undefined ? Number(req.query.limit) : undefined;
    const limit = limitRaw !== undefined ? Math.min(Math.max(limitRaw || 50, 1), 500) : undefined;
    const data = limit !== undefined ? all.slice(offset, offset + limit) : all;
    res.json({ data, count: data.length, total, limit: limit ?? total, offset });
  });

  router.get('/export', (req, res) => {
    const data = leads.listLeads(db, {
      q: typeof req.query.q === 'string' ? req.query.q.trim() : undefined,
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
      callType: typeof req.query.callType === 'string' ? req.query.callType : undefined,
      eligible: boolParam(req.query.eligible),
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="apexdialer-leads.csv"');
    res.send(leadsToCsv(data));
  });

  router.post('/import/preview', (req, res) => {
    const csv = typeof req.body === 'string' ? req.body : req.body?.csv;
    if (typeof csv !== 'string' || csv.trim() === '') {
      throw new HttpError(400, 'missing_csv');
    }
    res.json({ data: previewLeads(db, csv) });
  });

  router.post('/import', (req, res) => {
    const csv = typeof req.body === 'string' ? req.body : req.body?.csv;
    if (typeof csv !== 'string' || csv.trim() === '') {
      throw new HttpError(400, 'missing_csv');
    }
    const summary = importLeads(db, csv);
    audit(db, actor(req), 'leads_imported', 'lead', '', JSON.stringify({
      imported: summary.imported,
      rejected: summary.rejected,
      skipped: summary.skipped,
    }));
    res.status(201).json({ data: summary });
  });

  router.post('/reset-queue', (req, res) => {
    const summary = leads.resetQueue(db, { username: req.auth?.user?.username });
    res.json({ data: summary });
  });

  router.get('/:id/calls', (req, res) => {
    const id = parseId(req.params.id);
    if (!leads.getLead(db, id)) throw new HttpError(404, 'lead_not_found');
    const data = calls.listCallsForLead(db, id);
    res.json({ data, count: data.length });
  });

  router.get('/:id/compliance', (req, res) => {
    const decision = evaluateLeadById(db, parseId(req.params.id), { now: parseAt(req.query.at) });
    if (!decision) throw new HttpError(404, 'lead_not_found');
    res.json({ data: decision });
  });

  router.get('/:id', (req, res) => {
    const lead = leads.getLead(db, parseId(req.params.id));
    if (!lead) throw new HttpError(404, 'lead_not_found');
    res.json({ data: lead });
  });

  router.post('/', (req, res) => {
    const lead = leads.createLead(db, req.body);
    audit(db, actor(req), 'lead_created', 'lead', String(lead.id));
    res.status(201).json({ data: lead });
  });

  router.put('/:id', (req, res) => {
    const id = parseId(req.params.id);
    const lead = leads.updateLead(db, id, req.body);
    if (!lead) throw new HttpError(404, 'lead_not_found');
    audit(db, actor(req), 'lead_updated', 'lead', String(id));
    res.json({ data: lead });
  });

  router.delete('/:id', (req, res) => {
    const id = parseId(req.params.id);
    const removed = leads.deleteLead(db, id);
    if (!removed) throw new HttpError(404, 'lead_not_found');
    audit(db, actor(req), 'lead_deleted', 'lead', String(id));
    res.status(204).end();
  });

  return router;
}