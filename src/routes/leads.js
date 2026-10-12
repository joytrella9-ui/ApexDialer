import { Router } from 'express';
import { HttpError } from '../lib/errors.js';
import * as leads from '../services/leads.js';
import { importLeads, leadsToCsv } from '../services/csv.js';

function parseId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new HttpError(400, 'invalid_id');
  }
  return id;
}

function boolParam(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

export function leadsRouter(db) {
  const router = Router();

  router.get('/', (req, res) => {
    const data = leads.listLeads(db, {
      q: typeof req.query.q === 'string' ? req.query.q.trim() : undefined,
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
      callType: typeof req.query.callType === 'string' ? req.query.callType : undefined,
      eligible: boolParam(req.query.eligible),
    });
    res.json({ data, count: data.length });
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

  router.post('/import', (req, res) => {
    const csv = typeof req.body === 'string' ? req.body : req.body?.csv;
    if (typeof csv !== 'string' || csv.trim() === '') {
      throw new HttpError(400, 'missing_csv');
    }
    const summary = importLeads(db, csv);
    res.status(201).json({ data: summary });
  });

  router.get('/:id', (req, res) => {
    const lead = leads.getLead(db, parseId(req.params.id));
    if (!lead) throw new HttpError(404, 'lead_not_found');
    res.json({ data: lead });
  });

  router.post('/', (req, res) => {
    const lead = leads.createLead(db, req.body);
    res.status(201).json({ data: lead });
  });

  router.put('/:id', (req, res) => {
    const lead = leads.updateLead(db, parseId(req.params.id), req.body);
    if (!lead) throw new HttpError(404, 'lead_not_found');
    res.json({ data: lead });
  });

  router.delete('/:id', (req, res) => {
    const removed = leads.deleteLead(db, parseId(req.params.id));
    if (!removed) throw new HttpError(404, 'lead_not_found');
    res.status(204).end();
  });

  return router;
}