import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'migrations'
);

export function runMigrations(db) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (" +
      "version TEXT PRIMARY KEY, " +
      "applied_at TEXT NOT NULL DEFAULT (datetime('now')))"
  );
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_.+\.sql$/.test(f))
    .sort();
  const apply = db.transaction(() => {
    for (const file of files) {
      const version = file.split('_')[0];
      const applied = db
        .prepare('SELECT 1 FROM schema_migrations WHERE version = ?')
        .get(version);
      if (applied) continue;
      db.exec(readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(version);
    }
  });
  apply();
}