import { createDb } from '../src/db/db.js';
import { createApp } from '../src/app.js';

export function startServer(db) {
  const server = createApp(db).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base };
}

export async function withServer(fn, db = createDb(':memory:')) {
  const { server, base } = startServer(db);
  try {
    return await fn(base, db);
  } finally {
    server.closeAllConnections();
    server.close();
    db.close();
  }
}

export async function api(base, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}