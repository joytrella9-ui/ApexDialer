// Lightweight in-process request metrics. Counts only: no paths, IPs, user names, or
// payloads are recorded, so the snapshot is safe to show to admins.
export function createMetrics({ now = () => Date.now(), memory = () => process.memoryUsage() } = {}) {
  const startedAt = now();
  const byStatusClass = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, other: 0 };
  let total = 0;
  let inFlight = 0;

  function middleware(req, res, next) {
    total += 1;
    inFlight += 1;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      inFlight -= 1;
      const cls = Math.floor(res.statusCode / 100);
      const key = cls >= 2 && cls <= 5 ? `${cls}xx` : 'other';
      byStatusClass[key] += 1;
    };
    res.on('finish', finish);
    res.on('close', finish);
    next();
  }

  function snapshot() {
    const mem = memory();
    return {
      startedAt: new Date(startedAt).toISOString(),
      uptimeSeconds: Math.floor((now() - startedAt) / 1000),
      requests: { total, inFlight, byStatusClass: { ...byStatusClass } },
      memory: {
        rssMb: Math.round(mem.rss / 1048576),
        heapUsedMb: Math.round(mem.heapUsed / 1048576),
      },
    };
  }

  return { middleware, snapshot };
}
