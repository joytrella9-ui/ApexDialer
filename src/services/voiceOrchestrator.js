import { config } from '../config.js';
import { HttpError } from '../lib/errors.js';
import { audit } from './auth.js';
import { assessOutboundCall } from './dialerEligibility.js';
import { executeAiToolCall } from './aiToolExecutor.js';
import {
  startVoiceSession,
  handleProviderEvent,
  handleTurn,
  endVoiceSession,
  endActiveVoiceSessions,
  getVoiceSession,
} from './voiceSessions.js';
import { emergencyStopAll } from './campaigns.js';
import { voiceScript } from './voiceAgent.js';
import { MediaStreamSession, parseMediaMessage } from '../providers/twilioMediaStream.js';
import { MANDATORY_MARK, EMPTY_MANDATORY_AUDIO } from './mandatoryAudio.js';
import {
  RealtimeSession,
  buildRealtimeSessionConfig,
  translateRealtimeEvent,
} from '../providers/openaiRealtime.js';

// =============================================================================
// END-TO-END OUTBOUND VOICE ORCHESTRATOR
// =============================================================================
// Single server-side coordinator for one outbound AI call. It ties together the
// pieces that already exist as small modules, in the order the brief requires:
//
//   1. campaign/lead selection      -> caller supplies campaignId + leadId
//   2. fresh fail-closed eligibility -> assessOutboundCall() (ALWAYS enforced here)
//   3. telephony call creation       -> voiceSessions.startVoiceSession()
//   4. authoritative provider events -> handleProviderEvent()
//   5. media-stream lifecycle        -> MediaStreamSession (injected socket)
//   6. realtime session lifecycle    -> RealtimeSession (injected socket)
//   7. validated AI tool execution   -> aiToolExecutor.executeAiToolCall()
//   8. DTMF / interruption handling  -> media 'dtmf' -> handleTurn; realtime interrupt -> media.clear()
//   9. outcome / opt-out / cleanup   -> finalizeSession/endVoiceSession + stream teardown
//  10. auditing + emergency stop      -> audit() + orchestrator.emergencyStop()
//
// Every transport is injected. With the shipped defaults there is NO socket and
// NO network stack, so this coordinator cannot reach a carrier or a model: it
// fails closed (writes throw) until a real transport is deliberately supplied.
// The compliance gate is enforced unconditionally (it does not depend on the
// `requireComplianceProfile` override), so the real path can never bypass it.
const TERMINAL_TOOL_NAMES = new Set(['opt_out', 'end_call']);
export const ORCHESTRATOR_STATES = Object.freeze(['starting', 'ringing', 'active', 'ended']);

function firstEligibilityBlock(decision) {
  return decision?.reasons?.find((r) => r.severity === 'block')?.code ?? 'not_eligible';
}

// One live call. Holds the telephony session plus the (optional) media/realtime
// sessions, and exposes narrow methods the transport layer calls as data arrives.
export class OutboundCall {
  constructor({
    db,
    cfg,
    decision,
    session,
    script,
    username = 'system',
    mediaStreamFactory = null,
    realtimeFactory = null,
    mediaSocket = null,
    realtimeSocket = null,
    mandatoryAudio = EMPTY_MANDATORY_AUDIO,
    markTimeoutMs = 10000,
    streamWaitMs = 15000,
  }) {
    this.db = db;
    this.mandatoryAudio = mandatoryAudio;
    this.markTimeoutMs = markTimeoutMs;
    this.streamWaitMs = streamWaitMs;
    this.answered = false;
    this.answeredAt = 0;
    // Disclosure gate: pending -> awaiting_mark -> played. The AI session and every
    // model action wait for `played`. Any other path ends the call.
    this.disclosure = { state: 'pending', deadline: 0 };
    this.expiredReason = '';
    this.cfg = cfg;
    this.decision = decision;
    this.session = session;
    this.script = script;
    this.username = username;
    this.mediaStreamFactory = mediaStreamFactory;
    this.realtimeFactory = realtimeFactory;
    this.mediaSocket = mediaSocket;
    this.realtimeSocket = realtimeSocket;
    this.media = null;
    this.realtime = null;
    this.cleaning = false;
    this.startedAt = Date.now();
    this.lastTool = null;
  }

