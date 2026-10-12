import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { HttpError } from '../lib/errors.js';
import { LEAD_STATUSES, createLeadSchema, parseLead } from '../validate/lead.js';
import { phoneKey, loadDncKeys, insertLead } from './leads.js';

export const MAX_IMPORT_ROWS = 5000;

export const EXPORT_COLUMNS = [
  { key: 'id', header: 'Lead ID' },
  { key: 'name', header: 'Name' },
  { key: 'phone', header: 'Phone' },
  { key: 'company', header: 'Company' },
  { key: 'callType', header: 'Call Type' },
  { key: 'timezone', header: 'Timezone' },
  { key: 'consentStatus', header: 'Consent Status' },
  { key: 'consentSource', header: 'Consent Source' },
  { key: 'consentDate', header: 'Consent Date' },
  { key: 'consentEvidence', header: 'Consent Evidence' },
  { key: 'status', header: 'Status' },
  { key: 'disposition', header: 'Disposition' },
  { key: 'notes', header: 'Notes' },
  { key: 'suppressed', header: 'Suppressed' },
  { key: 'createdAt', header: 'Created At' },
  { key: 'updatedAt', header: 'Updated At' },
];

const HEADER_ALIASES = {
  id: 'id',
  leadid: 'id',
  name: 'name',
  fullname: 'name',
  phone: 'phone',
  phonenumber: 'phone',
  number: 'phone',
  company: 'company',
  calltype: 'callType',
  timezone: 'timezone',
  tz: 'timezone',
  consentstatus: 'consentStatus',
  consentsource: 'consentSource',
  consentdate: 'consentDate',
  consentevidence: 'consentEvidence',
  status: 'status',
  disposition: 'disposition',
  notes: 'notes',
  note: 'notes',
  suppressed: 'suppressed',
  createdat: 'createdAt',
  updatedat: 'updatedAt',
};

function normalizeHeader(header) {
  const norm = String(header ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  return HEADER_ALIASES[norm] ?? norm;
}

function str(value) {
  return String(value ?? '').trim();
}

export function sanitizeCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

function exportValue(lead, key) {
  switch (key) {
    case 'id':
      return lead.id;
    case 'name':
      return lead.name;
    case 'phone':
      return lead.phone;
    case 'company':
      return lead.company;
    case 'callType':
      return lead.callType;
    case 'timezone':
      return lead.timezone;
    case 'consentStatus':
      return lead.consent.status;
    case 'consentSource':
      return lead.consent.source;
    case 'consentDate':
      return lead.consent.date;
    case 'consentEvidence':
      return lead.consent.evidence;
    case 'status':
      return lead.status;
    case 'disposition':
      return lead.disposition;
    case 'notes':
      return lead.notes;
    case 'suppressed':
      return lead.suppressed ? 'yes' : 'no';
    case 'createdAt':
      return lead.createdAt;
    case 'updatedAt':
      return lead.updatedAt;
    default:
      return '';
  }
}

export function leadsToCsv(leads) {
  const header = EXPORT_COLUMNS.map((c) => c.header);
  const rows = leads.map((lead) =>
    EXPORT_COLUMNS.map((c) => {
      const value = exportValue(lead, c.key);
      return c.key === 'phone' ? String(value ?? '') : sanitizeCell(value);
    })
  );
  return stringify([header, ...rows], { record_delimiter: '\r\n' });
}

function normalizeEnum(value, allowed) {
  const s = str(value).toLowerCase().replace(/[_\s]+/g, '-');
  return s;
}

function buildConsent(record, row, warnings) {
  let status = str(record.consentStatus).toLowerCase();
  const evidence = str(record.consentEvidence);
  const source = str(record.consentSource);
  const date = str(record.consentDate);

  if (status === 'recorded' && !source && !date && !evidence) {
    warnings.push({
      row,
      message:
        'consent marked "recorded" without any source/date/evidence; imported as "none" (imported consent claims are not treated as verified)',
    });
    status = 'none';
  }

  return { status: status || undefined, evidence, source, date };
}

export function importLeads(db, text, { maxRows = MAX_IMPORT_ROWS } = {}) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new HttpError(400, 'empty_csv');
  }

  let headers = [];
  let records;
  try {
    records = parse(text, {
      columns: (header) => {
        headers = header.map(normalizeHeader);
        return headers;
      },
      skip_empty_lines: true,
      trim: true,
      bom: true,
      relax_column_count: true,
      info: true,
    });
  } catch (err) {
    throw new HttpError(400, 'csv_parse_error', [{ message: err.message }]);
  }

  if (!headers.includes('name') || !headers.includes('phone')) {
    throw new HttpError(400, 'invalid_headers', [
      { message: 'CSV must contain Name and Phone columns', columns: headers },
    ]);
  }

  if (records.length > maxRows) {
    throw new HttpError(400, 'too_many_rows', [
      { message: `Import is limited to ${maxRows} rows per file`, rows: records.length },
    ]);
  }

  const dncKeys = loadDncKeys(db);
  const seen = new Set(db.prepare('SELECT phone FROM leads').all().map((r) => phoneKey(r.phone)));
  const errors = [];
  const warnings = [];
  const pending = [];
  let skipped = 0;

  for (const { record, info } of records) {
    const row = info.lines;
    const candidate = {
      name: str(record.name),
      phone: str(record.phone),
      company: str(record.company),
      callType: normalizeEnum(record.callType) || undefined,
      timezone: str(record.timezone),
      consent: buildConsent(record, row, warnings),
      notes: str(record.notes),
    };

    const result = createLeadSchema.safeParse(candidate);
    if (!result.success) {
      errors.push({
        row,
        errors: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      continue;
    }

    const status = normalizeEnum(record.status);
    if (status && !LEAD_STATUSES.includes(status)) {
      errors.push({ row, errors: [{ path: 'status', message: `status must be one of: ${LEAD_STATUSES.join(', ')}` }] });
      continue;
    }

    const disposition = str(record.disposition);
    if (disposition.length > 80) {
      errors.push({ row, errors: [{ path: 'disposition', message: 'disposition is too long (max 80)' }] });
      continue;
    }

    const key = phoneKey(candidate.phone);
    if (key && seen.has(key)) {
      skipped += 1;
      warnings.push({ row, message: 'duplicate phone skipped' });
      continue;
    }
    if (key) seen.add(key);

    const data = parseLead(result.data);
    if (status) data.status = status;
    data.disposition = disposition;

    if (key && dncKeys.has(key)) {
      data.status = 'blocked';
      data.suppression_blocked = 1;
      warnings.push({ row, message: 'phone is on the internal Do Not Call list; imported as blocked' });
    }

    pending.push(data);
  }

  const insertAll = db.transaction((rows) => rows.map((r) => insertLead(db, r)));
  let ids;
  try {
    ids = insertAll(pending);
  } catch (err) {
    throw new HttpError(500, 'import_failed', [
      { message: 'Import was rolled back; no rows were saved.', cause: err.message },
    ]);
  }

  return {
    total: records.length,
    imported: ids.length,
    rejected: errors.length,
    skipped,
    errors,
    warnings,
  };
}
