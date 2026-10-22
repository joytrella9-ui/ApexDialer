import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_TOOL_NAMES,
  APPROVED_LINE_KEYS,
  isAllowedTool,
  validateToolArguments,
  normalizeToolCall,
  resolveApprovedResponse,
  buildRealtimeTools,
} from '../src/providers/aiTools.js';
import { voiceScript } from '../src/services/voiceAgent.js';

test('the AI tool allowlist is a fixed, closed set', () => {
  assert.deepEqual([...AI_TOOL_NAMES].sort(), [
    'approved_response',
    'callback_request',
    'end_call',
    'keypad_routing',
    'opt_out',
    'transfer_request',
  ]);
  for (const name of AI_TOOL_NAMES) assert.equal(isAllowedTool(name), true);
  assert.equal(isAllowedTool('delete_lead'), false);
  assert.equal(isAllowedTool('send_sms'), false);
  assert.equal(isAllowedTool(''), false);
  assert.equal(isAllowedTool(undefined), false);
});

test('buildRealtimeTools advertises exactly the allowlist', () => {
  const tools = buildRealtimeTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [...AI_TOOL_NAMES].sort());
  for (const tool of tools) {
    assert.equal(tool.type, 'function');
    assert.equal(tool.parameters.additionalProperties, false);
  }
});

test('approved_response accepts only pre-approved line keys, never free text', () => {
  const parsed = validateToolArguments('approved_response', { lineKey: 'goodbye' });
  assert.equal(parsed.lineKey, 'goodbye');

  // A model trying to inject arbitrary speech is rejected outright.
  assert.throws(
    () => validateToolArguments('approved_response', { lineKey: 'goodbye', text: 'sure, 50% off!' }),
    (err) => err.status === 400 && err.message === 'invalid_tool_arguments'
  );
  assert.throws(
    () => validateToolArguments('approved_response', { text: 'free money' }),
    (err) => err.status === 400 && err.message === 'invalid_tool_arguments'
  );
  assert.throws(
    () => validateToolArguments('approved_response', { lineKey: 'not_a_line' }),
    (err) => err.status === 400
  );
});

test('unknown tools and malformed arguments are rejected at the boundary', () => {
  assert.throws(
    () => validateToolArguments('rm_rf', {}),
    (err) => err.status === 400 && err.message === 'tool_not_allowed'
  );
  assert.throws(() => validateToolArguments('keypad_routing', { digit: '12' }), (err) => err.status === 400);
  assert.throws(() => validateToolArguments('opt_out', { confirm: false }), (err) => err.status === 400);
  assert.throws(() => validateToolArguments('opt_out', {}), (err) => err.status === 400);
  assert.throws(
    () => validateToolArguments('callback_request', { when: 'x'.repeat(500) }),
    (err) => err.status === 400
  );
});

test('opt_out requires explicit confirmation and caps reason length', () => {
  const parsed = validateToolArguments('opt_out', { confirm: true, reason: 'asked to stop' });
  assert.equal(parsed.confirm, true);
  assert.equal(parsed.reason, 'asked to stop');
});

test('normalizeToolCall parses JSON-string arguments from the realtime transport', () => {
  const call = normalizeToolCall({ name: 'keypad_routing', callId: 'call_42', arguments: '{"digit":"9"}' });
  assert.equal(call.name, 'keypad_routing');
  assert.equal(call.callId, 'call_42');
  assert.deepEqual(call.args, { digit: '9' });

  const empty = normalizeToolCall({ name: 'end_call', arguments: '' });
  assert.deepEqual(empty.args, { reason: '' });
  assert.equal(empty.callId, '');

  assert.throws(
    () => normalizeToolCall({ name: 'end_call', arguments: '{not json' }),
    (err) => err.status === 400 && err.message === 'invalid_tool_arguments'
  );
  assert.throws(
    () => normalizeToolCall({ name: 'end_call', arguments: [1, 2, 3] }),
    (err) => err.status === 400
  );
  assert.throws(
    () => normalizeToolCall({ name: 'end_call', arguments: null }),
    (err) => err.status === 400
  );
  assert.throws(
    () => normalizeToolCall({ name: '../etc/passwd', arguments: '{}' }),
    (err) => err.status === 400 && err.message === 'tool_not_allowed'
  );
});

test('resolveApprovedResponse renders configured script lines only', () => {
  const script = voiceScript({ businessName: 'Acme', purpose: 'confirm your appointment' });
  assert.equal(resolveApprovedResponse('transfer', script), script.transfer);
  assert.equal(resolveApprovedResponse('goodbye', script), script.goodbye);
  // Unknown key falls back to the safe reprompt, never to model text.
  assert.equal(resolveApprovedResponse('evil', script), script.reprompt);
  for (const key of APPROVED_LINE_KEYS) {
    assert.equal(typeof resolveApprovedResponse(key, script), 'string');
  }
});