  get sessionId() {
    return this.session.id;
  }

  get state() {
    if (this.session.endedAt) return 'ended';
    if (this.media?.state === 'streaming') return 'active';
    return this.session.status === 'in_progress' ? 'active' : this.session.status;
  }

  // Authoritative provider status event. On answer, open the media + realtime
  // sessions; on a terminal status, tear the streams down.
  providerEvent(input) {
    const result = handleProviderEvent(this.db, input, this.cfg);
    if (result.type === 'applied' && result.status === 'in_progress') {
      this.answered = true;
      this.answeredAt = Date.now();
      try {
        this.#openStreams();
      } catch (err) {
        // Fail safe: if the media or model leg cannot be opened, end the call
        // instead of leaving a live line with no agent behind it.
        result.streamError = String(err?.message ?? 'stream_open_failed').slice(0, 80);
        this.#safeEnd(/mandatory_audio|media_stream|stream_socket/.test(result.streamError) ? 'disclosure_unavailable' : 'stream_open_failed');
      }
    }
    if (result.type === 'applied' && (result.status === 'ended' || result.status === 'failed')) {
      this.cleanup();
    }
    this.session = getVoiceSession(this.db, this.session.id) ?? this.session;
    return result;
  }

  // Inbound Twilio media-stream message (already JSON-parsed).
  onMedia(input) {
    if (this.state === 'ended') throw new HttpError(409, 'session_ended');
    if (this.#expireIfOverdue()) return { type: 'ended', reason: this.expiredReason };
    if (!this.media) throw new HttpError(409, 'media_stream_not_open');
    const msg = this.media.receive(input);
    if (msg.type === 'mark' && msg.name === MANDATORY_MARK && this.disclosure.state === 'awaiting_mark') {
      // The carrier echoed the disclosure mark: the approved audio has been played.
      this.disclosure = { state: 'played', deadline: 0 };
      try {
        this.#openRealtime();
      } catch (err) {
        this.#safeEnd('realtime_open_failed');
        return { type: 'ended', reason: String(err?.message ?? 'realtime_open_failed').slice(0, 80) };
      }
      return msg;
    }
    if (msg.type === 'media' && this.realtime && ['ready', 'active'].includes(this.realtime.state)) {
      this.realtime.appendAudio(msg.payload);
    } else if (msg.type === 'dtmf') {
      return this.callerTurn({ type: 'dtmf', digit: msg.digit });
    } else if (msg.type === 'stop') {
      return this.end('stream_stopped');
    }
    return msg;
  }

  // Inbound realtime server event (object or JSON string). Audio is forwarded to
  // the caller, interruptions clear buffered playback, and tool calls are
  // re-validated + executed server-side.
  onRealtime(input) {
    if (this.state === 'ended') throw new HttpError(409, 'session_ended');
    if (this.#expireIfOverdue()) return { type: 'ended', reason: this.expiredReason };
    const event = this.realtime ? this.realtime.ingest(input) : translateRealtimeEvent(input);
    switch (event.type) {
      case 'provider_error':
        // A model-side error cannot be recovered mid-call: end safely and
        // requeue through the normal finalize path (outcome: unanswered).
        this.#safeEnd('provider_error');
        return { ...event, ended: true };
      case 'audio':
        if (!this.#disclosurePlayed()) throw new HttpError(409, 'disclosure_not_played');
        if (event.delta && this.media?.state === 'streaming') this.media.sendAudio(event.delta);
        break;
      case 'interrupt':
        if (this.media?.state === 'streaming') this.media.clear();
        break;
      case 'tool_call': {
        // Every function call must receive an answer so the backend is never left
        // waiting, even when the call is rejected.
        if (!event.allowed || event.parseError) {
          const rejected = event.parseError ? 'invalid_tool_arguments' : 'tool_not_allowed';
          this.#reply(event.callId, { ok: false, rejected });
          return { action: event.name, ok: false, rejected };
        }
        if (!this.#disclosurePlayed()) {
          this.#reply(event.callId, { ok: false, rejected: 'disclosure_not_played' });
          return { action: event.name, ok: false, rejected: 'disclosure_not_played' };
        }
        const result = this.tool({ name: event.name, callId: event.callId, arguments: event.arguments });
        this.#reply(event.callId, { ok: result.ok === true, rejected: result.rejected ?? null, end: result.end === true });
        return result;
      }
      case 'session_closed':
        // The provider finished the session on its side: end the call safely.
        this.#safeEnd('live_session_closed');
        return { ...event, ended: true };
      default:
        break;
    }
    return event;
  }

  // Return a tool result to the model while the call is still live. If the
  // provider link is gone, end the call rather than leave it half-running.
  #reply(callId, output) {
    if (!callId || !this.realtime || this.state === 'ended') return;
    try {
      this.realtime.submitToolOutput(callId, output);
    } catch {
      this.#safeEnd('tool_reply_failed');
    }
  }

  // Lifecycle notifications from the provider leg (socket dropped or timed out).
  #onRealtimeLifecycle(event) {
    if (event?.type === 'live_socket_closed' && !this.cleaning && this.state !== 'ended') {
      this.#safeEnd('live_socket_closed');
    }
  }

  // Execute a model tool call through the bounded, audited executor.
  tool(rawToolCall, opts = {}) {
    if (!this.#disclosurePlayed()) throw new HttpError(409, 'disclosure_not_played');
    // Revalidate eligibility for every non-terminal action (speech, routing). Consent or
    // suppression revoked mid-call stops further speech and routing. Terminal actions
    // (opt_out, end_call) stay allowed so the call can always end cleanly.
    const name = String(rawToolCall?.name ?? '');
    if (!TERMINAL_TOOL_NAMES.has(name) && !this.#stillEligible()) {
      const rejected = { action: name, ok: false, rejected: 'eligibility_revoked' };
      this.lastTool = rejected;
      return rejected;
    }
    const result = executeAiToolCall(this.db, { id: this.session.id }, rawToolCall, {
      cfg: this.cfg,
      script: this.script,
      elapsedMs: opts.elapsedMs ?? Date.now() - this.startedAt,
    });
    this.lastTool = result;
    if (result.end) this.cleanup();
    this.session = getVoiceSession(this.db, this.session.id) ?? this.session;
    return result;
  }

  // A caller event that the deterministic offline agent (or, in production, the
  // STT layer) produces: speech / dtmf / silence / interrupt.
  callerTurn(input) {
    if (this.#expireIfOverdue()) return { agent: { ended: true, outcome: 'unanswered', reason: this.expiredReason } };
    if (!this.#disclosurePlayed()) throw new HttpError(409, 'disclosure_not_played');
    const result = handleTurn(this.db, this.session.id, input, this.username, this.cfg);
    if (result.agent?.ended) this.cleanup();
    this.session = result.session ?? this.session;
    return result;
  }

  end(reason = 'operator_ended') {
    const session = endVoiceSession(this.db, this.session.id, { reason }, this.username, this.cfg);
    this.cleanup();
    this.session = session ?? this.session;
    return session;
  }

  // Best-effort teardown of the media + realtime sockets. Never throws.
  cleanup() {
    this.cleaning = true;
    try {
      this.realtime?.terminate('orchestrator_cleanup');
    } catch {
      /* best effort */
    }
    this.cleaning = false;
    try {
      this.media?.close('orchestrator_cleanup');
    } catch {
      /* best effort */
    }
  }

  // End the call if it is still live; a call that already ended is a no-op.
  #safeEnd(reason) {
    try {
      this.end(reason);
    } catch (err) {
      if (err?.status !== 409) throw err;
      this.cleanup();
    }
    return this.session;
  }

  // Hard duration cap, enforced on every inbound event rather than trusting the
  // provider to hang up. Returns true when the call was ended here.
  #expireIfOverdue() {
    if (this.state === 'ended') return false;
    if (this.disclosure.state === 'awaiting_mark' && Date.now() > this.disclosure.deadline) {
      // The provider never confirmed the disclosure: do not let the call continue.
      this.disclosure = { state: 'failed', deadline: 0 };
      this.expiredReason = 'disclosure_timeout';
      this.#safeEnd('disclosure_timeout');
      return true;
    }
    const maxMs = (this.cfg.voice.maxCallSeconds ?? 600) * 1000;
    if (Date.now() - this.startedAt <= maxMs) return false;
    this.expiredReason = 'max_call_duration';
    this.#safeEnd('max_call_duration');
    return true;
  }

  #disclosurePlayed() {
    return this.disclosure.state === 'played';
  }

  // Live eligibility for this session's lead and campaign. The calling-window block is
  // excluded so a call that began inside the window can finish a clean hangup.
  #stillEligible() {
    const decision = assessOutboundCall(this.db, { campaignId: this.session.campaignId, leadId: this.session.leadId, cfg: this.cfg });
    return decision.reasons.every((r) => r.severity !== 'block' || r.code === 'outside_calling_window');
  }

