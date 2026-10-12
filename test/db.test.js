import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { createDb } from '../src/db/db.js';
import { runMigrations } from '../src/db/migrate.js';

const CORE_TABLES = [
  'users',
  'leads',
  'consent_records',
  'dnc_entries',
  'calls',
  'call_events',
  'audit_log',
  'settings',
  'sessions',
  'schema_migrations',
];

const MIGRATION_FILES = readdirSync(
  new URL('../src/db/migrations', import.meta.url)
).filter((f) => /^\d{3}_.+\.sql$/.test(f));

function tableNames(db) {
  return db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all()
    .map((r) => r.name);
}

test('migrations create all core tables', () => {
  const db = createDb(':memory:');
  try {
    const tables = tableNames(db);
    for (const t of CORE_TABLES) {
      assert.ok(tables.includes(t), `expected table "${t}" to exist`);
    }
  } finally {
    db.close();
  }
});

test('settings are seeded: demo mode on, telephony off, live calling off', () => {
  const db = createDb(':memory:');
  try {
    const get = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value;
    assert.equal(get('demo_mode'), 'true');
    assert.equal(get('telephony_provider'), 'none');
    assert.equal(get('live_enabled'), 'false');
  } finally {
    db.close();
  }
});

test('migrations are idempotent and only apply each migration once', () => {
  const db = createDb(':memory:');
  try {
    runMigrations(db);
    runMigrations(db);
    const n = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n;
    assert.equal(n, MIGRATION_FILES.length, 'each migration file must be recorded exactly once');
  } finally {
    db.close();
  }
});

test('leads table accepts consent + timezone + call-type fields', () => {
  const db = createDb(':memory:');
  try {
    db.prepare(
      `INSERT INTO leads
         (name, phone, company, call_type, timezone, consent_status, consent_evidence, consent_source, consent_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'Jordan Mitchell',
      '+15550101001',
      'Northstar Logistics',
      'existing-customer',
      'America/New_York',
      'recorded',
      'signed form 2026-09-01',
      'web-form',
      '2026-09-01'
    );
    const row = db.prepare('SELECT * FROM leads').get();
    assert.equal(row.call_type, 'existing-customer');
    assert.equal(row.timezone, 'America/New_York');
    assert.equal(row.consent_status, 'recorded');
  } finally {
    db.close();
  }
});