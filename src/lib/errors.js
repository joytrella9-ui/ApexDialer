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
  const status = err instanceof HttpError ? err.status : 500;
  if (status >= 500) {
    console.error('[apexdialer] unhandled error:', err);
  }
  const body = { error: status >= 500 ? 'internal_error' : err.message };
  if (err instanceof HttpError && err.details) body.details = err.details;
  res.status(status).json(body);
}