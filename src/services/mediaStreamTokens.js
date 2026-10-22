import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// =============================================================================
// SINGLE-USE MEDIA STREAM TOKENS (in memory)
// =============================================================================
// A Twilio Media Streams WebSocket must prove which voice session it belongs to.
// The token is minted when the TwiML that opens the stream is served, passed to
// Twilio as a <Parameter> (never in the URL: Twilio forbids query strings there),
// and consumed exactly once when the WebSocket's `start` message arrives.
//
// Properties:
//   - 32 random bytes, base64url; only a SHA-256 digest is stored.
//   - Single use: a second presentation of the same token is rejected.
//   - Short lifetime (default 5 minutes) and a bounded table size.
//   - In memory by design: a restart invalidates every token (fail closed).
//   - Lookup by digest with a constant-time comparison of the stored digests.
export const STREAM_TOKEN_TTL_MS = 5 * 60 * 1000;
export const MAX_STREAM_TOKENS = 1000;

export function digestToken(token) {
  return createHash('sha256').update(String(token)).digest();
}

export function createStreamTokenStore({ ttlMs = STREAM_TOKEN_TTL_MS, maxTokens = MAX_STREAM_TOKENS, now = () => Date.now() } = {}) {
  // Map of hex digest -> { sessionId, expiresAt }.
  const entries = new Map();

  function prune() {
    const t = now();
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= t) entries.delete(key);
    }
  }

  return {
    issue(sessionId) {
      prune();
      if (entries.size >= maxTokens) throw new Error('stream_token_capacity');
      const token = randomBytes(32).toString('base64url');
      const key = digestToken(token).toString('hex');
      entries.set(key, { sessionId: Number(sessionId), expiresAt: now() + ttlMs });
      return token;
    },
    // Returns the bound session id once, or null. The entry is removed on any
    // presentation that matches, so a token can never be replayed.
    consume(token) {
      if (typeof token !== 'string' || token.length === 0 || token.length > 200) return null;
      prune();
      const want = digestToken(token);
      let matched = null;
      for (const [key, entry] of entries) {
        const have = Buffer.from(key, 'hex');
        if (have.length === want.length && timingSafeEqual(have, want)) {
          matched = { key, entry };
          break;
        }
      }
      if (!matched) return null;
      entries.delete(matched.key);
      if (matched.entry.expiresAt <= now()) return null;
      return matched.entry.sessionId;
    },
    size() {
      prune();
      return entries.size;
    },
  };
}
