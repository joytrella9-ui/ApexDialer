import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_IVR_MENU, resolveIvrInput, isValidDigit } from '../src/services/ivr.js';
import { classifyIntent, INTENT_ROUTES, aiOpening } from '../src/services/ai.js';

test('IVR resolves valid menu digits to routes and outcomes', () => {
  assert.deepEqual(resolveIvrInput({ digit: '1' }), {
    valid: true,
    timedOut: false,
    route: 'interested',
    outcome: 'completed',
    menuKey: 'default',
  });
  assert.equal(resolveIvrInput({ digit: '2' }).outcome, 'callback');
  assert.equal(resolveIvrInput({ digit: '3' }).outcome, 'connected');
  assert.equal(resolveIvrInput({ digit: '9' }).outcome, 'opted_out');
});

test('IVR treats an unknown-but-well-formed digit as invalid, not a route', () => {
  const res = resolveIvrInput({ digit: '7' });
  assert.equal(res.valid, false);
  assert.equal(res.route, 'invalid');
  assert.equal(res.outcome, null);
});

test('IVR timeouts prompt and eventually exhaust to unanswered', () => {
  const retry = resolveIvrInput({ timedOut: true, attempt: 0 });
  assert.equal(retry.route, 'timeout');
  assert.equal(retry.outcome, null);
  assert.ok(retry.prompt);

  const exhausted = resolveIvrInput({ timedOut: true, attempt: DEFAULT_IVR_MENU.maxRetries });
  assert.equal(exhausted.route, 'opt-retry-exhausted');
  assert.equal(exhausted.outcome, 'unanswered');
});

test('IVR digit validation accepts DTMF and rejects junk', () => {
  assert.ok(isValidDigit('0'));
  assert.ok(isValidDigit('*'));
  assert.ok(isValidDigit('#'));
  assert.ok(!isValidDigit('a'));
  assert.ok(!isValidDigit('12'));
  assert.ok(!isValidDigit(null));
});

test('simulated AI classifies the four intents plus unknown', () => {
  assert.equal(classifyIntent('yes I am interested'), 'interested');
  assert.equal(classifyIntent('can you call me back tomorrow'), 'callback');
  assert.equal(classifyIntent('I want to speak to a representative'), 'representative');
  assert.equal(classifyIntent('please remove me from your list'), 'opt_out');
  assert.equal(classifyIntent('the weather is nice'), 'unknown');
});

test('every classified intent maps to a workflow route', () => {
  for (const intent of Object.keys(INTENT_ROUTES)) {
    assert.ok(INTENT_ROUTES[intent].route, `${intent} must have a route`);
  }
});

test('AI opening line addresses the lead by first name', () => {
  assert.match(aiOpening({ name: 'Dana Scully' }), /Dana/);
  assert.match(aiOpening({}), /there/);
});
