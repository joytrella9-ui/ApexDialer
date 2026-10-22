// Speech-to-text boundary. The fake adapter decodes no audio: callers supply the
// scripted utterance the "audio" is meant to contain, which keeps the voice-turn
// tests deterministic. A real adapter (Deepgram/Whisper/etc.) would implement
// `transcribe` against real audio frames and populate confidence.
export function normalizeTranscript(text) {
  return String(text ?? '').trim();
}

export class FakeSttProvider {
  constructor() {
    this.name = 'fake-stt';
    this.queue = [];
  }

  // Script the next utterance the fake "hears".
  pushUtterance(text) {
    this.queue.push(normalizeTranscript(text));
    return this;
  }

  // Audio is accepted for shape compatibility but never decoded.
  transcribe({ audio = null } = {}) {
    const text = this.queue.length ? this.queue.shift() : '';
    return {
      text,
      confidence: text ? 1 : 0,
      provider: this.name,
      final: true,
      audioBytes: countAudioBytes(audio),
    };
  }
}

function countAudioBytes(audio) {
  if (!audio) return 0;
  if (typeof audio === 'string') return audio.length;
  if (typeof audio.byteLength === 'number') return audio.byteLength;
  if (Array.isArray(audio)) return audio.length;
  return 0;
}
