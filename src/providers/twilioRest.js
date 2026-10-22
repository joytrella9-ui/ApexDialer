import { HttpError } from '../lib/errors.js';
import { isE164, normalizeTwilioError } from './twilioVoice.js';

// =============================================================================
// TWILIO REST TRANSPORT (offline by construction; NOT registered)
// =============================================================================
// Reference (Twilio Programmable Voice, Call resource):
//   Create:  POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Calls.json
//            form-encoded; To and From required; Url (or Twiml); StatusCallback,
//            StatusCallbackMethod, StatusCallbackEvent (initiated|ringing|answered|
//            completed, one parameter per event); Record; Timeout; TimeLimit.
//            Responds 201 with the Call resource (sid, status).
//   Update:  POST .../Accounts/{AccountSid}/Calls/{CallSid}.json with Status=completed
//            ends an in-progress call.
//   Auth:    HTTP Basic, username = Account SID, password = Auth Token (or API key).
//
// Safety properties:
//   - `liveEnabled` defaults to false. Every network operation refuses first with
//     `live_voice_disabled`, so no fetch happens unless a caller explicitly opts in.
//     `createTwilioRestTransport` (the config factory) never sets it.
//   - Call creation is NEVER retried automatically: a timeout or connection error
//     may still have placed a call (Twilio's docs warn about this). Such failures
//     are returned with `ambiguous: true` so the caller reconciles, not re-dials.
//   - Ending a call is retried on 429/5xx/network errors (repeating a hangup is
//     harmless).
//   - Credentials are sent only in the Authorization header. Thrown errors carry
//     only stable internal codes; Twilio's error text and any credential are never
//     surfaced or logged.
//   - Every request has a timeout (AbortController).
export const TWILIO_API_BASE = 'https://api.twilio.com';
export const TWILIO_STATUS_EVENTS = Object.freeze(['initiated', 'ringing', 'answered', 'completed']);
const ACCOUNT_SID = /^AC[0-9a-fA-F]{32}$/;
const CALL_SID = /^CA[0-9a-fA-F]{32}$/;
const MAX_URL_LENGTH = 2048;
const DEFAULT_TIMEOUT_MS = 10000;
const END_RETRIES = 2;

// Provider callbacks and TwiML URLs must be public https (Twilio cannot reach
// localhost or private addresses), with no credentials in the URL.
export function assertPublicHttpsUrl(value, field) {
  const raw = String(value ?? '');
  if (!raw || raw.length > MAX_URL_LENGTH) throw new HttpError(400, 'invalid_url', { field });
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, 'invalid_url', { field });
  }
  const host = url.hostname.toLowerCase();
  const isLocal =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '127.0.0.1' ||
    host === '::1' ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host);
  if (url.protocol !== 'https:' || url.username || url.password || isLocal) {
    throw new HttpError(400, 'invalid_url', { field });
  }
  return url.toString();
}

