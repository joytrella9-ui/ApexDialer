import { HttpError } from '../lib/errors.js';
import { audit } from './auth.js';
import { placeOutboundCall } from './outboundPlacement.js';
import { handleProviderEvent } from './voiceSessions.js';
import { createVoiceOrchestrator } from './voiceOrchestrator.js';
import { MediaStreamSession } from '../providers/twilioMediaStream.js';
import { attachMediaStreamServer } from '../providers/mediaStreamServer.js';
import { EMPTY_MANDATORY_AUDIO, MANDATORY_MARK } from './mandatoryAudio.js';

// =============================================================================
// CALL LIFECYCLE COORDINATOR (single owner of one outbound call)
// =============================================================================
// One record per voice session ties together: the placement outcome, the provider
// Call SID, the orchestrator's OutboundCall (which holds the DB session, eligibility,
// and disclosure gate), the accepted Media Streams socket, and the AI socket.
//
// It adds no security logic of its own. It delegates to:
//   - placeOutboundCall (claim, eligibility revalidation, exactly-once create),
//   - the signed TwiML and status routes (signatures, idempotent provider events),
//   - the media endpoint token check (single-use tokens),
//   - the orchestrator (disclosure gate, tool authorization, terminal cleanup).
// What it adds is the sequencing between them and the records that connect them.
//
// Sequencing rules enforced here:
//   - A stream is accepted only for a bound, live session whose Call SID matches and
//     that has no stream already (validateStart).
//   - The AI socket is opened only after the disclosure mark is echoed by the carrier.
//     Before that, no model connection exists, so nothing is billed or spoken.
//   - Any failure while opening the AI leg ends the call; nothing is retried.
//   - Every terminal path goes through one end routine, which is idempotent.
//   - Ambiguous creation is never retried. Reconciliation needs a provider lookup,
//     which is an injected interface and is refused when absent.
export class CallLifecycle {
  constructor({
    db,
    cfg,
    provider = null,
    aiConnector = null,
    realtimeFactory = null,
    mandatoryAudio = EMPTY_MANDATORY_AUDIO,
    markTimeoutMs = 10000,
    streamWaitMs = 15000,
    answerTimeoutMs = 90000,
    now = () => Date.now(),
    lookup = null,
  } = {}) {
    this.db = db;
    this.cfg = cfg;
    this.provider = provider;
    this.aiConnector = aiConnector;
    this.lookup = lookup;
    this.answerTimeoutMs = answerTimeoutMs;
    this.now = now;
    this.records = new Map();
    this.orchestrator = createVoiceOrchestrator(db, {
      cfg,
      mandatoryAudio,
      realtimeFactory,
      markTimeoutMs,
      streamWaitMs,
    });
  }

  recordCount() {
    return this.records.size;
  }

  recordFor(sessionId) {
    return this.records.get(Number(sessionId)) ?? null;
  }

  // Phase 1 + 2 of placement, then adopt the session into the orchestrator.
  // The synchronous record is set before the first await, so two concurrent calls for
  // the same session cannot both reach the provider.
  async place({ sessionId, username = 'system' } = {}) {
    const id = Number(sessionId);
    const existing = this.records.get(id);
    if (existing && existing.status !== 'ended') throw new HttpError(409, 'attempt_already_claimed');
    const rec = { sessionId: id, status: 'placing', callSid: '', call: null, media: null, aiSocket: null, aiConnecting: false, placedAt: this.now() };
    this.records.set(id, rec);

    let session;
    try {
      session = await placeOutboundCall(this.db, { sessionId: id, provider: this.provider, username, cfg: this.cfg });
    } catch (err) {
      // Ambiguous results keep their record so nothing new can be placed for the session.
      if (err?.message === 'provider_create_ambiguous') rec.status = 'ambiguous';
      else this.records.delete(id);
      throw err;
    }

    rec.callSid = String(session.providerCallSid ?? '');
    try {
      rec.call = this.orchestrator.adopt({ sessionId: id, username });
    } catch (err) {
      // The provider call exists but the orchestrator cannot take it. End the provider
      // call (best effort) rather than leave an unmanaged live call behind.
      rec.status = 'orphaned';
      this.#cancelProviderCall(rec.callSid);
      audit(this.db, username, 'call_adoption_failed', 'voice_session', String(id), JSON.stringify({ code: err.message }));
      throw err;
    }
    rec.status = 'ringing';
    return { sessionId: id, callSid: rec.callSid, status: session.status };
  }

