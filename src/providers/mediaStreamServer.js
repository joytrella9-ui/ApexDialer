import { WebSocketServer } from 'ws';
import { MediaStreamSession } from './twilioMediaStream.js';

// =============================================================================
// TWILIO MEDIA STREAMS WEBSOCKET ENDPOINT
// =============================================================================
// Accepts the bidirectional stream that Twilio opens after `<Connect><Stream>`
// (see twilioTwiml.js). Protocol: connected -> start -> media/dtmf/mark -> stop.
// Reference: Twilio Media Streams WebSocket messages.
//
// Authentication: the `start` message must carry the single-use token that the
// TwiML route issued (customParameters.token). The token is consumed on use. Every
// message before a valid start, every duplicate start, binary frames, oversized
// frames, floods, and idle connections close the socket with a policy code.
//
// Backpressure: outbound writes are refused (the socket is closed) when the
// transmit buffer exceeds MAX_BUFFERED_BYTES, so a slow peer cannot grow memory.
//
// This endpoint only accepts and validates streams. It does NOT place calls and is
// not connected to any live call path in this build.
export const MEDIA_PATH = '/api/voice/media';
export const MEDIA_MAX_PAYLOAD = 64 * 1024;
export const MEDIA_IDLE_MS = 30 * 1000;
export const MEDIA_MAX_MESSAGES_PER_SECOND = 300;
export const MEDIA_MAX_BUFFERED_BYTES = 1024 * 1024;
export const MEDIA_MAX_CONNECTIONS = 50;

export function attachMediaStreamServer(
  httpServer,
  {
    tokens,
    path = MEDIA_PATH,
    idleMs = MEDIA_IDLE_MS,
    maxPayload = MEDIA_MAX_PAYLOAD,
    maxConnections = MEDIA_MAX_CONNECTIONS,
    maxMessagesPerSecond = MEDIA_MAX_MESSAGES_PER_SECOND,
    maxBufferedBytes = MEDIA_MAX_BUFFERED_BYTES,
    onStart = () => {},
    onMessage = () => {},
    onClose = () => {},
    // Fail closed: with no validator, no stream is accepted. The validator must confirm the
    // session is live and that the stream's Call SID is the one recorded for it.
    validateStart = () => false,
  } = {}
) {
  if (!tokens || typeof tokens.consume !== 'function') throw new Error('attachMediaStreamServer requires a token store');
  const wss = new WebSocketServer({ noServer: true, maxPayload });
  const live = new Set();
  // sessionId -> the one socket currently bound to it. Prevents two streams per session.
  const bindings = new Map();

  const onUpgrade = (req, socket, head) => {
    let pathname = '';
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      pathname = '';
    }
    if (pathname !== path) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (live.size >= maxConnections) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  };
  httpServer.on('upgrade', onUpgrade);

  const closers = new Set();

  wss.on('connection', (ws) => {
    live.add(ws);
    let authed = false;
    let sessionId = null;
    let closed = false;
    let idleTimer = null;
    let windowStart = Date.now();
    let windowCount = 0;

    const release = () => {
      if (sessionId !== null && bindings.get(sessionId) === ws) bindings.delete(sessionId);
    };

    const finish = (code, reason) => {
      if (closed) return;
      closed = true;
      clearTimeout(idleTimer);
      live.delete(ws);
      closers.delete(stop);
      release();
      try {
        ws.close(code, reason);
      } catch {
        ws.terminate();
      }
      try {
        onClose({ sessionId, reason });
      } catch {
        // listeners must not throw during socket teardown
      }
    };
    const stop = () => finish(1001, 'server_closing');
    closers.add(stop);

    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish(1001, 'idle_timeout'), idleMs);
      idleTimer.unref?.();
    };

    // A thin socket facade for MediaStreamSession that refuses writes past the
    // buffer limit instead of letting memory grow.
    const socketFacade = {
      send(payload) {
        if (ws.bufferedAmount > maxBufferedBytes) {
          finish(1011, 'backpressure');
          throw new Error('backpressure');
        }
        ws.send(payload);
      },
      close(code, reason) {
        finish(code ?? 1000, reason ?? '');
      },
    };
    const session = new MediaStreamSession({ socket: socketFacade });
    armIdle();

    ws.on('message', (data, isBinary) => {
      if (closed) return;
      if (isBinary) return finish(1003, 'binary_not_supported');

      const now = Date.now();
      if (now - windowStart >= 1000) {
        windowStart = now;
        windowCount = 0;
      }
      windowCount += 1;
      if (windowCount > maxMessagesPerSecond) return finish(1008, 'rate_limited');
      armIdle();

      const text = data.toString();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        return finish(1008, 'invalid_message');
      }
      const event = parsed?.event;

      if (!authed) {
        if (event === 'connected') {
          // allowed before authentication
        } else if (event === 'start') {
          const bound = tokens.consume(parsed?.start?.customParameters?.token);
          if (!bound) return finish(1008, 'unauthorized');
          if (bindings.has(bound)) return finish(1008, 'duplicate_binding');
          const callSid = String(parsed?.start?.callSid ?? '').slice(0, 64);
          if (!validateStart({ sessionId: bound, callSid })) return finish(1008, 'stale_session');
          authed = true;
          sessionId = bound;
          bindings.set(bound, ws);
          try {
            onStart({ sessionId, callSid, socket: socketFacade, startMessage: parsed });
          } catch {
            return finish(1011, 'start_failed');
          }
        } else {
          return finish(1008, 'not_started');
        }
      } else if (event === 'start') {
        return finish(1008, 'duplicate_start');
      }

      try {
        const msg = session.receive(text);
        if (msg.type === 'media' || msg.type === 'dtmf' || msg.type === 'mark') {
          onMessage({ sessionId, message: msg, raw: parsed });
        } else if (msg.type === 'stop') {
          finish(1000, 'stream_stopped');
        }
      } catch (err) {
        if (!closed) finish(1008, err?.message === 'backpressure' ? 'backpressure' : 'protocol_error');
      }
    });

    ws.on('close', () => {
      if (!closed) {
        closed = true;
        clearTimeout(idleTimer);
        live.delete(ws);
        release();
        onClose({ sessionId, reason: 'socket_closed' });
      }
    });
    ws.on('error', () => {
      // Errors close the socket through the close handler; never crash the server.
    });
  });

  return {
    connections: () => live.size,
    bindings: () => bindings.size,
    close() {
      httpServer.off('upgrade', onUpgrade);
      for (const stop of [...closers]) stop();
      closers.clear();
      live.clear();
      wss.close();
    },
  };
}
