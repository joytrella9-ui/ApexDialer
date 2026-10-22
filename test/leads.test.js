import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer, api } from '../test-support/helpers.js';
import { phoneKey } from '../src/services/leads.js';

const VALID = {
  name: 'Jordan Mitchell',
  phone: '+1 555 010 1001',
  company: 'Northstar Logistics',
  callType: 'existing-customer',
  timezone: 'America/New_York',
  consent: { status: 'recorded', source: 'web-form', date: '2026-09-01', evidence: 'signed consent' },
  notes: 'First contact',
};

function seedDnc(db, phone) {
  db.prepare('INSERT INTO dnc_entries (phone, source) VALUES (?, ?)').run(phone, 'internal');
}

// ---- create ---------------------------------------------------------------

test('POST /api/leads creates a lead with mapped fields and is eligible', async () => {
  await withServer(async (base) => {
    const { status, body } = await api(base, 'POST', '/api/leads', VALID);
    assert.equal(status, 201);
    assert.ok(body.data.id > 0);
    assert.equal(body.data.name, 'Jordan Mitchell');
    assert.equal(body.data.company, 'Northstar Logistics');
    assert.equal(body.data.callType, 'existing-customer');
    assert.equal(body.data.timezone, 'America/New_York');
    assert.equal(body.data.consent.status, 'recorded');
    assert.equal(body.data.consent.source, 'web-form');
    assert.equal(body.data.status, 'pending');
    assert.equal(body.data.suppressed, false);
    assert.equal(body.data.eligible, true);
  });
});

test('POST /api/leads applies defaults for optional fields', async () => {
  await withServer(async (base) => {
    const { body } = await api(base, 'POST', '/api/leads', { name: 'Riley Carter', phone: '5550101005' });
    assert.equal(body.data.callType, 'sales');
    assert.equal(body.data.company, '');
    assert.equal(body.data.consent.status, 'none');
    assert.equal(body.data.status, 'pending');
  });
});

test('POST /api/leads rejects an invalid phone with 400 validation_error', async () => {
  await withServer(async (base) => {
    const { status, body } = await api(base, 'POST', '/api/leads', { name: 'A', phone: '123' });
    assert.equal(status, 400);
    assert.equal(body.error, 'validation_error');
    assert.ok(Array.isArray(body.details) && body.details.length >= 1);
  });
});

test('POST /api/leads rejects a missing name with 400', async () => {
  await withServer(async (base) => {
    const { status, body } = await api(base, 'POST', '/api/leads', { phone: '5550101001' });
    assert.equal(status, 400);
    assert.equal(body.error, 'validation_error');
  });
});

test('POST /api/leads rejects an unknown call type with 400', async () => {
  await withServer(async (base) => {
    const { status } = await api(base, 'POST', '/api/leads', { name: 'A', phone: '5550101001', callType: 'spam' });
    assert.equal(status, 400);
  });
});

// ---- read / list ----------------------------------------------------------

test('GET /api/leads lists leads and supports search and status filter', async () => {
  await withServer(async (base) => {
    await api(base, 'POST', '/api/leads', VALID);
    await api(base, 'POST', '/api/leads', { name: 'Taylor Brooks', phone: '5550101002', company: 'Bluepeak' });

    const all = await api(base, 'GET', '/api/leads');
    assert.equal(all.status, 200);
    assert.equal(all.body.count, 2);

    const search = await api(base, 'GET', '/api/leads?q=Taylor');
    assert.equal(search.body.count, 1);
    assert.equal(search.body.data[0].name, 'Taylor Brooks');

    const statusFilter = await api(base, 'GET', '/api/leads?status=completed');
    assert.equal(statusFilter.body.count, 0);
  });
});

test('GET /api/leads/:id returns a lead, and 404 for a missing one', async () => {
  await withServer(async (base) => {
    const created = await api(base, 'POST', '/api/leads', VALID);
    const found = await api(base, 'GET', `/api/leads/${created.body.data.id}`);
    assert.equal(found.status, 200);
    assert.equal(found.body.data.name, 'Jordan Mitchell');

    const missing = await api(base, 'GET', '/api/leads/9999');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, 'lead_not_found');
  });
});

// ---- update ---------------------------------------------------------------

test('PUT /api/leads/:id updates fields', async () => {
  await withServer(async (base) => {
    const created = await api(base, 'POST', '/api/leads', VALID);
    const id = created.body.data.id;
    const { status, body } = await api(base, 'PUT', `/api/leads/${id}`, {
      name: 'Jordan M.',
      status: 'completed',
      disposition: 'Interested',
      notes: 'Follow up next week',
    });
    assert.equal(status, 200);
    assert.equal(body.data.name, 'Jordan M.');
    assert.equal(body.data.status, 'completed');
    assert.equal(body.data.disposition, 'Interested');
    assert.equal(body.data.eligible, false);
  });
});

test('PUT /api/leads/:id returns 404 for a missing lead', async () => {
  await withServer(async (base) => {
    const { status, body } = await api(base, 'PUT', '/api/leads/9999', { name: 'X' });
    assert.equal(status, 404);
    assert.equal(body.error, 'lead_not_found');
  });
});

