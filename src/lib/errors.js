import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }
}

export function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

export function errorHandler(err, req, res, _next) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'validation_error',
      details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  // HttpError is always thrown deliberately by our own code with a safe,
  // machine-readable message — expose it even for 5xx (e.g. 502 provider
  // failures). Only truly unexpected errors are masked as internal_error.
  if (err instanceof HttpError) {
    if (err.status >= 500) console.error('[apexdialer] request failed:', err.message);
    const body = { error: err.message };
    if (err.details) body.details = err.details;
    return res.status(err.status).json(body);
  }
  console.error('[apexdialer] unhandled error:', err);
  res.status(500).json({ error: 'internal_error' });
}