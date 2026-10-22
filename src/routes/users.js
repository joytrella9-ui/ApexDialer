import { Router } from 'express';
import { HttpError } from '../lib/errors.js';
import * as users from '../services/users.js';

function parseId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'invalid_id');
  return id;
}

// Admin-only (enforced centrally in middleware/policy.js).
export function usersRouter(db, cfg) {
  const router = Router();

  router.get('/', (req, res) => {
    res.json({ data: users.listUsers(db) });
  });

  router.post('/', (req, res) => {
    const user = users.createUser(db, req.auth.user.username, req.body, {
      bcryptRounds: cfg.auth.bcryptRounds,
    });
    res.status(201).json({ data: user });
  });

  router.patch('/:id', (req, res) => {
    const user = users.updateUser(
      db,
      req.auth.user.username,
      { targetId: parseId(req.params.id), actorId: req.auth.userId },
      req.body
    );
    res.json({ data: user });
  });

  return router;
}