  // Provider status callbacks (already signature-verified by the route). When the call
  // is adopted, the orchestrator applies the event so answer opens the disclosure gate.
  // Callbacks that arrive before the SID is bound match no session and are ignored.
  onProviderStatus(input = {}) {
    const rec = this.#byCallSid(input.sid);
    const result = rec?.call ? rec.call.providerEvent(input) : handleProviderEvent(this.db, input, this.cfg);
    this.#sweep();
    return result;
  }

  // Called by the media endpoint before a stream is bound. Fails closed unless the
  // session is live, has an adopted call, has no stream yet, and the Call SID matches.
  validateStart({ sessionId, callSid } = {}) {
    const id = Number(sessionId);
    const rec = this.records.get(id);
    if (!rec || !rec.call || rec.media) return false;
    const row = this.db.prepare('SELECT status, provider_call_sid FROM voice_sessions WHERE id = ?').get(id);
    return Boolean(row) &&
      ['ringing', 'in_progress'].includes(row.status) &&
      row.provider_call_sid !== '' &&
      row.provider_call_sid === String(callSid ?? '') &&
      rec.callSid === row.provider_call_sid;
  }

  // The media endpoint has accepted the socket (token consumed, validateStart passed).
  onStreamStart({ sessionId, callSid, socket, startMessage } = {}) {
    const rec = this.records.get(Number(sessionId));
    if (!rec?.call || rec.media) throw new HttpError(409, 'no_call_for_stream');
    if (String(callSid ?? '') !== rec.callSid || startMessage?.start?.callSid !== rec.callSid) {
      throw new HttpError(409, 'stream_call_mismatch');
    }
    // The coordinator's own session parses the Twilio protocol for this socket. Frames
    // are passed through unchanged (mu-law, 8 kHz, base64, as Media Streams sends them).
    const media = new MediaStreamSession({ socket });
    media.receive({ event: 'connected' });
    media.receive(startMessage);
    rec.media = media;
    try {
      rec.call.attachMedia(media);
    } catch {
      this.#endRecord(rec, 'media_attach_failed');
    }
    this.#sweep();
  }

  // Inbound Media Streams messages after authentication. Frames are forwarded to the
  // orchestrator. The mandatory disclosure mark opens the AI leg first and is forwarded
  // only if that leg is open. Any error ends the call; nothing is retried.
  async onStreamMessage({ sessionId, raw } = {}) {
    const rec = this.records.get(Number(sessionId));
    if (!rec?.call) return;
    try {
      if (raw?.event === 'mark' && raw?.mark?.name === MANDATORY_MARK && rec.call.disclosure.state === 'awaiting_mark') {
        const ready = await this.#connectAi(rec);
        if (!ready) return;
      }
      rec.call.onMedia(raw);
    } catch (err) {
      if (err?.status === 409) return; // already ended
      this.#endRecord(rec, 'stream_error');
    } finally {
      this.#sweep();
    }
  }

  // The media socket closed for any reason (stop message, carrier drop, server close).
  onStreamClosed({ sessionId, reason } = {}) {
    const rec = this.records.get(Number(sessionId));
    if (rec?.call) this.#endRecord(rec, reason === 'stream_stopped' ? 'stream_stopped' : 'stream_closed');
    this.#sweep();
  }