test('PUT /api/leads/:id rejects invalid input and invalid id', async () => {
  await withServer(async (base) => {
    const created = await api(base, 'POST', '/api/leads', VALID);
    const id = created.body.data.id;
    const badPhone = await api(base, 'PUT', `/api/leads/${id}`, { phone: 'abc' });
    assert.equal(badPhone.status, 400);
    assert.equal(badPhone.body.error, 'validation_error');

    const badId = await api(base, 'PUT', '/api/leads/abc', { name: 'X' });
    assert.equal(badId.status, 400);
    assert.equal(badId.body.error, 'invalid_id');
  });
});

// ---- delete ---------------------------------------------------------------

test('DELETE /api/leads/:id removes a lead and 404s afterwards', async () => {
  await withServer(async (base) => {
    const created = await api(base, 'POST', '/api/leads', VALID);
    const id = created.body.data.id;
    const del = await api(base, 'DELETE', `/api/leads/${id}`);
    assert.equal(del.status, 204);
    const after = await api(base, 'GET', `/api/leads/${id}`);
    assert.equal(after.status, 404);
  });
});

test('DELETE /api/leads/:id returns 404 for a missing lead', async () => {
  await withServer(async (base) => {
    const { status, body } = await api(base, 'DELETE', '/api/leads/9999');
    assert.equal(status, 404);
    assert.equal(body.error, 'lead_not_found');
  });
});

// ---- Do Not Call suppression ---------------------------------------------

test('a lead whose phone is on the internal DNC list is blocked and not eligible', async () => {
  await withServer(async (base, db) => {
    seedDnc(db, '+1 555 010 9999');
    const { status, body } = await api(base, 'POST', '/api/leads', { name: 'Suppressed Person', phone: '5550109999' });
    assert.equal(status, 201);
    assert.equal(body.data.suppressed, true);
    assert.equal(body.data.status, 'blocked');
    assert.equal(body.data.eligible, false);
  });
});

test('DNC matching is format-insensitive (+1 / spaces / dashes / dots)', async () => {
  await withServer(async (base, db) => {
    seedDnc(db, '555-010-7777');
    const { body } = await api(base, 'POST', '/api/leads', { name: 'Format Test', phone: '+1 (555) 010.7777' });
    assert.equal(body.data.suppressed, true);
    assert.equal(body.data.eligible, false);
  });
});

test('GET /api/leads?eligible=true excludes suppressed leads', async () => {
  await withServer(async (base, db) => {
    seedDnc(db, '5550108888');
    await api(base, 'POST', '/api/leads', { name: 'Normal', phone: '5550101234' });
    await api(base, 'POST', '/api/leads', { name: 'Blocked', phone: '5550108888' });

    const eligible = await api(base, 'GET', '/api/leads?eligible=true');
    assert.equal(eligible.body.count, 1);
    assert.equal(eligible.body.data[0].name, 'Normal');

    const notEligible = await api(base, 'GET', '/api/leads?eligible=false');
    assert.equal(notEligible.body.count, 1);
    assert.equal(notEligible.body.data[0].name, 'Blocked');
  });
});

test('updating a lead onto the DNC list forces it blocked and cannot be un-suppressed', async () => {
  await withServer(async (base, db) => {
    seedDnc(db, '5550106666');
    const created = await api(base, 'POST', '/api/leads', { name: 'Moveable', phone: '5550101234' });
    const id = created.body.data.id;

    const moved = await api(base, 'PUT', `/api/leads/${id}`, { phone: '5550106666' });
    assert.equal(moved.body.data.suppressed, true);
    assert.equal(moved.body.data.status, 'blocked');
    assert.equal(moved.body.data.eligible, false);

    const override = await api(base, 'PUT', `/api/leads/${id}`, { status: 'pending' });
    assert.equal(override.body.data.suppressed, true);
    assert.equal(override.body.data.status, 'blocked');
    assert.equal(override.body.data.eligible, false);
  });
});

test('phoneKey normalizes US numbers to their last 10 digits', () => {
  assert.equal(phoneKey('+1 (555) 010-1234'), '5550101234');
  assert.equal(phoneKey('5550101234'), '5550101234');
  assert.equal(phoneKey('15550101234'), '5550101234');
});

// ---- audit trail ----------------------------------------------------------

test('lead create/update/delete/import are recorded in the audit log', async () => {
  await withServer(async (base, db) => {
    const created = await api(base, 'POST', '/api/leads', VALID);
    const id = created.body.data.id;
    await api(base, 'PUT', `/api/leads/${id}`, { notes: 'touched' });
    await api(base, 'DELETE', `/api/leads/${id}`);
    await api(base, 'POST', '/api/leads/import', {
      csv: 'Name,Phone\r\nImport Guy,5550101999\r\n',
    });

    const actions = db
      .prepare("SELECT action, entity_id FROM audit_log WHERE entity_type = 'lead' ORDER BY id")
      .all();
    const byAction = Object.fromEntries(actions.map((a) => [a.action, a.entity_id]));
    assert.equal(byAction.lead_created, String(id));
    assert.equal(byAction.lead_updated, String(id));
    assert.equal(byAction.lead_deleted, String(id));
    assert.ok('leads_imported' in byAction, 'import must be audited');
  });
});