import { phoneKey } from './leads.js';
import { audit } from './auth.js';

// Persistent opt-out. A request to stop calling a number is honored across every
// campaign and every future import: the number is stored normalized, mirrored into
// the internal DNC list, and any matching lead is forced to `dnc`/suppressed.
export function isOptedOut(db, phone) {
  const key = phoneKey(phone);
  if (!key) return false;
  return db
    .prepare('SELECT phone FROM opt_outs')
    .all()
    .some((r) => phoneKey(r.phone) === key);
}

export function addOptOut(db, phone, { reason = '', source = 'ivr', username = 'system' } = {}) {
  const key = phoneKey(phone);
  if (!key) return false;

  const run = db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO opt_outs (phone, reason, source) VALUES (?, ?, ?)').run(
      key,
      reason,
      source
    );
    db.prepare(
      "INSERT OR IGNORE INTO dnc_entries (phone, source, list_name, active) VALUES (?, 'opt-out', 'Persistent opt-out', 1)"
    ).run(key);

    const leads = db.prepare('SELECT id, phone FROM leads').all();
    const update = db.prepare(
      "UPDATE leads SET status = 'dnc', suppression_blocked = 1, updated_at = datetime('now') WHERE id = ?"
    );
    let suppressed = 0;
    for (const lead of leads) {
      if (phoneKey(lead.phone) === key) {
        update.run(lead.id);
        suppressed += 1;
      }
    }
    audit(db, username, 'lead_opted_out', 'lead', key, JSON.stringify({ source, suppressed }));
    return suppressed;
  });

  run();
  return true;
}
