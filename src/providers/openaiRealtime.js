import { HttpError } from '../lib/errors.js';
import { buildRealtimeTools, isAllowedTool, AI_TOOL_NAMES } from './aiTools.js';

// =============================================================================
// OPENAI REALTIME ADAPTER (offline, transport-injected)
// =============================================================================
// Reference: https://platform.openai.com/docs/guides/realtime-conversations and
// the Realtime server/client event reference. This module builds the session
// configuration and translates server events into the internal voice-event
// vocabulary; it opens NO WebSocket. A `socket` is injected (real in production,
// a fake in tests). The model's tools are pinned to the local allowlist, so the
// adapter can never expose an action the server does not implement.
export const REALTIME_DEFAULT_MODEL = 'gpt-realtime';
export const REALTIME_DEFAULT_VOICE = 'alloy';
export const AUDIO_FORMATS = Object.freeze(['pcm16', 'g711_ulaw', 'g711_alaw']);
export const MAX_INSTRUCTIONS = 4000;
export const MAX_TEXT = 4000;
export const MAX_AUDIO_DELTA = 32 * 1024;
export const MAX_EVENT_CHARS = 128 * 1024;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function assertFormat(fmt, field) {
  if (!AUDIO_FORMATS.includes(fmt)) {
    throw new HttpError(400, 'unsupported_audio_format', { field, format: String(fmt ?? '') });
  }
  return fmt;
}

// Build the `session.update` payload. Security-relevant inputs are validated:
// tools are pinned to the allowlist (an unknown tool name is rejected), the voice
// and formats are enumerated, and instructions are length-capped. Everything is
// passed through `tool_choice: 'auto'` — the server still validates every call.
export function buildRealtimeSessionConfig({
  model = REALTIME_DEFAULT_MODEL,
  voice = REALTIME_DEFAULT_VOICE,
  instructions = '',
  toolNames = AI_TOOL_NAMES,
  inputFormat = 'g711_ulaw',
  outputFormat = 'g711_ulaw',
  transcription = { model: 'whisper-1' },
  turnDetection = { type: 'server_vad', silence_duration_ms: 700, prefix_padding_ms: 300 },
  maxResponseOutputTokens = 512,
} = {}) {
  const allowed = new Set(AI_TOOL_NAMES);
  const selected = [...toolNames];
  for (const name of selected) {
    if (!allowed.has(name)) throw new HttpError(400, 'tool_not_allowed', { tool: String(name) });
  }
  assertFormat(inputFormat, 'input');
  assertFormat(outputFormat, 'output');

  const tools = buildRealtimeTools().filter((t) => selected.includes(t.name));
  const text = String(instructions ?? '').slice(0, MAX_INSTRUCTIONS);
  const voiceName = String(voice ?? REALTIME_DEFAULT_VOICE).slice(0, 40);
  const modelName = String(model ?? REALTIME_DEFAULT_MODEL).slice(0, 64);

  return {
    type: 'session.update',
    session: {
      type: 'realtime',
      model: modelName,
      instructions: text,
      output_modalities: ['audio'],
      tools,
      tool_choice: 'auto',
      max_response_output_tokens: Math.min(Math.max(Number(maxResponseOutputTokens) || 512, 1), 4096),
      audio: {
        input: {
          format: { type: `audio/${inputFormat}` },
          turn_detection: {
            type: 'server_vad',
            silence_duration_ms: Math.min(Math.max(Number(turnDetection?.silence_duration_ms) || 700, 100), 5000),
            prefix_padding_ms: Math.min(Math.max(Number(turnDetection?.prefix_padding_ms) || 300, 0), 5000),
          },
          transcription: { model: String(transcription?.model ?? 'whisper-1').slice(0, 64) },
        },
        output: {
          format: { type: `audio/${outputFormat}` },
          voice: voiceName,
        },
      },
    },
  };
}

function requireBase64(payload) {
  if (typeof payload !== 'string' || payload.length === 0 || payload.length > MAX_AUDIO_DELTA || !BASE64.test(payload)) {
    throw new HttpError(400, 'invalid_audio_payload');
  }
  return payload;
}

// --- Client events (server <- us) ------------------------------------------
export function encodeAudioAppend(payload) {
  return { type: 'input_audio_buffer.append', audio: requireBase64(payload) };
}
export function buildAudioCommit() {
  return { type: 'input_audio_buffer.commit' };
}
export function buildAudioClear() {
  return { type: 'input_audio_buffer.clear' };
}
export function buildResponseCreate() {
  return { type: 'response.create' };
}
export function buildResponseCancel() {
  return { type: 'response.cancel' };
}
// Deliver the result of a server-side tool call back to the model conversation.
export function buildToolOutput(callId, output = {}) {
  const id = String(callId ?? '').slice(0, 200);
  if (!id) throw new HttpError(400, 'missing_call_id');
  let payload;
  try {
    payload = JSON.stringify(output ?? {});
  } catch {
    payload = JSON.stringify({ error: 'unserializable_output' });
  }
  return {
    type: 'conversation.item.create',
    item: { type: 'function_call_output', call_id: id, output: payload.slice(0, MAX_TEXT) },
  };
}

// --- Server events (us <- server) ------------------------------------------
export const REALTIME_SERVER_EVENT_MAP = Object.freeze({
  'session.created': 'session_ready',
  'session.updated': 'session_ready',
  'input_audio_buffer.speech_started': 'interrupt',
  'input_audio_buffer.speech_stopped': 'speech_stopped',
  'input_audio_buffer.timeout_triggered': 'silence',
  'input_audio_buffer.dtmf_event_received': 'dtmf',
  'conversation.item.input_audio_transcription.completed': 'speech',
  'conversation.item.input_audio_transcription.delta': 'transcript_delta',
  'response.output_audio.delta': 'audio',
  'response.audio.delta': 'audio',
  'response.output_audio_transcript.delta': 'transcript_delta',
  'response.audio_transcript.delta': 'transcript_delta',
  'response.function_call_arguments.done': 'tool_call',
  'response.done': 'response_done',
  error: 'provider_error',
});

