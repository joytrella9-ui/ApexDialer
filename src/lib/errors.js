export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

export function errorHandler(err, req, res, _next) {
  const status = err instanceof HttpError ? err.status : 500;
  if (status >= 500) {
    console.error('[apexdialer] unhandled error:', err);
  }
  res.status(status).json({ error: status >= 500 ? 'internal_error' : err.message });
}