  // On answer: open the media leg, then play the mandatory disclosure. The AI
  // session is NOT opened here; it opens only after the disclosure mark is echoed.
  // Public: attach a started media session (for example a Twilio stream accepted by the
  // lifecycle coordinator). Disclosure starts here when the call is already answered.
  attachMedia(mediaSession) {
    if (this.media) throw new HttpError(409, 'media_already_attached');
    if (!mediaSession || mediaSession.state !== 'streaming') throw new HttpError(409, 'media_not_streaming');
    this.media = mediaSession;
    if (this.answered) {
      try {
        this.#openStreams();
      } catch (err) {
        this.#safeEnd(/mandatory_audio/.test(String(err?.message ?? '')) ? 'disclosure_unavailable' : 'disclosure_failed');
      }
    }
    return this.state;
  }

  // Deadline checks driven by the lifecycle coordinator. The orchestrator owns no timers.
  tick() {
    if (this.state === 'ended') return 'ended';
    if (this.#expireIfOverdue()) return 'expired';
    if (this.answered && !this.media && Date.now() - this.answeredAt > this.streamWaitMs) {
      this.#safeEnd('stream_not_connected');
      return 'expired';
    }
    return 'ok';
  }

  // Starts the disclosure once. With a factory and no media (test path) the media leg is
  // created with a synthetic start. With no factory this waits for attachMedia.
  #openStreams() {
    if (this.disclosure.state !== 'pending') return;
    if (!this.media) {
      if (!this.mediaStreamFactory) return;
      this.media = this.mediaStreamFactory({ socket: this.mediaSocket });
      this.media.receive({ event: 'connected' });
      this.media.receive({
        event: 'start',
        streamSid: 'SS' + this.session.id,
        start: { callSid: this.session.providerCallSid || 'CA' + this.session.id, tracks: ['inbound'] },
      });
    }
    this.#beginDisclosure();
  }

