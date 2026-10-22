import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMediaMessage,
  MediaStreamSession,
  MAX_MEDIA_PAYLOAD,
  MEDIA_EVENTS,
} from '../src/providers/twilioMediaStream.js';

test('Twilio media messages parse into typed internal shapes', () => {
  assert.deepEqual(parseMediaMessage({ event: 'connected', protocol: 'Call', version: '1.0.0' }), {
    type: 'connected',
    protocol: 'Call',
    version: '1.0.0',
  });

  const start = parseMediaMessage({
    event: 'start',
    sequenceNumber: 1,
    streamSid: 'MZ1',
    start: { callSid: 'CA1', accountSid: 'AC1', tracks: ['inbound'], customParameters: { a: 'b' } },
  });
  assert.equal(start.type, 'start');
  assert.equal(start.streamSid, 'MZ1');
  assert.equal(start.callSid, 'CA1');
  assert.deepEqual(start.tracks, ['inbound']);

  const media = parseMediaMessage({
    event: 'media',
    streamSid: 'MZ1',
    media: { track: 'inbound', chunk: '2', timestamp: '5', payload: 'AAAA' },
  });
  assert.deepEqual(media, {
    type: 'media',
    streamSid: 'MZ1',
    track: 'inbound',
    payload: 'AAAA',
    chunk: '2',
    timestamp: '5',
  });

  assert.deepEqual(parseMediaMessage({ event: 'dtmf', streamSid: 'MZ1', dtmf: { digit: '7' } }), {
    type: 'dtmf',
    streamSid: 'MZ1',
    digit: '7',
  });

  const stop = parseMediaMessage({ event: 'stop', streamSid: 'MZ1', stop: { callSid: 'CA1', reason: 'caller hung up' } });
  assert.equal(stop.type, 'stop');
  assert.equal(stop.callSid, 'CA1');
  assert.equal(stop.reason, 'caller hung up');

  assert.deepEqual(parseMediaMessage({ event: 'mark', streamSid: 'MZ1', mark: { name: 'done' } }), {
    type: 'mark',
    streamSid: 'MZ1',
    name: 'done',
  });
});

test('malformed and oversized media messages fail closed; unknown events are ignored', () => {
  const bad = (input) => assert.throws(() => parseMediaMessage(input), (err) => err.status === 400);

  bad(null);
  bad('not-json');
  bad('[1,2,3]');
  bad({ event: 'media', streamSid: 'MZ1', media: { payload: 123 } });
  bad({ event: 'media', streamSid: 'MZ1', media: { payload: 'not base64!!' } });
  bad({ event: 'media', streamSid: 'MZ1', media: { payload: 'A'.repeat(MAX_MEDIA_PAYLOAD + 1) } });
  bad({ event: 'dtmf', streamSid: 'MZ1', dtmf: { digit: '55' } });
  bad({ event: 'start', streamSid: 'MZ1', start: { tracks: ['inbound'] } });
  // An oversized raw frame is rejected before JSON.parse.
  assert.throws(
    () => parseMediaMessage('x'.repeat(200 * 1024)),
    (err) => err.status === 400
  );
  // A parseable but unrecognized event name is surfaced as unknown, not trusted.
  assert.deepEqual(parseMediaMessage({ event: 'future_event', data: 'x' }), { type: 'unknown', event: 'future_event' });
});

test('MediaStreamSession enforces connection lifecycle ordering', () => {
  const seen = [];
  const session = new MediaStreamSession({ onEvent: (m) => seen.push(m.type) });
  assert.equal(session.state, 'idle');

  session.receive({ event: 'connected' });
  assert.equal(session.state, 'connecting');
  assert.throws(
    () => session.receive({ event: 'media', streamSid: 'MZ1', media: { payload: 'AA' } }),
    (err) => err.status === 409 && err.message === 'message_before_start'
  );

  session.receive({ event: 'start', streamSid: 'MZ1', start: { callSid: 'CA1' } });
  assert.equal(session.state, 'streaming');
  assert.equal(session.callSid, 'CA1');
  // A duplicate start is refused.
  assert.throws(
    () => session.receive({ event: 'start', streamSid: 'MZ2', start: { callSid: 'CA2' } }),
    (err) => err.status === 409 && err.message === 'duplicate_stream_start'
  );

  session.receive({ event: 'media', streamSid: 'MZ1', media: { payload: 'AA' } });
  session.receive({ event: 'dtmf', streamSid: 'MZ1', dtmf: { digit: '1' } });
  session.receive({ event: 'mark', streamSid: 'MZ1', mark: { name: 'm1' } });
  assert.equal(session.lastMark, 'm1');
  session.receive({ event: 'stop', streamSid: 'MZ1', stop: {} });
  assert.equal(session.state, 'stopped');
  assert.equal(session.closed, true);
  assert.deepEqual(seen, ['connected', 'start', 'media', 'dtmf', 'mark', 'stop']);
});

test('MediaStreamSession writes fail closed without a socket and validate audio', () => {
  const sent = [];
  const socket = { send: (m) => sent.push(JSON.parse(m)), close: () => {} };
  const session = new MediaStreamSession({ socket });
  session.receive({ event: 'connected' });
  session.receive({ event: 'start', streamSid: 'MZ9', start: { callSid: 'CA9' } });

  session.sendAudio('AAAA');
  session.sendMark('greeting');
  session.clear();
  assert.deepEqual(sent, [
    { event: 'media', streamSid: 'MZ9', media: { payload: 'AAAA' } },
    { event: 'mark', streamSid: 'MZ9', mark: { name: 'greeting' } },
    { event: 'clear', streamSid: 'MZ9' },
  ]);

  assert.throws(() => session.sendAudio('not base64!'), (err) => err.status === 400);
  assert.throws(() => session.sendAudio(''), (err) => err.status === 400);

  const closed = session.close('bye');
  assert.equal(closed, 'stopped');
  assert.equal(session.close('again'), 'stopped');

  // A session with no socket must never pretend a write succeeded.
  const offline = new MediaStreamSession();
  offline.receive({ event: 'start', streamSid: 'MZ0', start: { callSid: 'CA0' } });
  assert.throws(() => offline.sendAudio('AAAA'), (err) => err.status === 409 && err.message === 'stream_socket_unavailable');
  assert.throws(() => offline.clear(), (err) => err.status === 409 && err.message === 'stream_socket_unavailable');

  // Writes before the stream starts are refused.
  const fresh = new MediaStreamSession({ socket });
  assert.throws(() => fresh.sendAudio('AAAA'), (err) => err.status === 409 && err.message === 'stream_not_started');
});

test('the media-stream module declares the known protocol event set', () => {
  assert.deepEqual([...MEDIA_EVENTS], ['connected', 'start', 'media', 'dtmf', 'stop', 'mark']);
});
