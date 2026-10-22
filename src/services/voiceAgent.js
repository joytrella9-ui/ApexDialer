import { resolveIvrInput } from './ivr.js';
import { classifyIntent, INTENT_ROUTES } from './ai.js';

// Deterministic, offline conversational state machine for the voice dialer. It is
// pure: given the current state, an event, and the script/config, it returns the
// next state and the lines the agent should speak. It contacts no model and
// synthesizes no audio — a real integration would replace this with streaming
// STT/LLM/TTS while preserving the same event/outcome contract.
export const VOICE_PHASES = Object.freeze({
  GREETING: 'greeting',
  AWAITING: 'awaiting',
  COLLECTING_CALLBACK: 'collecting_callback',
  TRANSFERRING: 'transferring',
  ENDED: 'ended',
});

// Outcomes a voice session can produce, mapped onto the campaign disposition
// vocabulary by the session service.
export const VOICE_OUTCOMES = Object.freeze([
  'completed',
  'connected',
  'callback',
  'opted_out',
  'unanswered',
  'failed',
]);

export const VOICE_EVENT_TYPES = Object.freeze([
  'speech',
  'dtmf',
  'silence',
  'interrupt',
  'stream_disconnected',
  'provider_error',
]);

export function initialVoiceState() {
  return {
    phase: VOICE_PHASES.GREETING,
    turns: 0,
    silence: 0,
    invalid: 0,
    disclosurePlayed: false,
    ended: false,
    outcome: null,
    reason: '',
  };
}

// Script text is templated from configuration only; the agent never invents
// facts about the business or the lead.
export function voiceScript({ businessName = 'ApexDialer Demo', purpose = 'follow up on your recent inquiry' } = {}) {
  return {
    greeting: `Hello, this is an automated assistant calling on behalf of ${businessName} to ${purpose}. Do you have a moment?`,
    disclosure: 'This is an automated call. You can say "stop" at any time to opt out.',
    reprompt:
      'Sorry, I did not catch that. Would you like to hear more, request a callback, or speak with a representative?',
    callbackPrompt: 'Understood. When would be a good time for us to call you back?',
    transfer: 'Of course, transferring you to a representative now.',
    goodbye: 'Thank you for your time. Goodbye.',
    optOut: 'I am sorry to have bothered you. I have added you to our do-not-call list.',
  };
}

// Lines spoken when the call connects. Playing the disclosure transitions the
// agent from `greeting` to `awaiting` a caller response.
export function greetingAction(script = voiceScript()) {
  return {
    say: [script.disclosure, script.greeting],
    state: { ...initialVoiceState(), phase: VOICE_PHASES.AWAITING, disclosurePlayed: true },
  };
}

function finish(state, outcome, reason, say) {
  return {
    state: { ...state, phase: VOICE_PHASES.ENDED, ended: true, outcome: outcome ?? null, reason },
    say,
    end: true,
    outcome: outcome ?? null,
    reason,
  };
}

export function processVoiceEvent(state, event, ctx = {}) {
  const script = ctx.script ?? voiceScript(ctx);
  const maxTurns = ctx.maxTurns ?? 8;
  const maxSilenceRetries = ctx.maxSilenceRetries ?? 2;
  const maxInvalid = ctx.maxInvalid ?? 2;
  const s = { ...state };
  const say = [];
  const type = event?.type;

  if (type === 'provider_error') return finish(s, 'failed', 'provider_error', []);
  if (type === 'stream_disconnected') return finish(s, null, 'stream_disconnected', []);

  // Barge-in: caller spoke over the agent; keep listening, do not consume a turn.
  if (type === 'interrupt') {
    return { state: { ...s, phase: VOICE_PHASES.AWAITING }, say: [], end: false, outcome: null, reason: 'barge_in' };
  }

  if (s.turns >= maxTurns) return finish(s, 'unanswered', 'max_turns', []);
  s.turns += 1;

  if (type === 'silence') {
    s.silence += 1;
    if (s.silence > maxSilenceRetries) return finish(s, 'unanswered', 'no_response', say);
    say.push(script.reprompt);
    return { state: { ...s, phase: VOICE_PHASES.AWAITING }, say, end: false, outcome: null, reason: 'silence' };
  }

  if (type === 'dtmf') {
    const resolved = resolveIvrInput({ digit: event.digit, attempt: s.invalid });
    if (resolved.valid && resolved.outcome) return finish(s, resolved.outcome, `dtmf:${resolved.route}`, say);
    s.invalid += 1;
    if (s.invalid > maxInvalid) return finish(s, 'unanswered', 'invalid_input', say);
    say.push(script.reprompt);
    return { state: { ...s, phase: VOICE_PHASES.AWAITING }, say, end: false, outcome: null, reason: 'invalid_dtmf' };
  }

  if (type === 'speech') {
    const intent = classifyIntent(event.text);
    if (intent === 'unknown') {
      s.invalid += 1;
      if (s.invalid > maxInvalid) return finish(s, 'unanswered', 'no_understanding', say);
      say.push(script.reprompt);
      return { state: { ...s, phase: VOICE_PHASES.AWAITING }, say, end: false, outcome: null, reason: 'unknown_intent' };
    }
    if (intent === 'callback') {
      if (s.phase !== VOICE_PHASES.COLLECTING_CALLBACK) {
        say.push(script.callbackPrompt);
        return {
          state: { ...s, phase: VOICE_PHASES.COLLECTING_CALLBACK },
          say,
          end: false,
          outcome: null,
          reason: 'callback_prompt',
        };
      }
      return finish(s, 'callback', 'callback_requested', say);
    }
    const route = INTENT_ROUTES[intent] ?? INTENT_ROUTES.unknown;
    return finish(s, route.outcome, `intent:${intent}`, say);
  }

  s.invalid += 1;
  if (s.invalid > maxInvalid) return finish(s, 'unanswered', 'invalid_event', say);
  say.push(script.reprompt);
  return { state: { ...s, phase: VOICE_PHASES.AWAITING }, say, end: false, outcome: null, reason: 'invalid_event' };
}