  // Deadline checks: unanswered calls past the answer timeout are cancelled (provider
  // hangup, no retry); other deadlines are enforced by the orchestrator.
  tick() {
    for (const rec of [...this.records.values()]) {
      if (!rec.call || this.#dbStatus(rec.sessionId) === 'ended' || this.#dbStatus(rec.sessionId) === 'failed') continue;
      if (!rec.call.answered && this.now() - rec.placedAt > this.answerTimeoutMs) {
        this.#cancelProviderCall(rec.callSid);
        this.#endRecord(rec, 'answer_timeout');
        continue;
      }
      try {
        rec.call.tick();
      } catch {
        this.#endRecord(rec, 'tick_error');
      }
    }
    this.#sweep();
  }

  // Ambiguous creation: check the provider for a call that may exist. Reports only;
  // it never changes the session and never places a call. Refused without a lookup.
  async reconcileAmbiguous({ sessionId, username = 'operator' } = {}) {
    const id = Number(sessionId);
    const row = this.db.prepare('SELECT id, disconnect_reason FROM voice_sessions WHERE id = ?').get(id);
    if (!row) throw new HttpError(404, 'voice_session_not_found');
    if (row.disconnect_reason !== 'ambiguous_create') throw new HttpError(409, 'not_ambiguous');
    if (!this.lookup) {
      throw new HttpError(503, 'reconciliation_unavailable', {
        reason: 'no provider lookup is configured; check the provider console by hand',
      });
    }
    const found = await this.lookup({ sessionId: id });
    const sid = found?.sid ? String(found.sid) : '';
    audit(this.db, username, 'ambiguous_reconciled', 'voice_session', String(id), JSON.stringify({ found: Boolean(sid) }));
    return { found: Boolean(sid), sid };
  }

  // Open the AI leg once, after the carrier has echoed the disclosure mark. Returns true
  // only when the socket is attached and the orchestrator may start the model session.
  async #connectAi(rec) {
    if (rec.aiConnecting || rec.aiSocket) return false;
    rec.aiConnecting = true;
    if (!this.aiConnector) {
      this.#endRecord(rec, 'ai_not_configured');
      return false;
    }
    let socket;
    try {
      socket = await this.aiConnector({ sessionId: rec.sessionId });
    } catch {
      this.#endRecord(rec, 'ai_connect_failed');
      return false;
    }
    if (!rec.call || rec.call.state === 'ended') {
      try {
        socket?.close?.(1000, 'call_ended');
      } catch {
        // best effort
      }
      return false;
    }
    rec.aiSocket = socket;
    rec.call.realtimeSocket = socket;
    socket.on('message', (data) => this.#onAiMessage(rec, data));
    socket.on('close', () => {
      try {
        rec.call?.realtime?.onSocketClosed?.();
      } catch {
        // best effort
      }
    });
    return true;
  }

  #onAiMessage(rec, data) {
    try {
      rec.call.onRealtime(data.toString());
    } catch (err) {
      if (err?.status === 409) return; // ended
      this.#endRecord(rec, 'ai_malformed_event');
    } finally {
      this.#sweep();
    }
  }

  // The single terminal path. Idempotent: ending an ended call is a no-op, and cleanup
  // always runs so upstream sockets are released.
  // Tear down every live record. Call this before closing the database so
  // delayed socket `close` events cannot write to a closed connection.
  shutdown(reason = 'server_shutdown') {
    for (const rec of [...this.records.values()]) {
      this.#endRecord(rec, reason);
    }
    this.records.clear();
  }

  #endRecord(rec, reason) {
    if (!rec?.call || rec.ending) return;
    rec.ending = true;
    try {
      rec.call.end(reason);
    } catch {
      try {
        rec.call.cleanup();
      } catch {
        // best effort
      }
    }
    this.#sweep();
  }

  #cancelProviderCall(callSid) {
    if (!callSid || !this.provider?.endCall) return;
    Promise.resolve()
      .then(() => this.provider.endCall(callSid))
      .catch(() => {
        // Best effort: the local session is already finalized by the caller.
      });
  }

  #byCallSid(sid) {
    const key = String(sid ?? '');
    if (!key) return null;
    for (const rec of this.records.values()) {
      if (rec.callSid === key) return rec;
    }
    return null;
  }

  #dbStatus(sessionId) {
    try {
      return this.db.prepare('SELECT status FROM voice_sessions WHERE id = ?').get(Number(sessionId))?.status ?? null;
    } catch {
      return null;
    }
  }

  // Release records whose session reached a terminal state (bounded by live sessions).
  #sweep() {
    for (const [id, rec] of this.records) {
      if (!rec.call) continue;
      const status = this.#dbStatus(id);
      if (status === 'ended' || status === 'failed' || status === null) this.records.delete(id);
    }
  }
}

export function createCallLifecycle(options = {}) {
  return new CallLifecycle(options);
}

// Single wiring path for the Media Streams endpoint: validation, binding, frames, and
// closure all go through the coordinator. Used by server.js and by the integration tests.
export function attachLifecycleMedia(httpServer, lifecycle, tokens) {
  return attachMediaStreamServer(httpServer, {
    tokens,
    validateStart: (x) => lifecycle.validateStart(x),
    onStart: (x) => lifecycle.onStreamStart(x),
    onMessage: (x) => {
      lifecycle.onStreamMessage(x).catch(() => {
        // onStreamMessage handles its own errors; this only prevents an unhandled rejection.
      });
    },
    onClose: (x) => lifecycle.onStreamClosed(x),
  });
}
