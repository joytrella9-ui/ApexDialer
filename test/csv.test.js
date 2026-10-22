import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer, api, ensureAuth } from '../test-support/helpers.js';
import { createDb } from '../src/db/db.js';
import { importLeads } from '../src/services/csv.js';

const VALID = {
  name: 'Jordan Mitchell',
  phone: '+1 555 010 1001',
  company: 'Northstar Logistics',
  callType: 'existing-customer',
  timezone: 'America/New_York',
  consent: { status: 'recorded', source: 'web-form', date: '2026-09-01', evidence: 'signed consent' },
  notes: 'First contact',
};

const EXPORT_HEADER =
  'Lead ID,Name,Phone,Company,Call Type,Timezone,Consent Status,Consent Source,Consent Date,Consent Evidence,Status,Disposition,Notes,Suppressed,Created At,Updated At';

async function getCsv(base, path) {
  const cookie = await ensureAuth(base);
  const res = await fetch(`${base}${path}`, { headers: cookie ? { cookie } : {} });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

async function postCsv(base, path, csv) {
  const cookie = await ensureAuth(base);
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'text/csv', ...(cookie ? { cookie } : {}) },
    body: csv,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

// ---- export ---------------------------------------------------------------

test('GET /api/leads/export returns a CSV attachment with the expected header', async () => {
  await withServer(async (base) => {
    await api(base, 'POST', '/api/leads', VALID);
    const { status, headers, text } = await getCsv(base, '/api/leads/export');
    assert.equal(status, 200);
    assert.match(headers.get('content-type'), /text\/csv/);
    assert.match(headers.get('content-disposition'), /apexdialer-leads\.csv/);
    const lines = text.split('\r\n');
    assert.equal(lines[0], EXPORT_HEADER);
    assert.ok(lines[1].startsWith('1,Jordan Mitchell,+1 555 010 1001,Northstar Logistics,existing-customer,'));
  });
});

test('export neutralizes spreadsheet formula injection in cells', async () => {
  await withServer(async (base) => {
    await api(base, 'POST', '/api/leads', {
      name: '=cmd|calc',
      phone: '5550104004',
      company: '+SUM(A1)',
      notes: '@evil',
    });
    const { text } = await getCsv(base, '/api/leads/export');
    assert.ok(text.includes("'=cmd|calc"), 'name should be prefixed');
    assert.ok(text.includes("'+SUM(A1)"), 'company should be prefixed');
    assert.ok(text.includes("'@evil"), 'notes should be prefixed');
  });
});

// ---- import ---------------------------------------------------------------

test('export then import round-trips leads through a fresh database', async () => {
  await withServer(async (base) => {
    await api(base, 'POST', '/api/leads', VALID);
    await api(base, 'POST', '/api/leads', {
      name: 'Casey Nguyen',
      phone: '555 010 1002',
      company: 'Harbor Freight Co',
      callType: 'sales',
      notes: 'Second',
    });
    const { text } = await getCsv(base, '/api/leads/export');

    await withServer(async (base2) => {
      const { status, body } = await postCsv(base2, '/api/leads/import', text);
      assert.equal(status, 201);
      assert.equal(body.data.imported, 2);
      assert.equal(body.data.rejected, 0);
      assert.equal(body.data.skipped, 0);

      const { body: list } = await api(base2, 'GET', '/api/leads');
      assert.equal(list.count, 2);
      const jordan = list.data.find((l) => l.name === 'Jordan Mitchell');
      assert.equal(jordan.callType, 'existing-customer');
      assert.equal(jordan.company, 'Northstar Logistics');
      assert.equal(jordan.consent.status, 'recorded');
      assert.equal(jordan.consent.source, 'web-form');
      assert.equal(jordan.status, 'pending');
      assert.equal(jordan.eligible, true);
    });
  });
});

test('import handles quoted commas, embedded quotes and CRLF', async () => {
  await withServer(async (base) => {
    const csv = 'Name,Phone,Notes\r\n"Doe, John",+1 555 010 2002,"He said ""hello"", then left"\r\n';
    const { status, body } = await postCsv(base, '/api/leads/import', csv);
    assert.equal(status, 201);
    assert.equal(body.data.imported, 1);
    const { body: list } = await api(base, 'GET', '/api/leads');
    assert.equal(list.data[0].name, 'Doe, John');
    assert.equal(list.data[0].notes, 'He said "hello", then left');
  });
});

test('import reports row-level errors and still saves valid rows', async () => {
  await withServer(async (base) => {
    const csv = [
      'Name,Phone,Company',
      'Good Lead,5550103003,Acme',
      ',5550103004,No Name',
      'Bad Phone,abc,NoPhone',
    ].join('\r\n');
    const { status, body } = await postCsv(base, '/api/leads/import', csv);
    assert.equal(status, 201);
    assert.equal(body.data.imported, 1);
    assert.equal(body.data.rejected, 2);
    assert.deepEqual(
      body.data.errors.map((e) => e.row),
      [3, 4]
    );
    assert.ok(body.data.errors.every((e) => Array.isArray(e.errors) && e.errors.length > 0));
  });
});

test('import rejects files without Name and Phone columns', async () => {
  await withServer(async (base) => {
    const { status, body } = await postCsv(base, '/api/leads/import', 'Foo,Bar\r\nx,y\r\n');
    assert.equal(status, 400);
    assert.equal(body.error, 'invalid_headers');
  });
});

test('import rejects an empty request body', async () => {
  await withServer(async (base) => {
    const { status, body } = await api(base, 'POST', '/api/leads/import', {});
    assert.equal(status, 400);
    assert.equal(body.error, 'missing_csv');
  });
});

test('import skips duplicate phone numbers within a file and against existing leads', async () => {
  await withServer(async (base) => {
    const csv = 'Name,Phone\r\nA,5550105005\r\nB,5550105005\r\n';
    const { body } = await postCsv(base, '/api/leads/import', csv);
    assert.equal(body.data.imported, 1);
    assert.equal(body.data.skipped, 1);
    assert.match(body.data.warnings[0].message, /duplicate phone/i);

    const { body: again } = await postCsv(base, '/api/leads/import', 'Name,Phone\r\nC,5550105005\r\n');
    assert.equal(again.data.imported, 0);
    assert.equal(again.data.skipped, 1);
  });
});

test('import enforces internal DNC suppression regardless of file contents', async () => {
  await withServer(async (base, db) => {
    db.prepare('INSERT INTO dnc_entries (phone, source) VALUES (?, ?)').run('5550101234', 'internal');
    const csv = 'Name,Phone,Status\r\nBlocked Person,5550101234,completed\r\n';
    const { body } = await postCsv(base, '/api/leads/import', csv);
    assert.equal(body.data.imported, 1);
    assert.match(body.data.warnings[0].message, /Do Not Call/);

    const { body: list } = await api(base, 'GET', '/api/leads');
    assert.equal(list.data[0].status, 'blocked');
    assert.equal(list.data[0].suppressed, true);
    assert.equal(list.data[0].eligible, false);
  });
});

test('import warns when the timezone is not a valid IANA zone', async () => {
  await withServer(async (base) => {
    const csv = 'Name,Phone,Timezone\r\nMars Guy,5550106008,Mars/Olympus\r\nEarth Guy,5550106009,America/Chicago\r\n';
    const { body } = await postCsv(base, '/api/leads/import', csv);
    assert.equal(body.data.imported, 2);
    assert.equal(body.data.warnings.length, 1);
    assert.match(body.data.warnings[0].message, /not a valid IANA timezone/);
  });
});

test('import does not trust unsubstantiated consent claims', async () => {
  await withServer(async (base) => {
    const csv = [
      'Name,Phone,Consent Status,Consent Evidence',
      'Claimed,5550106006,recorded,',
      'Proven,5550106007,recorded,signed-form-on-file',
    ].join('\r\n');
    const { body } = await postCsv(base, '/api/leads/import', csv);
    assert.equal(body.data.imported, 2);
    assert.equal(body.data.warnings.length, 1);
    assert.match(body.data.warnings[0].message, /not treated as verified/);

    const { body: list } = await api(base, 'GET', '/api/leads');
    const claimed = list.data.find((l) => l.name === 'Claimed');
    const proven = list.data.find((l) => l.name === 'Proven');
    assert.equal(claimed.consent.status, 'none');
    assert.equal(proven.consent.status, 'recorded');
    assert.equal(proven.consent.evidence, 'signed-form-on-file');
  });
});

// ---- limits and transactions (service level) ------------------------------

test('importLeads rejects files larger than the row limit without writing', () => {
  const db = createDb(':memory:');
  try {
    const csv = 'Name,Phone\r\nA,5550107001\r\nB,5550107002\r\nC,5550107003\r\n';
    assert.throws(
      () => importLeads(db, csv, { maxRows: 2 }),
      (err) => err.status === 400 && err.message === 'too_many_rows'
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM leads').get().c, 0);
  } finally {
    db.close();
  }
});

test('import rolls back the whole batch when a database write fails midway', () => {
  const db = createDb(':memory:');
  try {
    db.exec(
      "CREATE TRIGGER fail_sentinel BEFORE INSERT ON leads WHEN NEW.name = '__FAIL__' BEGIN SELECT RAISE(ABORT, 'boom'); END;"
    );
    const csv = 'Name,Phone\r\nValid One,5550108001\r\n__FAIL__,5550108002\r\n';
    assert.throws(
      () => importLeads(db, csv),
      (err) => err.status === 500 && err.message === 'import_failed'
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM leads').get().c, 0);
  } finally {
    db.close();
  }
});
