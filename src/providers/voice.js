import { config } from '../config.js';
import { HttpError } from '../lib/errors.js';
import { FakeVoiceProvider } from './fakeVoice.js';

// Provider registry for the real-time voice dialer. Only the offline "fake"
// adapter ships today. `liveEnabled` is hardcoded false in config, so even if a
// real adapter were registered here it could not be selected — this is the
// structural guarantee that Phase 0 never places a real call.
export const VOICE_PROVIDERS = Object.freeze({
  fake: FakeVoiceProvider,
});

export function createVoiceProvider(cfg = config) {
  const name = String(cfg.provider ?? 'fake');
  const Provider = VOICE_PROVIDERS[name];
  if (!Provider) throw new HttpError(400, 'unknown_voice_provider', { provider: name });
  if (cfg.liveEnabled) throw new HttpError(400, 'live_voice_disabled');
  return new Provider(cfg);
}
