import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { withServer, api, raw, cookieHeader } from '../test-support/helpers.js';
import { requiredRolesFor } from '../src/middleware/policy.js';

// Every mutating route in these files must be either restricted by a role rule in
// src/middleware/policy.js, or explicitly listed below as an operator-level action.
// Adding a new POST/PUT/PATCH/DELETE route without deciding its role fails this test.
const ROUTE_FILES = {
  'leads.js': '/leads',
  'calls.js': '/calls',
  'campaigns.js': '/campaigns',
  'compliance.js': '/compliance',
  'voice.js': '/voice',
  'settings.js': '/settings',
  'users.js': '/users',
  'reports.js': '/reports',
  'audit.js': '/audit',
};

// Provider callbacks are mounted before sign-in and verified by signature instead.
const UNAUTHENTICATED_SUBPATH = /^\/(webhooks|twiml|twilio)(\/|$)/;

const OPERATOR_ALLOWED = [
  { methods: ['POST'], pattern: /^\/leads$/ },
  { methods: ['PUT'], pattern: /^\/leads\/\d+$/ },
  { methods: ['POST'], pattern: /^\/leads\/import\/preview$/ },
  { methods: ['POST'], pattern: /^\/calls\/(attempt|skip)$/ },
  { methods: ['POST'], pattern: /^\/calls\/\d+\/(pause|resume|end|abort)$/ },
  { methods: ['POST'], pattern: /^\/compliance\/consent$/ },
  { methods: ['POST'], pattern: /^\/voice\/(fake|sessions)(\/.*)?$/ },
];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = path.resolve(HERE, '..', 'src', 'routes');

function normalize(p) {
  let out = p.replace(/:[A-Za-z]+/g, '1');
  if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

function mutatingRoutes() {
  const found = [];
  for (const [file, prefix] of Object.entries(ROUTE_FILES)) {
    const src = readFileSync(path.join(ROUTES_DIR, file), 'utf8');
    const re = /router\.(post|put|patch|delete)\(\s*'([^']*)'/g;
    let m;
    while ((m = re.exec(src))) {
      const sub = m[2];
      if (UNAUTHENTICATED_SUBPATH.test(sub)) continue;
      found.push({ file, method: m[1].toUpperCase(), full: normalize(prefix + sub) });
    }
  }
  return found;
}

test('every authenticated mutating route has a role rule or an explicit operator allowance', () => {
  const routes = mutatingRoutes();
  assert.ok(routes.length > 20, 'route scan should find the mutating routes');

  const unmapped = routes.filter((r) => {
    if (requiredRolesFor(r.method, r.full) !== null) return false;
    return !OPERATOR_ALLOWED.some((a) => a.methods.includes(r.method) && a.pattern.test(r.full));
  });
  assert.deepEqual(
    unmapped.map((r) => `${r.method} ${r.full} (${r.file})`),
    [],
    'add a rule to middleware/policy.js or an allowance to OPERATOR_ALLOWED for these routes'
  );
});

test('an expired session stops working', async () => {
  await withServer(async (base, db) => {
    const admin = await api(base, 'GET', '/api/auth/me');
    assert.equal(admin.status, 200);

    db.prepare('INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)').run(
      'expiring',
      bcrypt.hashSync('correct horse battery staple', 4),
      'expiring',
      'operator'
    );
    const login = await raw(base, 'POST', '/api/auth/login', {
      body: { username: 'expiring', password: 'correct horse battery staple' },
    });
    const cookie = cookieHeader(login.headers.get('set-cookie'));
    assert.equal((await api(base, 'GET', '/api/leads', undefined, { cookie })).status, 200);

    db.prepare("UPDATE sessions SET expires_at = datetime('now', '-1 hour')").run();

    const after = await api(base, 'GET', '/api/leads', undefined, { cookie });
    assert.equal(after.status, 401);
    assert.equal(after.body.error, 'authentication_required');
  });
});
