export function parseCookies(req, _res, next) {
  const header = req.headers.cookie;
  const cookies = {};
  if (header) {
    for (const part of header.split(';')) {
      const eq = part.indexOf('=');
      if (eq <= 0) continue;
      const name = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      if (!name) continue;
      try {
        cookies[name] = decodeURIComponent(value);
      } catch {
        cookies[name] = value;
      }
    }
  }
  req.cookies = cookies;
  next();
}

export function originGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const target = req.headers.origin || req.headers.referer;
  if (!target) return next();
  let url;
  try {
    url = new URL(target);
  } catch {
    return res.status(403).json({ error: 'cross_origin_forbidden' });
  }
  const expectedHost = req.headers.host;
  if (url.host.toLowerCase() !== String(expectedHost).toLowerCase()) {
    return res.status(403).json({ error: 'cross_origin_forbidden' });
  }
  next();
}