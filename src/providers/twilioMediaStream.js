import { z } from 'zod';
import { HttpError } from '../lib/errors.js';

// =============================================================================
// TWILIO BIDIRECTIONAL MEDIA STREAMS BOUNDARY (offline, transport-injected)
// =============================================================================
// Protocol reference: https://www.twilio.com/docs/voice/media-streams/websocket-messages
// Twilio sends `connected`, `start`, `media`, `dtmf`, `stop` and (bidirectional
// only) `mark` over a WebSocket. This module validates and normalizes those
// messages and models the connection lifecycle. It opens NO socket: the caller
// injects a `socket` (real WebSocket in production, a fake in tests), so nothing
// here can reach a carrier.
export const MEDIA_EVENTS = Object.freeze(['connected', 'start', 'media', 'dtmf', 'stop', 'mark']);

// Twilio media payloads are base64-encoded audio/x-mulaw. Typical chunks are a few
// hundred bytes; cap well above that so a hostile/oversized frame is rejected.
export const MAX_MEDIA_PAYLOAD = 16 * 1024;
export const MAX_MESSAGE_CHARS = 64 * 1024;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const DTMF_DIGIT = /^[0-9*#]$/;

const sequenceNumber = z.union([z.string().trim().max(20), z.number()]).optional();
const streamSid = z.string().trim().min(1).max(200);

const startInner = z
  .object({
    streamSid: z.string().trim().max(200).optional(),
    accountSid: z.string().trim().max(64).optional(),
    callSid: z.string().trim().min(1).max(64),
    tracks: z.array(z.string().trim().max(32)).max(8).optional(),
    customParameters: z.record(z.string().max(512)).optional(),
    mediaFormat: z
      .object({
        encoding: z.string().trim().max(64).optional(),
        sampleRate: z.number().int().positive().max(96000).optional(),
        channels: z.number().int().positive().max(8).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const mediaMessageSchema = z.discriminatedUnion('event', [
  z
    .object({
      event: z.literal('connected'),
      protocol: z.string().trim().max(64).optional(),
      version: z.string().trim().max(64).optional(),
    })
    .strict(),
  z
    .object({
      event: z.literal('start'),
      sequenceNumber,
      streamSid: streamSid.optional(),
      start: startInner,
    })
    .strict(),
  z
    .object({
      event: z.literal('media'),
      sequenceNumber,
      streamSid,
      media: z
        .object({
          track: z.enum(['inbound', 'outbound']).optional(),
          chunk: z.union([z.string().trim().max(20), z.number()]).optional(),
          timestamp: z.union([z.string().trim().max(20), z.number()]).optional(),
          payload: z.string().max(MAX_MEDIA_PAYLOAD).regex(BASE64),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      event: z.literal('dtmf'),
      sequenceNumber,
      streamSid,
      dtmf: z.object({ digit: z.string().trim().regex(DTMF_DIGIT) }).strict(),
    })
    .strict(),
  z
    .object({
      event: z.literal('stop'),
      sequenceNumber,
      streamSid: streamSid.optional(),
      stop: z
        .object({
          accountSid: z.string().trim().max(64).optional(),
          callSid: z.string().trim().max(64).optional(),
          reason: z.string().trim().max(200).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      event: z.literal('mark'),
      sequenceNumber,
      streamSid,
      mark: z.object({ name: z.string().trim().max(64) }).strict(),
    })
    .strict(),
]);

function invalid(event) {
  return new HttpError(400, 'invalid_media_message', { event: String(event ?? '') });
}

// Parse + validate a raw Twilio message (object or JSON string) into a small,
// typed internal shape. Oversized, malformed, or unknown-event payloads fail
// closed (unknown event names are surfaced as `{type:'unknown'}` to ignore).
export function parseMediaMessage(input) {
  let raw = input;
  if (typeof raw === 'string') {
    if (raw.length > MAX_MESSAGE_CHARS) throw invalid('oversized');
    try {
      raw = JSON.parse(raw);
    } catch {
      throw invalid('unparseable');
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('non_object');
  if (!MEDIA_EVENTS.includes(raw.event)) {
    return { type: 'unknown', event: String(raw.event ?? '').slice(0, 64) };
  }
  const parsed = mediaMessageSchema.safeParse(raw);
  if (!parsed.success) throw invalid(raw.event);
  const msg = parsed.data;
  switch (msg.event) {
    case 'connected':
      return { type: 'connected', protocol: msg.protocol ?? '', version: msg.version ?? '' };
    case 'start':
      return {
        type: 'start',
        streamSid: msg.streamSid ?? msg.start.streamSid ?? '',
        callSid: msg.start.callSid,
        accountSid: msg.start.accountSid ?? '',
        tracks: msg.start.tracks ?? [],
        customParameters: msg.start.customParameters ?? {},
        mediaFormat: msg.start.mediaFormat ?? {},
      };
    case 'media':
      return {
        type: 'media',
        streamSid: msg.streamSid,
        track: msg.media.track ?? 'inbound',
        payload: msg.media.payload,
        chunk: String(msg.media.chunk ?? ''),
        timestamp: String(msg.media.timestamp ?? ''),
      };
    case 'dtmf':
      return { type: 'dtmf', streamSid: msg.streamSid, digit: msg.dtmf.digit };
    case 'stop':
      return {
        type: 'stop',
        streamSid: msg.streamSid ?? '',
        callSid: msg.stop.callSid ?? '',
        reason: msg.stop.reason ?? '',
      };
    case 'mark':
      return { type: 'mark', streamSid: msg.streamSid, name: msg.mark.name };
    default:
      return { type: 'unknown', event: String(msg.event) };
  }
}

export const STREAM_STATES = Object.freeze(['idle', 'connecting', 'streaming', 'stopped']);

// Connection lifecycle for one bidirectional stream. Enforces ordering
// (connected -> start -> media/dtmf/mark -> stop) and fails closed on duplicate
// starts or messages that arrive before the stream is established. All writes go
// through an injected socket; with no socket, writes throw rather than silently
// dropping so a live path can never appear to work without a real transport.
export class MediaStreamSession {
  constructor({ socket = null, onEvent = () => {}, now = () => Date.now() } = {}) {
    this.socket = socket;
    this.onEvent = typeof onEvent === 'function' ? onEvent : () => {};
    this.now = now;
    this.state = 'idle';
    this.streamSid = null;
    this.callSid = null;
    this.lastMark = null;
    this.closed = false;
  }

  // Ingest one message from Twilio. Returns the normalized message.
  receive(input) {
    const msg = parseMediaMessage(input);
    switch (msg.type) {
      case 'connected':
        if (this.state === 'idle') this.state = 'connecting';
        break;
      case 'start':
        if (this.state === 'streaming' || this.streamSid) {
          throw new HttpError(409, 'duplicate_stream_start');
        }
        this.streamSid = msg.streamSid || this.streamSid;
        this.callSid = msg.callSid;
        this.state = 'streaming';
        break;
      case 'media':
      case 'dtmf':
        if (this.state !== 'streaming') throw new HttpError(409, 'message_before_start');
        break;
      case 'mark':
        this.lastMark = msg.name;
        break;
      case 'stop':
        this.state = 'stopped';
        this.closed = true;
        break;
      default:
        break;
    }
    this.onEvent(msg);
    return msg;
  }

  // Send agent audio (base64 mulaw) back to Twilio.
  sendAudio(payload, { streamSid = this.streamSid } = {}) {
    this.#requireStreaming();
    if (typeof payload !== 'string' || payload.length === 0 || payload.length > MAX_MEDIA_PAYLOAD || !BASE64.test(payload)) {
      throw new HttpError(400, 'invalid_media_payload');
    }
    this.#write({ event: 'media', streamSid, media: { payload } });
  }

  // Barge-in: discard audio Twilio has buffered for playback.
  clear() {
    this.#requireStreaming();
    this.#write({ event: 'clear', streamSid: this.streamSid });
  }

  // Mark a point in the outbound media; Twilio echoes a `mark` when reached.
  sendMark(name) {
    this.#requireStreaming();
    this.#write({ event: 'mark', streamSid: this.streamSid, mark: { name: String(name).slice(0, 64) } });
  }

  close(reason = '') {
    if (this.closed) return this.state;
    this.state = 'stopped';
    this.closed = true;
    try {
      this.socket?.close?.(1000, reason);
    } catch {
      // best-effort socket teardown
    }
    this.onEvent({ type: 'stream_closed', reason: String(reason).slice(0, 200) });
    return this.state;
  }

  #requireStreaming() {
    if (this.state !== 'streaming') throw new HttpError(409, 'stream_not_started');
  }

  #write(message) {
    if (!this.socket || typeof this.socket.send !== 'function') {
      throw new HttpError(409, 'stream_socket_unavailable');
    }
    this.socket.send(JSON.stringify(message));
  }
}