  #beginDisclosure() {
    // Throws (fail closed) if no approved asset exists or the socket is unavailable.
    const frames = this.mandatoryAudio.frames('disclosure');
    for (const frame of frames) this.media.sendAudio(frame);
    this.media.sendMark(MANDATORY_MARK);
    this.disclosure = { state: 'awaiting_mark', deadline: Date.now() + this.markTimeoutMs };
  }

  #openRealtime() {
    if (this.realtime) return;
    if (this.realtimeFactory) {
      const sessionConfig = buildRealtimeSessionConfig({
        voice: this.cfg.voice.realtimeVoice,
        instructions: this.cfg.voice.aiDisclosure,
      });
      this.realtime = this.realtimeFactory({
        socket: this.realtimeSocket,
        sessionConfig,
        onEvent: (event) => this.#onRealtimeLifecycle(event),
      });
      this.realtime.start();
      // Ask the model to open the conversation.
      this.realtime.requestResponse();
    }
  }
}

// Create a coordinator bound to one database + effective config. All transports
// are injected so tests (and the default) stay completely offline.
export function createVoiceOrchestrator(db, options = {}) {
  const cfg = options.cfg ?? config;
  const now = options.now ?? (() => new Date());
  const mandatoryAudio = options.mandatoryAudio ?? EMPTY_MANDATORY_AUDIO;
  const markTimeoutMs = options.markTimeoutMs ?? 10000;
  const streamWaitMs = options.streamWaitMs ?? 15000;
  const mediaStreamFactory =
    options.mediaStreamFactory === undefined ? ({ socket }) => new MediaStreamSession({ socket }) : options.mediaStreamFactory;
  const realtimeFactory = options.realtimeFactory ?? null;

  // Run the fail-closed compliance gate. Exposed separately so an operator can
  // preview the decision without starting anything.
  function preflight({ campaignId, leadId } = {}) {
    return assessOutboundCall(db, { campaignId, leadId, cfg, now: now() });
  }

  // Start one outbound call. The gate runs FIRST and unconditionally: a call that
  // is not fully eligible is refused with 409 before any session row is created.
  function start({ campaignId, leadId, username = 'system', mediaSocket = null, realtimeSocket = null } = {}) {
    const decision = preflight({ campaignId, leadId });
    if (!decision.allowed) {
      throw new HttpError(409, 'not_eligible', {
        decision: decision.decision,
        reason: firstEligibilityBlock(decision),
        compliance: decision,
      });
    }
    const session = startVoiceSession(db, { campaignId, leadId, username, cfg });
    const call = new OutboundCall({
      db,
      cfg,
      decision,
      session,
      script: voiceScript(cfg.voice),
      username,
      mediaStreamFactory,
      realtimeFactory,
      mediaSocket,
      realtimeSocket,
      mandatoryAudio,
      markTimeoutMs,
    });
    audit(
      db,
      username,
      'orchestrator_call_started',
      'voice_session',
      String(session.id),
      JSON.stringify({ campaignId, leadId, media: Boolean(mediaStreamFactory), realtime: Boolean(realtimeFactory) })
    );
    return call;
  }

  function getCall(sessionId) {
    return getVoiceSession(db, sessionId);
  }

  // Emergency stop: halt every campaign AND end every live voice session.
  function emergencyStop(username = 'system') {
    const campaigns = emergencyStopAll(db, username);
    const voice = endActiveVoiceSessions(db, username, cfg);
    audit(db, username, 'orchestrator_emergency_stop', 'system', '', JSON.stringify({ campaigns: campaigns.stopped, voice: voice.ended }));
    return { campaigns: campaigns.stopped, voiceSessions: voice.ended };
  }

  // Adopt a session that placement already created. This is the single bridge between
  // the placement path and the orchestrator. It creates no session and no provider call.
  function adopt({ sessionId, username = 'system', realtimeSocket = null, mediaSocket = null } = {}) {
    const session = getVoiceSession(db, Number(sessionId));
    if (!session) throw new HttpError(404, 'voice_session_not_found');
    if (!['ringing', 'in_progress'].includes(session.status)) {
      throw new HttpError(409, 'invalid_transition', { status: session.status });
    }
    const decision = preflight({ campaignId: session.campaignId, leadId: session.leadId });
    if (!decision.allowed) {
      throw new HttpError(409, 'not_eligible', { reason: firstEligibilityBlock(decision), compliance: decision });
    }
    const call = new OutboundCall({
      db,
      cfg,
      decision,
      session,
      script: voiceScript(cfg.voice),
      username,
      mediaStreamFactory: null,
      realtimeFactory,
      mediaSocket,
      realtimeSocket,
      mandatoryAudio,
      markTimeoutMs,
      streamWaitMs,
    });
    if (session.status === 'in_progress') {
      call.answered = true;
      call.answeredAt = Date.now();
    }
    return call;
  }

  return { preflight, start, getCall, emergencyStop, adopt };
}
