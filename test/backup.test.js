import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb } from '../src/db/db.js';
import { backupDatabase } from '../scripts/backup.js';

test('backupDatabase produces a reopenable copy with data and migrations intact', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'apexdialer-backup-'));
  const sourcePath = path.join(dir, 'source.db');
  const backupPath = path.join(dir, 'backup.db');
  try {
    const db = createDb(sourcePath);
    db.prepare("INSERT INTO users (username, password_hash) VALUES ('op', 'x')").run();
    db.prepare("INSERT INTO leads (name, phone) VALUES ('Backup Lead', '+1 555 010 9001')").run();
    db.close();

    await backupDatabase(sourcePath, backupPath);
    assert.ok(existsSync(backupPath), 'backup file must be written');

    const copy = createDb(backupPath);
    try {
      assert.equal(copy.prepare('SELECT COUNT(*) AS c FROM leads').get().c, 1);
      assert.equal(copy.prepare('SELECT COUNT(*) AS c FROM users').get().c, 1);
      assert.equal(copy.prepare('SELECT name FROM leads').get().name, 'Backup Lead');
      assert.ok(
        copy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='provider_events'").get(),
        'backup must include all migrated tables'
      );
      const migrations = copy.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n;
      assert.ok(migrations >= 4, 'all migrations must be recorded in the copy');
    } finally {
      copy.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('backupDatabase copies committed data in WAL mode', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'apexdialer-backup-wal-'));
  const sourcePath = path.join(dir, 'source.db');
  const backupPath = path.join(dir, 'backup.db');
  try {
    const db = createDb(sourcePath);
    assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
    db.prepare("INSERT INTO leads (name, phone) VALUES ('WAL Lead', '+1 555 010 9002')").run();
    // Keep the source open to prove the online backup API works on a live WAL db.
    await backupDatabase(sourcePath, backupPath);

    const copy = createDb(backupPath);
    try {
      assert.equal(copy.prepare('SELECT COUNT(*) AS c FROM leads').get().c, 1);
    } finally {
      copy.close();
    }
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('backupDatabase refuses an in-memory database', () => {
  assert.throws(() => backupDatabase(':memory:', 'whatever.db'), /in-memory/);
});
