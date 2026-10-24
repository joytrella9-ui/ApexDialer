import { Router } from 'express';
import * as reports from '../services/reports.js';
import * as calls from '../services/calls.js';

export function reportsRouter(db, cfg) {
  const router = Router();

  router.get('/overview', (req, res) => {
    const days = req.query.days !== undefined ? Number(req.query.days) : 30;
    res.json({ data: reports.overview(db, cfg, { days }) });
  });

  router.get('/calls.csv', (req, res) => {
    const limit = req.query.limit !== undefined ? Number(req.query.limit) : 200;
    const supervisor = req.auth?.user?.role === 'admin' || req.auth?.user?.role === 'supervisor';
    const rows = calls.listCalls(db, req.auth.userId, { limit, allUsers: supervisor });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="apexdialer-calls.csv"');
    res.send(reports.callsToCsv(rows));
  });

  return router;
}
