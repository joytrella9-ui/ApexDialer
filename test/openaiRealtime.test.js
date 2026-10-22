import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRealtimeSessionConfig,
  translateRealtimeEvent,
  encodeAudioAppend,
  buildAudioCommit,
  buildAudioClear,
  buildResponseCreate,
  buildResponseCancel,
  buildToolOutput,
  RealtimeSession,
  MAX_TEXT,
} from '../src/providers/openaiRealtime.js';
import { AI_TOOL_NAMES, buildRealtimeTools } from '../src/providers/aiTools.js';

test('the realtime session config pins tools to the allowlist and validates formats', () => {
  const config = buildRealtimeSessionConfig({ instructions: 'Be brief.' });
  assert.equal(config.type, 'session.update');
  assert.equal(config.session.tool_choice, 'auto');
  assert.deepEqual(config.session.tools.map((t) => t.name).sort(), [...AI_TOOL_NAMES].sort());
  assert.equal(config.session.audio.input.format.type, 'audio/g711_ulaw');
  assert.equal(config.session.instructions, 'Be brief.');

  // Only a subset may be requested, and only allowlisted names survive.
  const subset = buildRealtimeSessionConfig({ toolNames: ['end_call', 'opt_out'] });
  assert.deepEqual(subset.session.tools.map((t) => t.name).sort(), ['end_call', 'opt_out']);

  assert.throws(
    () => buildRealtimeSessionConfig({ toolNames: ['end_call', 'wire_transfer'] }),
    (err) => err.status === 400 && err.message === 'tool_not_allowed'
  );
  assert.throws(() => buildRealtimeSessionConfig({ inputFormat: 'audio/hax' }), (err) => err.status === 400);
  assert.throws(() => buildRealtimeSessionConfig({ outputFormat: 'mp3' }), (err) => err.status === 400);

  // Instructions are capped, never unbounded.
  const long = buildRealtimeSessionConfig({ instructions: 'x'.repeat(10000) });
  assert.ok(long.session.instructions.length <= 4000);
});

test('client event encoders validate audio and cap output', () => {
  assert.deepEqual(encodeAudioAppend('AAAA'), { type: 'input_audio_buffer.append', audio: 'AAAA' });
  assert.throws(() => encodeAudioAppend('not base64!'), (err) => err.status === 400);
  assert.throws(() => encodeAudioAppend(''), (err) => err.status === 400);
  assert.throws(() => encodeAudioAppend('A'.repeat(64 * 1024)), (err) => err.status === 400);

  assert.deepEqual(buildAudioCommit(), { type: 'input_audio_buffer.commit' });
  assert.deepEqual(buildAudioClear(), { type: 'input_audio_buffer.clear' });
  assert.deepEqual(buildResponseCreate(), { type: 'response.create' });
  assert.deepEqual(buildResponseCancel(), { type: 'response.cancel' });

  const output = buildToolOutput('call_1', { ok: true, extra: 'x'.repeat(MAX_TEXT + 100) });
  assert.equal(output.type, 'conversation.item.create');
  assert.equal(output.item.type, 'function_call_output');
  assert.equal(output.item.call_id, 'call_1');
  assert.ok(output.item.output.length <= MAX_TEXT);
  assert.throws(() => buildToolOutput('', {}), (err) => err.status === 400 && err.message === 'missing_call_id');
});

