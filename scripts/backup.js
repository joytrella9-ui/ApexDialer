import 'dotenv/config';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { config } from '../src/config.js';

// WAL-safe point-in-time copy using the SQLite Online Backup API. Reads the
// source with a read-only connection so a live ApexDialer database can be
// backed up without locking out operators, and never modifies the source.
export function backupDatabase(dbPath, backupPath) {
  if (dbPath === ':memory:') {
    throw new Error('Cannot backup an in-memory database; pass a file path.');
  }
  mkdirSync(path.dirname(backupPath), { recursive: true });
  const source = new Database(dbPath, { readonly: true });
  return source.backup(backupPath).finally(() => {
    try {
      source.close();
    } catch {
      // already closed
    }
  });
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const dbPath = process.argv[2] || config.dbPath;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = process.argv[3] || `${dbPath}.backup-${stamp}`;

  backupDatabase(dbPath, backupPath)
    .then(() => {
      console.log(`ApexDialer backup written to ${backupPath}`);
    })
    .catch((err) => {
      console.error('Backup failed:', err.message ?? err);
      process.exit(1);
    });
}