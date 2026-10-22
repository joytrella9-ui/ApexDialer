// Bidirectional audio boundary for the voice dialer. The fake adapter keeps frame
// metadata in memory and opens no socket, so nothing can be streamed to or from a
// real carrier. A real adapter (e.g. Twilio Media Streams) would implement the
// same open/push/drain/close shape over a WebSocket while preserving this API.
export class FakeAudioStream {
  constructor(sid = '') {
    this.sid = sid;
    this.open = true;
    this.closed = false;
    this.inbound = [];
    this.outbound = [];
  }

  // Caller audio arriving from the provider.
  push(frame = {}) {
    if (this.closed) throw new Error('stream_closed');
    this.inbound.push({ seq: this.inbound.length, ...frame });
    return this;
  }

  // Agent audio queued for the provider to play.
  send(frame = {}) {
    if (this.closed) throw new Error('stream_closed');
    this.outbound.push({ seq: this.outbound.length, ...frame });
    return this;
  }

  // Return and clear queued outbound frames (the provider's read side).
  drain() {
    const frames = this.outbound;
    this.outbound = [];
    return frames;
  }

  close(reason = '') {
    this.closed = true;
    this.open = false;
    this.reason = reason;
    return { sid: this.sid, closed: true, reason };
  }
}

export class FakeAudioProvider {
  constructor() {
    this.name = 'fake-audio';
    this.streams = new Map();
  }

  openStream(sid) {
    const stream = new FakeAudioStream(sid);
    this.streams.set(sid, stream);
    return stream;
  }

  closeStream(sid, reason = '') {
    const stream = this.streams.get(sid);
    if (!stream) return null;
    this.streams.delete(sid);
    return stream.close(reason);
  }
}
