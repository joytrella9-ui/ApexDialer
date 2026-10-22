// Provider webhooks are signed over the exact public URL the provider called.
// Behind a reverse proxy or tunnel the Host seen by Express is often not that URL,
// so when APEX_PUBLIC_BASE_URL is set it is the only source used for verification.
// The public base must be an https origin with no credentials, path, query, or
// fragment; anything else is rejected at startup rather than silently ignored.
export function normalizePublicBaseUrl(value) {
  const raw = String(value ?? '').trim();
  if (raw === '') return '';
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('APEX_PUBLIC_BASE_URL must be an absolute https URL');
  }
  if (url.protocol !== 'https:') throw new Error('APEX_PUBLIC_BASE_URL must use https');
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('APEX_PUBLIC_BASE_URL must be an origin only (no path, query, or credentials)');
  }
  return url.origin;
}

// The URL a provider signed for this request.
export function webhookUrl(cfg, req) {
  if (cfg?.publicBaseUrl) return `${cfg.publicBaseUrl}${req.originalUrl}`;
  return `${req.protocol}://${req.get('host')}${req.originalUrl}`;
}
