import WebSocket from 'ws';
import { HttpError } from '../lib/errors.js';
import { buildRealtimeTools, isAllowedTool } from './aiTools.js';

// =============================================================================
// GPT-LIVE WEBSOCKET BRIDGE (offline protocol + lifecycle; NOT registered)
// =============================================================================
// Reference: OpenAI GPT-Live docs ("WebSockets", "Telephony and SIP",
// "Delegation and tools"). Primary connection:
//   wss://api.openai.com/v1/live/sessions  (Authorization: Bearer <server key>)
//   1. first message: session.start { session: { model, instructions, audio, delegation } }
//   2. wait for session.started before sending audio
//   3. session.input_audio.append (base64 raw audio, no container)
//   4. session.output_audio.delta (base64) for playback
//   5. Responses delegation: function calls arrive as response.event envelopes
//      whose nested event is response.output_item.done (item.type = function_call);
//      results return via response.item.create (function_call_output) followed by
//      response.create.
//   6. session.close, then wait for session.closed before releasing the socket.
//
// Telephony audio: audio.format { type: 'audio/pcmu', rate: 8000 } is G.711 mu-law,
// the same codec Twilio Media Streams sends, so frames are forwarded without
// transcoding. Input and output share one fixed format for the session.
//
// IMPORTANT COMPLIANCE LIMIT: the GPT-Live voice model generates its own speech.
// The approved-line tool only controls what the backend tool path says; it does NOT
// guarantee verbatim script delivery over this API. Treat AI speech content as an
// open compliance question for counsel before any live use.
//
// Safety properties: no network access happens at import time or in any function
// except the explicit `connectLiveSocket`, which requires a server-side key, wss://
// (loopback ws:// only when a test opts in), and a timeout. Nothing in the app
// calls it while live calling is disabled.
export const LIVE_WS_URL = 'wss://api.openai.com/v1/live/sessions';
export const LIVE_VOICE_MODEL = 'gpt-live-1';
export const LIVE_TELEPHONY_FORMAT = Object.freeze({ type: 'audio/pcmu', rate: 8000 });
export const MAX_AUDIO_CHUNK_BYTES = 960; // 120 ms of 8 kHz G.711 (one byte per sample)
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const MAX_OUTPUT_AUDIO_CHARS = 16 * 1024; // base64 characters per output frame
export const MAX_INSTRUCTIONS = 4000;
export const MAX_OUTPUT_TEXT = 4000;
export const MAX_EVENT_CHARS = 256 * 1024;
const MAX_SEEN_EVENTS = 2000;
const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function requireName(value, field) {
  const text = String(value ?? '').trim();
  if (!NAME.test(text)) throw new HttpError(400, 'invalid_live_config', { field });
  return text;
}

// Build the session.start message. The backend model must be configured explicitly
// (no implicit default), because it determines what the backend can do.
export function buildLiveSessionStart({
  model = LIVE_VOICE_MODEL,
  voice = 'marin',
  instructions = '',
  backendModel,
  backendInstructions = '',
  tools = buildRealtimeTools(),
  eventId = 'session_start',
} = {}) {
  const backend = requireName(backendModel, 'backendModel');
  const voiceModel = requireName(model, 'model');
  const voiceName = requireName(voice, 'voice');
  // Function tools are limited to the server allowlist; no other tool can be advertised.
  const functionTools = tools
    .filter((t) => t?.type === 'function' && isAllowedTool(t.name))
    .map((t) => ({ type: 'function', name: t.name, description: String(t.description ?? ''), parameters: t.parameters }));
  if (functionTools.length === 0) throw new HttpError(400, 'invalid_live_config', { field: 'tools' });
  return {
    type: 'session.start',
    event_id: String(eventId).slice(0, 64),
    session: {
      model: voiceModel,
      instructions: String(instructions ?? '').slice(0, MAX_INSTRUCTIONS),
      audio: { format: { ...LIVE_TELEPHONY_FORMAT }, output: { voice: voiceName } },
      delegation: {
        type: 'responses',
        responses: {
          model: backend,
          instructions: String(backendInstructions ?? '').slice(0, MAX_INSTRUCTIONS),
          tools: functionTools,
          tool_choice: 'auto',
          parallel_tool_calls: false,
        },
      },
    },
  };
}

