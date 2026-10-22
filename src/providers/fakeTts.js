// Text-to-speech boundary. The fake adapter generates deterministic timing
// metadata only — it produces no audio bytes — so the agent can "speak" in tests
// without any synthesis service. A real adapter (ElevenLabs/OpenAI/Aura/etc.)
// would return real audio and stream it over the audio capability.
export class FakeTtsProvider {
  constructor({ voice = 'fake-voice', msPerWord = 400 } = {}) {
    this.name = 'fake-tts';
    this.voice = voice;
    this.msPerWord = msPerWord;
  }

  synthesize(text) {
    const value = String(text ?? '');
    const words = value.trim() ? value.trim().split(/\s+/).length : 0;
    return {
      text: value,
      voice: this.voice,
      provider: this.name,
      format: 'audio/x-fake-l16',
      sampleRate: 8000,
      durationMs: words * this.msPerWord,
      bytes: 0,
    };
  }
}