function basicAuth(accountSid, authToken) {
  return `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`;
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TwilioRestTransport {
  constructor({
    accountSid,
    authToken,
    liveEnabled = false,
    fetchImpl = globalThis.fetch,
    baseUrl = TWILIO_API_BASE,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    sleep = sleepMs,
    endRetryDelayMs = 250,
  } = {}) {
    this.accountSid = String(accountSid ?? '');
    this.authToken = String(authToken ?? '');
    this.liveEnabled = liveEnabled === true;
    this.fetchImpl = fetchImpl;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.sleep = sleep;
    this.endRetryDelayMs = endRetryDelayMs;
    // Never expose credentials through inspection/serialization.
    Object.defineProperty(this, 'authToken', { enumerable: false, writable: true });
  }

  toJSON() {
    return { provider: 'twilio', liveEnabled: this.liveEnabled, credentialsConfigured: this.hasCredentials() };
  }

  hasCredentials() {
    return ACCOUNT_SID.test(this.accountSid) && this.authToken.length > 0;
  }

  #requireLive() {
    if (!this.liveEnabled) throw new HttpError(400, 'live_voice_disabled');
    if (!this.hasCredentials()) throw new HttpError(400, 'provider_not_configured');
    if (typeof this.fetchImpl !== 'function') throw new HttpError(400, 'provider_not_configured');
  }

  // Place one outbound call. Returns { sid, status }. Never retried.
  async createCall({ to, from, twimlUrl, statusCallbackUrl, timeoutSeconds = 45, timeLimitSeconds = 600 } = {}) {
    this.#requireLive();
    if (!isE164(to)) throw new HttpError(400, 'invalid_phone', { field: 'to' });
    if (!isE164(from)) throw new HttpError(400, 'invalid_phone', { field: 'from' });
    const url = assertPublicHttpsUrl(twimlUrl, 'twimlUrl');
    const callback = assertPublicHttpsUrl(statusCallbackUrl, 'statusCallbackUrl');
    const timeout = Math.min(Math.max(Math.trunc(Number(timeoutSeconds)) || 45, 5), 600);
    const limit = Math.min(Math.max(Math.trunc(Number(timeLimitSeconds)) || 600, 1), 14400);

    const body = new URLSearchParams();
    body.set('To', to.trim());
    body.set('From', from.trim());
    body.set('Url', url);
    body.set('Method', 'POST');
    body.set('StatusCallback', callback);
    body.set('StatusCallbackMethod', 'POST');
    for (const event of TWILIO_STATUS_EVENTS) body.append('StatusCallbackEvent', event);
    body.set('Record', 'false');
    body.set('Timeout', String(timeout));
    body.set('TimeLimit', String(limit));

    const path = `/2010-04-01/Accounts/${this.accountSid}/Calls.json`;
    let res;
    try {
      res = await this.#send('POST', path, body);
    } catch (err) {
      // Timeout or connection failure: the call may already exist. Do not retry.
      if (err instanceof HttpError) err.details = { ...(err.details ?? {}), ambiguous: true };
      throw err;
    }
    const data = await this.#json(res, 'create');
    if (!CALL_SID.test(String(data?.sid ?? ''))) {
      throw new HttpError(502, 'provider_bad_response', { ambiguous: true });
    }
    return { sid: data.sid, status: String(data.status ?? 'queued') };
  }

  // Terminate an in-progress call. Retried on transient failures.
  async endCall(callSid) {
    this.#requireLive();
    if (!CALL_SID.test(String(callSid ?? ''))) throw new HttpError(400, 'invalid_call_sid');
    const body = new URLSearchParams();
    body.set('Status', 'completed');
    const path = `/2010-04-01/Accounts/${this.accountSid}/Calls/${callSid}.json`;
    let lastError = null;
    for (let attempt = 0; attempt <= END_RETRIES; attempt += 1) {
      try {
        const res = await this.#send('POST', path, body);
        const data = await this.#json(res, 'end');
        return { sid: data.sid ?? callSid, status: String(data.status ?? 'completed') };
      } catch (err) {
        lastError = err;
        if (!(err instanceof HttpError) || !err.details?.retryable || attempt === END_RETRIES) break;
        await this.sleep(this.endRetryDelayMs * (attempt + 1));
      }
    }
    throw lastError;
  }

  async #send(method, path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: basicAuth(this.accountSid, this.authToken),
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: body.toString(),
        signal: controller.signal,
        redirect: 'error',
      });
    } catch (err) {
      const timedOut = err?.name === 'AbortError';
      throw new HttpError(502, timedOut ? 'provider_timeout' : 'provider_unavailable', {
        retryable: true,
        timeout: timedOut,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async #json(res, operation) {
    let data = null;
    let text = '';
    try {
      text = await res.text();
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (res.ok) return data ?? {};
    // Only the numeric Twilio error code is used; the message text is discarded.
    const mapped = normalizeTwilioError({ status: res.status, code: data?.code });
    const retryable = mapped.retryable && operation === 'end';
    // A 5xx on create may have been returned after the call was queued.
    const ambiguous = operation === 'create' && res.status >= 500;
    throw new HttpError(mapped.status, mapped.code, {
      retryable,
      ambiguous,
      providerCode: mapped.providerCode || undefined,
    });
  }
}

// Factory used by configuration. Credentials are read from the server
// environment by the caller; live enablement is hardcoded off here, so this
// transport cannot place a call even when fully credentialed.
export function createTwilioRestTransport({ accountSid = '', authToken = '', fetchImpl } = {}) {
  return new TwilioRestTransport({ accountSid, authToken, liveEnabled: false, fetchImpl });
}
