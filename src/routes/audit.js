import { Router } from 'express';
import { listAudit } from '../services/auditLog.js';

export function auditRouter(db) {
  const router = Router();

  router.get('/', (req, res) => {
    const result = listAudit(db, {
      limit: req.query.limit,
      offset: req.query.offset,
      action: typeof req.query.action === 'string' ? req.query.action : undefined,
    });
    res.json({ ...result, count: result.data.length });
  });

  return router;
}