// Translate one raw server event (object or JSON string) into the internal voice
// vocabulary. Unknown event types are surfaced as `ignored` so a newer provider
// can add events without breaking the loop. Untrusted text is capped.
export function translateRealtimeEvent(input) {
  let raw = input;
  if (typeof raw === 'string') {
    if (raw.length > MAX_EVENT_CHARS) throw new HttpError(400, 'oversized_realtime_event');
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new HttpError(400, 'invalid_realtime_event');
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HttpError(400, 'invalid_realtime_event');
  }
  const rawType = String(raw.type ?? '');
  const kind = REALTIME_SERVER_EVENT_MAP[rawType];
  if (!kind) return { type: 'ignored', rawType };

  switch (kind) {
    case 'session_ready':
      return { type: 'session_ready', sessionId: String(raw.session?.id ?? '').slice(0, 200) };
    case 'interrupt':
      return { type: 'interrupt', reason: 'user_speech', itemId: String(raw.item_id ?? '').slice(0, 200) };
    case 'speech_stopped':
      return { type: 'speech_stopped', itemId: String(raw.item_id ?? '').slice(0, 200) };
    case 'silence':
      return { type: 'silence', reason: 'timeout' };
    case 'dtmf':
      return { type: 'dtmf', digit: String(raw.dtmf ?? raw.digit ?? '').slice(0, 2) };
    case 'speech':
      return { type: 'speech', text: String(raw.transcript ?? '').slice(0, MAX_TEXT), itemId: String(raw.item_id ?? '').slice(0, 200) };
    case 'transcript_delta':
      return { type: 'transcript_delta', delta: String(raw.delta ?? '').slice(0, MAX_TEXT) };
    case 'audio':
      return { type: 'audio', delta: String(raw.delta ?? '').slice(0, MAX_AUDIO_DELTA) };
    case 'tool_call': {
      const name = String(raw.name ?? '').slice(0, 64);
      let parsed = null;
      let parseError = false;
      const argText = raw.arguments;
      if (typeof argText === 'string') {
        try {
          parsed = argText.trim() === '' ? {} : JSON.parse(argText);
        } catch {
          parseError = true;
        }
      } else if (argText && typeof argText === 'object') {
        parsed = argText;
      }
      return {
        type: 'tool_call',
        callId: String(raw.call_id ?? '').slice(0, 200),
        name,
        allowed: isAllowedTool(name),
        arguments: parsed,
        parseError,
      };
    }
    case 'response_done': {
      const status = String(raw.response?.status ?? '').slice(0, 40);
      return { type: 'response_done', status: status || 'completed', reason: status === 'cancelled' ? 'interrupted' : '' };
    }
    case 'provider_error':
      return {
        type: 'provider_error',
        code: String(raw.error?.code ?? 'provider_error').slice(0, 80),
        message: String(raw.error?.message ?? '').slice(0, MAX_TEXT),
      };
    default:
      return { type: 'ignored', rawType };
  }
}

export const REALTIME_STATES = Object.freeze(['new', 'ready', 'active', 'ended']);

// Thin lifecycle wrapper around an injected socket. Mirrors MediaStreamSession:
// every write fails closed without a socket, and inbound events are validated +
// translated before being handed to `onEvent`.
export class RealtimeSession {
  constructor({ socket = null, sessionConfig, onEvent = () => {} } = {}) {
    this.socket = socket;
    this.sessionConfig = sessionConfig ?? buildRealtimeSessionConfig();
    this.onEvent = typeof onEvent === 'function' ? onEvent : () => {};
    this.state = 'new';
    this.closed = false;
  }

  start() {
    if (this.state === 'ended') throw new HttpError(409, 'session_ended');
    this.#write(this.sessionConfig);
    // The injected socket is already connected. Mark ready so caller audio can
    // be forwarded immediately; a later session.created event is a no-op.
    if (this.state === 'new') this.state = 'ready';
    return this;
  }

  appendAudio(payload) {
    this.#write(encodeAudioAppend(payload));
  }

  commitAudio() {
    this.#write(buildAudioCommit());
  }

  requestResponse() {
    this.#write(buildResponseCreate());
  }

  cancelResponse() {
    this.#write(buildResponseCancel());
  }

  submitToolOutput(callId, output) {
    this.#write(buildToolOutput(callId, output));
    this.#write(buildResponseCreate());
  }

  ingest(input) {
    const event = translateRealtimeEvent(input);
    if (event.type === 'session_ready' && this.state === 'new') this.state = 'ready';
    if (event.type === 'audio' || event.type === 'response_done') {
      if (this.state === 'ready') this.state = 'active';
    }
    this.onEvent(event);
    return event;
  }

  terminate(reason = '') {
    if (this.closed) return this.state;
    this.state = 'ended';
    this.closed = true;
    try {
      this.socket?.close?.(1000, String(reason).slice(0, 200));
    } catch {
      // best-effort
    }
    this.onEvent({ type: 'session_ended', reason: String(reason).slice(0, 200) });
    return this.state;
  }

  #write(message) {
    if (this.closed) throw new HttpError(409, 'session_ended');
    if (!this.socket || typeof this.socket.send !== 'function') {
      throw new HttpError(409, 'realtime_socket_unavailable');
    }
    this.socket.send(JSON.stringify(message));
  }
}