// --- client events ----------------------------------------------------------
export function encodeAudioAppend(base64) {
  if (typeof base64 !== 'string' || base64.length === 0) throw new HttpError(400, 'invalid_audio_payload');
  if (!BASE64.test(base64)) throw new HttpError(400, 'invalid_audio_payload');
  const bytes = Math.floor((base64.length * 3) / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
  if (bytes <= 0 || bytes > MAX_AUDIO_CHUNK_BYTES) throw new HttpError(400, 'audio_chunk_too_large', { bytes });
  return { type: 'session.input_audio.append', audio: base64 };
}

export function encodeSessionClose(eventId = 'session_close') {
  return { type: 'session.close', event_id: String(eventId).slice(0, 64) };
}

export function encodeFunctionOutput(callId, output = {}, eventId = 'tool_result') {
  const id = String(callId ?? '').slice(0, 200);
  if (!id) throw new HttpError(400, 'missing_call_id');
  let text;
  try {
    text = JSON.stringify(output ?? {});
  } catch {
    text = '{"error":"unserializable_output"}';
  }
  return {
    type: 'response.item.create',
    event_id: String(eventId).slice(0, 64),
    item: { type: 'function_call_output', call_id: id, output: text.slice(0, MAX_OUTPUT_TEXT) },
  };
}

export function encodeResponseCreate(eventId = 'continue') {
  return { type: 'response.create', event_id: String(eventId).slice(0, 64) };
}

// --- server events ----------------------------------------------------------
// Translate one server message into the internal vocabulary used by the
// orchestrator. Unknown types are ignored, never trusted. Tool calls are only
// extracted from completed function items and are validated later by the executor.
export function parseLiveEvent(input) {
  let raw = input;
  if (typeof raw === 'string' || Buffer.isBuffer(raw)) {
    const text = raw.toString();
    if (text.length > MAX_EVENT_CHARS) throw new HttpError(400, 'oversized_live_event');
    try {
      raw = JSON.parse(text);
    } catch {
      throw new HttpError(400, 'invalid_live_event');
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.type !== 'string') {
    throw new HttpError(400, 'invalid_live_event');
  }
  const eventId = typeof raw.event_id === 'string' ? raw.event_id.slice(0, 200) : '';
  const type = raw.type;

  switch (type) {
    case 'session.started':
      return { type: 'session_ready', eventId, sessionId: String(raw.session?.id ?? '').slice(0, 200) };
    case 'session.output_audio.delta': {
      const delta = String(raw.delta ?? '');
      // Oversized output frames are dropped, never truncated: a cut frame is corrupt audio.
      if (delta.length > MAX_OUTPUT_AUDIO_CHARS) return { type: 'ignored', eventId, rawType: 'oversized_audio' };
      return { type: 'audio', eventId, delta };
    }
    case 'session.input_transcript.delta':
      return { type: 'transcript_delta', eventId, role: 'lead', delta: String(raw.delta ?? '').slice(0, MAX_OUTPUT_TEXT) };
    case 'session.output_transcript.delta':
      return { type: 'transcript_delta', eventId, role: 'ai', delta: String(raw.delta ?? '').slice(0, MAX_OUTPUT_TEXT) };
    case 'session.delegation.created':
      return {
        type: 'delegation_created',
        eventId,
        delegationId: String(raw.delegation?.id ?? '').slice(0, 200),
        target: String(raw.delegation?.target ?? '').slice(0, 40),
      };
    case 'response.event': {
      const nested = raw.event;
      if (!nested || typeof nested !== 'object' || typeof nested.type !== 'string') {
        return { type: 'ignored', eventId, rawType: type };
      }
      if (nested.type === 'response.output_item.done' && nested.item?.type === 'function_call') {
        const name = String(nested.item.name ?? '').slice(0, 64);
        let args = null;
        let parseError = false;
        if (typeof nested.item.arguments === 'string') {
          try {
            args = nested.item.arguments.trim() === '' ? {} : JSON.parse(nested.item.arguments);
          } catch {
            parseError = true;
          }
        } else if (nested.item.arguments && typeof nested.item.arguments === 'object') {
          args = nested.item.arguments;
        }
        return {
          type: 'tool_call',
          eventId,
          delegationId: String(raw.delegation_id ?? '').slice(0, 200),
          callId: String(nested.item.call_id ?? '').slice(0, 200),
          name,
          allowed: isAllowedTool(name),
          arguments: args,
          parseError,
        };
      }
      return { type: 'backend_event', eventId, rawType: String(nested.type).slice(0, 80) };
    }
    case 'session.closed':
      return { type: 'session_closed', eventId };
    case 'error':
      return {
        type: 'provider_error',
        eventId,
        code: String(raw.error?.code ?? 'provider_error').slice(0, 80),
        message: String(raw.error?.message ?? '').slice(0, 200),
        clientEventId: String(raw.error?.client_event_id ?? '').slice(0, 64),
      };
    case 'transport.failed':
      return {
        type: 'provider_error',
        eventId,
        code: String(raw.error?.code ?? 'transport_failed').slice(0, 80),
        message: '',
        clientEventId: '',
      };
    default:
      return { type: 'ignored', eventId, rawType: type.slice(0, 80) };
  }
}

export const LIVE_STATES = Object.freeze(['new', 'starting', 'ready', 'closing', 'closed']);

// Lifecycle wrapper for one primary GPT-Live connection. It implements the same
// method names the orchestrator uses for its realtime leg (start, appendAudio,
// requestResponse, submitToolOutput, ingest, terminate), so it can be injected
// through `realtimeFactory`. Every write fails closed unless the socket is open.
export class LiveSession {
  constructor({
    socket = null,
    sessionStart,
    onEvent = () => {},
    startTimeoutMs = 10000,
    closeTimeoutMs = 15000,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    if (!sessionStart || sessionStart.type !== 'session.start') {
      throw new HttpError(400, 'invalid_live_config');
    }
    this.socket = socket;
    this.sessionStart = sessionStart;
    this.onEvent = typeof onEvent === 'function' ? onEvent : () => {};
    this.startTimeoutMs = startTimeoutMs;
    this.closeTimeoutMs = closeTimeoutMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.state = 'new';
    this.sessionId = '';
    this.seen = new Set();
    this.timer = null;
    this.reason = '';
    this.complete = false;
  }

  #write(message) {
    const socket = this.socket;
    if (!socket || typeof socket.send !== 'function') throw new HttpError(409, 'live_socket_unavailable');
    if (socket.readyState !== undefined && socket.readyState !== WebSocket.OPEN) {
      throw new HttpError(409, 'live_socket_unavailable');
    }
    socket.send(JSON.stringify(message));
  }

  #arm(ms, reason) {
    this.#disarm();
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.#finish(reason, false);
    }, ms);
    this.timer?.unref?.();
  }

  #disarm() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }

  // Mark the session finished, release the socket, and notify the owner once.
  #finish(reason, complete) {
    if (this.state === 'closed') return;
    this.#disarm();
    this.state = 'closed';
    this.reason = String(reason).slice(0, 80);
    this.complete = complete;
    try {
      this.socket?.close?.(1000, this.reason);
    } catch {
      // best effort
    }
    this.onEvent({ type: 'live_socket_closed', reason: this.reason, complete });
  }

  start() {
    if (this.state !== 'new') throw new HttpError(409, 'live_already_started');
    this.#write(this.sessionStart);
    this.state = 'starting';
    this.#arm(this.startTimeoutMs, 'session_start_timeout');
    return this;
  }

  // Forward one caller audio chunk (base64 G.711 mu-law from the telephony leg).
  appendAudio(base64) {
    if (this.state !== 'ready') throw new HttpError(409, 'live_not_ready');
    this.#write(encodeAudioAppend(base64));
  }

  // Responses delegation continues backend work only after tool results; a bare
  // response.create at connect time is unnecessary, so this is a no-op here.
  requestResponse() {
    return this;
  }

  // Return a tool result, then ask the backend to continue (Responses delegation).
  submitToolOutput(callId, output = {}) {
    if (this.state !== 'ready') throw new HttpError(409, 'live_not_ready');
    this.#write(encodeFunctionOutput(callId, output));
    this.#write(encodeResponseCreate());
  }

  // Apply one server message. Duplicate event_ids (replays) are ignored.
  ingest(input) {
    const event = parseLiveEvent(input);
    if (event.eventId) {
      if (this.seen.has(event.eventId)) return { type: 'ignored', reason: 'duplicate', eventId: event.eventId };
      this.seen.add(event.eventId);
      if (this.seen.size > MAX_SEEN_EVENTS) this.seen.delete(this.seen.values().next().value);
    }
    if (event.type === 'session_ready' && this.state === 'starting') {
      this.state = 'ready';
      this.sessionId = event.sessionId;
      this.#disarm();
    } else if (event.type === 'provider_error' && this.state === 'starting') {
      this.#finish('provider_error_at_start', false);
    } else if (event.type === 'session_closed') {
      this.#finish('session_closed', true);
    }
    return event;
  }

  // Graceful close: ask the server to finalize, then wait for session.closed. If it
  // never arrives, the call is recorded as incomplete finalization.
  close(reason = 'orchestrator_cleanup') {
    if (this.state === 'closed') return this.state;
    if (this.state === 'ready') {
      this.#write(encodeSessionClose());
      this.state = 'closing';
      this.#arm(this.closeTimeoutMs, 'close_timeout');
      this.reason = String(reason).slice(0, 80);
      return this.state;
    }
    this.#finish(reason, false);
    return this.state;
  }

  terminate(reason = 'orchestrator_cleanup') {
    return this.close(reason);
  }

  // Called when the transport drops without a graceful session.closed.
  onSocketClosed() {
    this.#finish('socket_closed', false);
  }
}