test('server events translate into the internal voice vocabulary', () => {
  assert.equal(translateRealtimeEvent({ type: 'session.created', session: { id: 'sess_1' } }).type, 'session_ready');
  assert.equal(translateRealtimeEvent({ type: 'session.updated' }).type, 'session_ready');

  const interrupt = translateRealtimeEvent({ type: 'input_audio_buffer.speech_started', item_id: 'msg_1' });
  assert.equal(interrupt.type, 'interrupt');
  assert.equal(interrupt.reason, 'user_speech');

  assert.equal(translateRealtimeEvent({ type: 'input_audio_buffer.timeout_triggered' }).type, 'silence');
  assert.equal(translateRealtimeEvent({ type: 'input_audio_buffer.dtmf_event_received', dtmf: '9' }).digit, '9');

  const speech = translateRealtimeEvent({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'yes tell me more' });
  assert.equal(speech.type, 'speech');
  assert.equal(speech.text, 'yes tell me more');

  // Both GA and legacy audio-delta names are accepted.
  assert.equal(translateRealtimeEvent({ type: 'response.output_audio.delta', delta: 'AAAA' }).type, 'audio');
  assert.equal(translateRealtimeEvent({ type: 'response.audio.delta', delta: 'AAAA' }).type, 'audio');
  assert.equal(translateRealtimeEvent({ type: 'response.output_audio_transcript.delta', delta: 'hi' }).delta, 'hi');

  const done = translateRealtimeEvent({ type: 'response.done', response: { status: 'completed' } });
  assert.equal(done.type, 'response_done');
  assert.equal(done.status, 'completed');

  const err = translateRealtimeEvent({ type: 'error', error: { code: 'server_error', message: 'boom' } });
  assert.equal(err.type, 'provider_error');
  assert.equal(err.code, 'server_error');

  assert.equal(translateRealtimeEvent({ type: 'some.future.event' }).type, 'ignored');
});

test('tool calls are parsed but never trusted, and malformed events fail closed', () => {
  const ok = translateRealtimeEvent({
    type: 'response.function_call_arguments.done',
    call_id: 'call_9',
    name: 'end_call',
    arguments: '{"reason":"done"}',
  });
  assert.equal(ok.type, 'tool_call');
  assert.equal(ok.allowed, true);
  assert.deepEqual(ok.arguments, { reason: 'done' });
  assert.equal(ok.parseError, false);

  const badName = translateRealtimeEvent({
    type: 'response.function_call_arguments.done',
    call_id: 'call_8',
    name: 'exfiltrate',
    arguments: '{}',
  });
  assert.equal(badName.allowed, false);

  const badJson = translateRealtimeEvent({
    type: 'response.function_call_arguments.done',
    call_id: 'call_7',
    name: 'end_call',
    arguments: '{oops',
  });
  assert.equal(badJson.parseError, true);
  assert.equal(badJson.arguments, null);

  assert.throws(() => translateRealtimeEvent('not json'), (err) => err.status === 400);
  assert.throws(() => translateRealtimeEvent(null), (err) => err.status === 400);
  assert.throws(() => translateRealtimeEvent('x'.repeat(200 * 1024)), (err) => err.status === 400);
});

test('RealtimeSession lifecycle fails closed and terminates cleanly', () => {
  const sent = [];
  const socket = { send: (m) => sent.push(JSON.parse(m)), close: () => {} };
  const events = [];
  const session = new RealtimeSession({ socket, onEvent: (e) => events.push(e.type) });

  session.start();
  assert.equal(sent[0].type, 'session.update');

  session.ingest({ type: 'session.created', session: { id: 'sess_1' } });
  assert.equal(session.state, 'ready');
  session.ingest({ type: 'response.output_audio.delta', delta: 'AAAA' });
  assert.equal(session.state, 'active');

  session.appendAudio('AAAA');
  session.commitAudio();
  session.requestResponse();
  session.cancelResponse();
  session.submitToolOutput('call_1', { ok: true });
  const types = sent.map((m) => m.type);
  assert.ok(types.includes('input_audio_buffer.append'));
  assert.ok(types.includes('response.cancel'));
  assert.ok(types.includes('conversation.item.create'));

  session.terminate('done');
  assert.equal(session.state, 'ended');
  assert.ok(events.includes('session_ended'));
  assert.throws(() => session.appendAudio('AAAA'), (err) => err.status === 409 && err.message === 'session_ended');
  assert.throws(() => session.start(), (err) => err.status === 409 && err.message === 'session_ended');

  // No socket -> every write is refused rather than silently dropped.
  const offline = new RealtimeSession({ socket: null });
  assert.throws(() => offline.start(), (err) => err.status === 409 && err.message === 'realtime_socket_unavailable');
});

test('buildRealtimeTools tool definitions stay within the allowlist shape', () => {
  for (const tool of buildRealtimeTools()) {
    assert.equal(tool.parameters.type, 'object');
    assert.equal(tool.parameters.additionalProperties, false);
  }
});
