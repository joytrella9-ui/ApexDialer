import { HttpError } from '../lib/errors.js';

// =============================================================================
// MANDATORY AUDIO (deterministic, provider-independent)
// =============================================================================
// Required statements (for example an AI-identity disclosure) must be played as
// approved audio, not as model-generated speech. This registry holds approved
// frames: base64 G.711 mu-law at 8 kHz, the telephony format used by Media Streams.
//
// Production ships with NO assets. Without an approved asset the registry throws
// `mandatory_audio_unavailable` and the call cannot proceed (fail closed).
// Wording, language, timing, and the recording itself require counsel approval;
// nothing in this repository provides approved wording or a production recording.
//
// The orchestrator plays a key by streaming its frames, then sending a Media Streams
// `mark`. The AI session is opened only after the provider echoes that mark, which
// means the audio was reached on the carrier side, not merely queued locally.
export const MANDATORY_AUDIO_KEYS = Object.freeze(['disclosure']);
export const MANDATORY_MARK = 'mandatory_audio_end';
export const MAX_MANDATORY_FRAMES = 500;
export const MAX_FRAME_BASE64 = 2048;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export function createMandatoryAudioRegistry(assets = {}) {
  const store = new Map();
  for (const [key, asset] of Object.entries(assets ?? {})) {
    if (!MANDATORY_AUDIO_KEYS.includes(key)) throw new Error(`unknown mandatory audio key: ${key}`);
    const frames = Array.isArray(asset?.frames) ? asset.frames : null;
    if (!frames || frames.length === 0 || frames.length > MAX_MANDATORY_FRAMES) {
      throw new Error(`mandatory audio "${key}" needs 1..${MAX_MANDATORY_FRAMES} frames`);
    }
    for (const f of frames) {
      if (typeof f !== 'string' || f.length === 0 || f.length > MAX_FRAME_BASE64 || !BASE64.test(f)) {
        throw new Error(`mandatory audio "${key}" has an invalid frame`);
      }
    }
    store.set(key, { frames: frames.slice(), synthetic: asset.synthetic === true, label: String(asset.label ?? '').slice(0, 120) });
  }

  return {
    // Frames for playback. Throws (fail closed) when the key has no approved asset.
    frames(key) {
      const asset = store.get(key);
      if (!asset) throw new HttpError(503, 'mandatory_audio_unavailable', { key });
      return asset.frames.slice();
    },
    // Safe description for diagnostics: never returns frame data.
    describe() {
      return MANDATORY_AUDIO_KEYS.map((key) => {
        const asset = store.get(key);
        return {
          key,
          available: Boolean(asset),
          synthetic: asset ? asset.synthetic : false,
          frameCount: asset ? asset.frames.length : 0,
        };
      });
    },
  };
}

// Used when no approved asset is configured. Every playback is refused.
export const EMPTY_MANDATORY_AUDIO = createMandatoryAudioRegistry({});