// Attach a raw socket's events to a LiveSession. Works with `ws` sockets and any
// object that exposes on(event, handler).
export function attachLiveSocket(socket, live) {
  socket.on('message', (data) => {
    try {
      live.ingest(data.toString());
    } catch {
      // Malformed server messages are dropped; they never change session state.
    }
  });
  socket.on('close', () => live.onSocketClosed());
  socket.on('error', () => live.onSocketClosed());
  return live;
}

// Realtime-leg factory for the orchestrator. The session.start message is built
// once from configuration (failing early on a missing backend model). The factory
// is never registered in the live voice stack.
export function createLiveRealtimeFactory(voiceCfg, { startTimeoutMs, closeTimeoutMs } = {}) {
  const sessionStart = buildLiveSessionStart({
    model: voiceCfg.liveModel,
    voice: voiceCfg.liveVoice,
    instructions: voiceCfg.aiDisclosure,
    backendModel: voiceCfg.liveBackendModel,
    backendInstructions:
      'You are the backend for an automated outbound assistant. Use only the provided tools. ' +
      'Never invent offers, prices, or commitments. Call opt_out as soon as the caller asks to stop. ' +
      'Call end_call when the conversation is complete.',
  });
  return ({ socket, onEvent }) => new LiveSession({ socket, sessionStart, onEvent, startTimeoutMs, closeTimeoutMs });
}

