import { HttpError } from '../lib/errors.js';

// =============================================================================
// TWIML GENERATION (pure; no network)
// =============================================================================
// Reference (Twilio TwiML Voice <Stream>): `<Connect><Stream url="wss://...">`
// starts a bidirectional Media Stream. Facts used here, from the official page:
//   - the url must be wss:// (the only supported protocol);
//   - the url must NOT carry query-string parameters; custom key/value pairs are
//     sent with nested <Parameter name value/> elements instead;
//   - the combined length of each Parameter's name and value must be under 500
//     characters;
//   - Twilio runs no TwiML after <Connect> until the WebSocket is closed.
//
// Every interpolated value is XML-escaped, so caller-influenced text cannot inject
// markup. The stream URL must be a public wss URL (no localhost or private hosts).
const MAX_URL_LENGTH = 2048;
const MAX_PARAMETERS = 10;
const PARAM_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function isPrivateHost(host) {
  const h = host.toLowerCase();
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h === '127.0.0.1' ||
    h === '::1' ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    /^169\.254\./.test(h)
  );
}

export function assertPublicWssUrl(value) {
  const raw = String(value ?? '');
  if (!raw || raw.length > MAX_URL_LENGTH) throw new HttpError(400, 'invalid_stream_url');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, 'invalid_stream_url');
  }
  if (url.protocol !== 'wss:' || url.username || url.password || url.search || url.hash || isPrivateHost(url.hostname)) {
    throw new HttpError(400, 'invalid_stream_url');
  }
  return url.toString();
}

// Build the TwiML that opens a bidirectional stream. `parameters` is a plain object
// of short strings (for example a per-call, single-use token and the session id).
export function buildConnectStreamTwiml({ streamUrl, parameters = {} } = {}) {
  const url = assertPublicWssUrl(streamUrl);
  const entries = Object.entries(parameters ?? {});
  if (entries.length > MAX_PARAMETERS) throw new HttpError(400, 'too_many_stream_parameters');
  const params = entries.map(([name, value]) => {
    if (!PARAM_NAME.test(name)) throw new HttpError(400, 'invalid_stream_parameter', { name });
    const text = String(value ?? '');
    if (name.length + text.length >= 500) throw new HttpError(400, 'stream_parameter_too_long', { name });
    return `      <Parameter name="${xmlEscape(name)}" value="${xmlEscape(text)}"/>`;
  });
  const body = params.length ? `\n${params.join('\n')}\n    ` : '';
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    '  <Connect>',
    `    <Stream url="${xmlEscape(url)}">${body}</Stream>`,
    '  </Connect>',
    '</Response>',
  ].join('\n');
}
