import { parseLead, mapLeadUpdate } from '../validate/lead.js';

export function phoneKey(phone) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function activeDncKeys(db) {
  return new Set(
    db
      .prepare('SELECT phone FROM dnc_entries WHERE active = 1')
      .all()
      .map((r) => phoneKey(r.phone))
  );
}

export function isSuppressed(db, phone) {
  const key = phoneKey(phone);
  if (!key) return false;
  return activeDncKeys(db).has(key);
}

function toLead(row, dncKeys) {
  const suppressed = row.suppression_blocked === 1 || dncKeys.has(phoneKey(row.phone));
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    company: row.company,
    callType: row.call_type,
    timezone: row.timezone,
    consent: {
      status: row.consent_status,
      evidence: row.consent_evidence,
      source: row.consent_source,
      date: row.consent_date,
    },
    status: row.status,
    disposition: row.disposition,
    notes: row.notes,
    suppressed,
    eligible: row.status === 'pending' && !suppressed,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listLeads(db, { q, status, callType, eligible } = {}) {
  const clauses = [];
  const params = {};
  if (status) {
    clauses.push('status = @status');
    params.status = status;
  }
  if (callType) {
    clauses.push('call_type = @callType');
    params.callType = callType;
  }
  if (q) {
    clauses.push('(name LIKE @q OR phone LIKE @q OR company LIKE @q)');
    params.q = `%${q}%`;
  }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  const dncKeys = activeDncKeys(db);
  let leads = db
    .prepare(`SELECT * FROM leads${where} ORDER BY id DESC`)
    .all(params)
    .map((row) => toLead(row, dncKeys));
  if (eligible === true) leads = leads.filter((l) => l.eligible);
  if (eligible === false) leads = leads.filter((l) => !l.eligible);
  return leads;
}

export function getLead(db, id) {
  const row = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
  return row ? toLead(row, activeDncKeys(db)) : null;
}

export function createLead(db, input) {
  const data = parseLead(input);
  if (isSuppressed(db, data.phone)) {
    data.status = 'blocked';
    data.suppression_blocked = 1;
  }
  const info = db
    .prepare(
      `INSERT INTO leads
         (name, phone, company, call_type, timezone,
          consent_status, consent_evidence, consent_source, consent_date,
          status, disposition, notes, suppression_blocked)
       VALUES
         (@name, @phone, @company, @call_type, @timezone,
          @consent_status, @consent_evidence, @consent_source, @consent_date,
          @status, @disposition, @notes, @suppression_blocked)`
    )
    .run(data);
  return getLead(db, Number(info.lastInsertRowid));
}

export function updateLead(db, id, input) {
  const existing = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
  if (!existing) return null;

  const fields = mapLeadUpdate(input);
  const suppressed = isSuppressed(db, fields.phone ?? existing.phone);
  if (suppressed) {
    fields.status = 'blocked';
    fields.suppression_blocked = 1;
  } else if (fields.phone !== undefined || existing.suppression_blocked === 1) {
    fields.suppression_blocked = 0;
  }

  const keys = Object.keys(fields);
  if (keys.length) {
    const sets = keys.map((k) => `${k} = @${k}`).join(', ');
    db.prepare(`UPDATE leads SET ${sets}, updated_at = datetime('now') WHERE id = @id`).run({
      ...fields,
      id,
    });
  }
  return getLead(db, id);
}

export function deleteLead(db, id) {
  const info = db.prepare('DELETE FROM leads WHERE id = ?').run(id);
  return info.changes > 0;
}