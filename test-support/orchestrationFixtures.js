import { createMandatoryAudioRegistry, MANDATORY_MARK } from '../src/services/mandatoryAudio.js';

// SYNTHETIC TEST FIXTURE. The frames are G.711 mu-law silence (0xFF). They are not
// approved disclosure wording and not a recording of any statement. They exist only
// to exercise the gate. Production must supply counsel-approved audio.
export function syntheticDisclosureRegistry() {
  return createMandatoryAudioRegistry({
    disclosure: {
      label: 'SYNTHETIC TEST FIXTURE: silence, no approved wording',
      synthetic: true,
      frames: Array.from({ length: 4 }, () => Buffer.alloc(160, 0xff).toString('base64')),
    },
  });
}

// Simulate the carrier echoing the disclosure mark (the event-driven signal the
// orchestrator waits for). Same shape Twilio uses for inbound mark messages.
export function playDisclosure(call) {
  return call.onMedia({ event: 'mark', streamSid: `SS${call.sessionId}`, mark: { name: MANDATORY_MARK } });
}
