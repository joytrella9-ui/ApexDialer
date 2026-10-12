import { createDb } from '../src/db/db.js';
import { createApp } from '../src/app.js';

const AUTH_CREDS = { username: 'test-operator', password: 'correct horse battery staple' };
const baseCookie = new Map();

export function startServer(db, cfg) {
  const server = createApp(db, cfg).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base };
}

export async function withServer(fn, db = createDb(':memory:'), cfg) {
  const { server, base } = startServer(db, cfg);
  try {
    return await fn(base, db);
  } finally {
    server.closeAllConnections();
    server.close();
    db.close();
  }
}

function parseJsonBody(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function cookieHeader(setCookieHeader) {
  return setCookieHeader ? setCookieHeader.split(';')[0] : null;
}

async function ensureAuth(base) {
  const cached = baseCookie.get(base);
  if (cached !== undefined) return cached;
  await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(AUTH_CREDS),
  });
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(AUTH_CREDS),
  });
  const cookie = cookieHeader(res.headers.get('set-cookie'));
  baseCookie.set(base, cookie);
  return cookie;
}

export async function raw(base, method, path, { body, cookie, contentType, headers = {} } = {}) {
  const reqHeaders = { ...headers };
  if (body !== undefined) {
    const ct = contentType ?? (typeof body === 'string' ? undefined : 'application/json');
    if (ct) reqHeaders['content-type'] = ct;
  }
  if (cookie) reqHeaders.cookie = cookie;
  const payload =
    body === undefined
      ? undefined
      : contentType && contentType.startsWith('text/')
        ? body
        : typeof body === 'string'
          ? body
          : JSON.stringify(body);
  const res = await fetch(`${base}${path}`, { method, headers: reqHeaders, body: payload });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: parseJsonBody(text) };
}

export async function api(base, method, path, body, opts = {}) {
  let cookie = opts.cookie;
  if (cookie === undefined) {
    cookie = opts.authenticated === false ? null : await ensureAuth(base);
  }
  return raw(base, method, path, { body, cookie });
}

export { ensureAuth, AUTH_CREDS };