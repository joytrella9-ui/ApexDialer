import 'dotenv/config';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { config } from '../src/config.js';
import { backupDatabase } from './backup.js';
import {
  planTranscriptRetention,
  executeTranscriptRetention,
  RETENTION_CONFIRM,
} from '../src/services/transcriptRetention.js';

// Operator CLI for transcript retention.
//
//   node scripts/retention.js [--db <path>]
//       Dry run (default). Opens the database READ-ONLY and prints what would expire.
//
//   node scripts/retention.js --db <path> --execute --confirm DELETE_EXPIRED_TRANSCRIPTS \
//        --expected <count from the dry run> --backup-to <new file path>
//       Writes a WAL-safe backup to --backup-to first, then deletes expired text.
//       Refuses to run unless every flag is present and the expected count matches.
//
// The CLI never runs migrations or seeds data: it only opens an existing file.

const USAGE = `Usage:
  node scripts/retention.js [--db <path>]
  node scripts/retention.js --db <path> --execute --confirm ${RETENTION_CONFIRM} --expected <n> --backup-to <path>`;

export function parseArgs(argv) {
  const out = { execute: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--execute') out.execute = true;
    else if (arg === '--db') out.db = argv[++i];
    else if (arg === '--confirm') out.confirm = argv[++i];
    else if (arg === '--expected') out.expected = argv[++i];
    else if (arg === '--backup-to') out.backupTo = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

export async function runRetentionCli(argv, { now = new Date(), log = console.log, error = console.error } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    error(`${err.message}\n${USAGE}`);
    return 2;
  }
  const dbPath = path.resolve(args.db || config.dbPath);
  if (!existsSync(dbPath)) {
    error(`Database file not found: ${dbPath}`);
    return 2;
  }

  if (!args.execute) {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const { report } = planTranscriptRetention(db, { now });
      log(JSON.stringify(report, null, 2));
      return 0;
    } finally {
      db.close();
    }
  }

  if (args.confirm !== RETENTION_CONFIRM) {
    error(`Refusing to delete: pass --confirm ${RETENTION_CONFIRM}`);
    return 2;
  }
  if (args.expected === undefined || !/^\d+$/.test(String(args.expected))) {
    error('Refusing to delete: pass --expected <count> from the most recent dry run');
    return 2;
  }
  if (!args.backupTo) {
    error('Refusing to delete: pass --backup-to <new file path> so a backup is written first');
    return 2;
  }
  const backupPath = path.resolve(args.backupTo);
  if (backupPath === dbPath || existsSync(backupPath)) {
    error('Refusing to delete: --backup-to must be a new file path, not the database or an existing file');
    return 2;
  }

  await backupDatabase(dbPath, backupPath);
  log(`Backup written to ${backupPath}`);

  const db = new Database(dbPath, { fileMustExist: true });
  db.pragma('foreign_keys = ON');
  try {
    const result = executeTranscriptRetention(db, {
      now,
      confirm: args.confirm,
      expectedTotal: Number(args.expected),
      username: 'cli-retention',
    });
    log(JSON.stringify(result, null, 2));
    return 0;
  } catch (err) {
    error(`Retention failed: ${err.message}${err.details ? ` ${JSON.stringify(err.details)}` : ''}`);
    return 1;
  } finally {
    db.close();
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  runRetentionCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
