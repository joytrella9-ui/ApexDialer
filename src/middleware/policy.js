import { HttpError } from '../lib/errors.js';

// Central role policy for the authenticated /api surface. Mounted after requireAuth.
//
// Roles:
//   admin      - everything
//   supervisor - campaign control, lead deletion/bulk import/queue reset, consent revocation
//   operator   - day-to-day dialing: leads (non-destructive), calls, voice sessions, reads
//
// Users with an unknown or missing role are denied everywhere (fail closed). Paths are
// matched relative to /api. Any request that matches no rule is allowed for every
// known role.

export const ROLES = Object.freeze(['admin', 'supervisor', 'operator']);

const SUPERVISOR_UP = ['admin', 'supervisor'];
const ADMIN_ONLY = ['admin'];

const RULES = [
  { methods: ['DELETE'], pattern: /^\/leads\/\d+$/, roles: SUPERVISOR_UP },
  { methods: ['POST'], pattern: /^\/leads\/(import|reset-queue)$/, roles: SUPERVISOR_UP },
  { methods: ['POST'], pattern: /^\/compliance\/consent\/revoke$/, roles: SUPERVISOR_UP },
  // Editing a campaign's compliance profile changes the calling rules themselves.
  { methods: ['PUT'], pattern: /^\/compliance\/campaigns\/\d+$/, roles: SUPERVISOR_UP },
  { methods: ['POST'], pattern: /^\/compliance\/retention\/execute$/, roles: ADMIN_ONLY },
  { methods: ['GET'], pattern: /^\/settings\/metrics$/, roles: ADMIN_ONLY },
  // User management: list, create, change role, disable/enable.
  { methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'], pattern: /^\/users(\/|$)/, roles: ADMIN_ONLY },
  // Campaign creation, edits, and every run-control action (start/pause/tick/stop/...).
  { methods: ['POST', 'PUT', 'PATCH', 'DELETE'], pattern: /^\/campaigns(\/|$)/, roles: SUPERVISOR_UP },
];

export function requiredRolesFor(method, path) {
  const m = String(method).toUpperCase();
  for (const rule of RULES) {
    if (rule.methods.includes(m) && rule.pattern.test(path)) return rule.roles;
  }
  return null;
}

export function authorize(req, _res, next) {
  const role = req.auth?.user?.role;
  if (!role || !ROLES.includes(role)) return next(new HttpError(403, 'forbidden'));

  const allowed = requiredRolesFor(req.method, req.path);
  if (allowed && !allowed.includes(role)) return next(new HttpError(403, 'forbidden'));
  return next();
}