// Open a primary GPT-Live connection with the server-side key. Only wss:// is
// accepted; loopback ws:// is available solely to tests that opt in. The API key
// is never included in errors or logs.
export async function connectLiveSocket({
  apiKey = '',
  url = LIVE_WS_URL,
  timeoutMs = 10000,
  allowLoopbackForTests = false,
  WebSocketImpl = WebSocket,
} = {}) {
  const key = String(apiKey ?? '');
  if (key.length < 8) throw new HttpError(400, 'provider_not_configured');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new HttpError(400, 'invalid_url');
  }
  const loopback = ['127.0.0.1', 'localhost'].includes(parsed.hostname);
  const secure = parsed.protocol === 'wss:';
  if (!secure && !(allowLoopbackForTests && loopback && parsed.protocol === 'ws:')) {
    throw new HttpError(400, 'insecure_live_url');
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = new WebSocketImpl(parsed.toString(), {
      headers: { Authorization: `Bearer ${key}` },
      handshakeTimeout: timeoutMs,
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.terminate?.();
      reject(new HttpError(502, 'live_connect_timeout'));
    }, timeoutMs);
    socket.once('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('unexpected-response', (_req, res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.terminate?.();
      reject(new HttpError(502, 'live_connect_rejected', { status: res?.statusCode ?? 0 }));
    });
    socket.once('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new HttpError(502, 'live_connect_failed'));
    });
  });
}
