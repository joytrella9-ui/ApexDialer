import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLead, phoneSchema, CALL_TYPES, LEAD_STATUSES } from '../src/validate/lead.js';

test('parseLead: a valid lead is normalized for the database', () => {
  const lead = parseLead({
    name: '  Jordan Mitchell  ',
    phone: '+1 555 010 1001',
    company: 'Northstar Logistics',
    callType: 'existing-customer',
    timezone: 'America/New_York',
    consent: { status: 'recorded', source: 'web-form', date: '2026-09-01', evidence: 'signed consent' },
    notes: 'Follow up in October.',
  });
  assert.equal(lead.name, 'Jordan Mitchell');
  assert.equal(lead.call_type, 'existing-customer');
  assert.equal(lead.timezone, 'America/New_York');
  assert.equal(lead.consent_status, 'recorded');
  assert.equal(lead.consent_source, 'web-form');
  assert.equal(lead.status, 'pending');
  assert.equal(lead.suppression_blocked, 0);
});

test('parseLead: defaults to sales call type and no consent', () => {
  const lead = parseLead({ name: 'Riley Carter', phone: '+1 555 010 1005' });
  assert.equal(lead.call_type, 'sales');
  assert.equal(lead.consent_status, 'none');
  assert.equal(lead.company, '');
});

test('parseLead: rejects an invalid phone number', () => {
  assert.throws(() => parseLead({ name: 'A', phone: '123' }), /phone/);
  assert.throws(() => parseLead({ name: 'A', phone: 'abc' }), /phone/);
});

test('parseLead: rejects a missing name', () => {
  assert.throws(() => parseLead({ phone: '+1 555 010 1001' }), /name/);
});

test('parseLead: rejects an unknown call type', () => {
  assert.throws(() => parseLead({ name: 'A', phone: '+1 555 010 1001', callType: 'spam' }));
});

test('phoneSchema accepts common US phone formats', () => {
  for (const p of ['+1 555 010 1234', '5550101234', '(555) 010-1234', '555.010.1234', '+15550101234']) {
    assert.doesNotThrow(() => phoneSchema.parse(p), `expected ${p} to be valid`);
  }
});

test('exports expose call types and statuses for consistent use', () => {
  assert.deepEqual(CALL_TYPES, ['sales', 'existing-customer']);
  assert.ok(LEAD_STATUSES.includes('pending'));
  assert.ok(LEAD_STATUSES.includes('dnc'));
});