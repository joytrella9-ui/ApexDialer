export function createRateLimiter({ windowMs = 15 * 60 * 1000, max = 5 } = {}) {
  const hits = new Map();

  function prune(now = Date.now()) {
    for (const [key, entry] of hits) {
      if (now > entry.resetAt) hits.delete(key);
    }
  }

  return {
    check(key, now = Date.now()) {
      prune(now);
      let entry = hits.get(key);
      if (!entry) {
        entry = { count: 0, resetAt: now + windowMs };
        hits.set(key, entry);
      }
      entry.count += 1;
      return {
        allowed: entry.count <= max,
        count: entry.count,
        retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000),
      };
    },
    reset(key) {
      hits.delete(key);
    },
    resetAll() {
      hits.clear();
    },
  };
}