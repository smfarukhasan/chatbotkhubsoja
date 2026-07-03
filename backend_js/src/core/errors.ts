import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { logger } from './logging.js';

export class HttpError extends Error {
  public statusCode: number;
  public error: string;
  public detail: string | null;
  public details: any[];

  constructor(statusCode: number, error: string, message: string, detail: string | null = null, details: any[] = []) {
    super(message);
    this.statusCode = statusCode;
    this.error = error;
    this.detail = detail || message;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class BadRequestError extends HttpError {
  constructor(message: string, detail: string | null = null) {
    super(400, 'bad_request', message, detail);
  }
}

export class UnauthorizedError extends HttpError {
  constructor(message: string = 'Not authenticated', detail: string | null = null) {
    super(401, 'unauthorized', message, detail);
  }
}

export class ForbiddenError extends HttpError {
  constructor(message: string = 'Permission denied', detail: string | null = null) {
    super(403, 'forbidden', message, detail);
  }
}

export class NotFoundError extends HttpError {
  constructor(message: string = 'Resource not found', detail: string | null = null) {
    super(404, 'not_found', message, detail);
  }
}

export class ConflictError extends HttpError {
  constructor(message: string, detail: string | null = null) {
    super(409, 'conflict', message, detail);
  }
}

export const errorHandler = (
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const requestId = (req as any).requestId || null;

  // Handle Zod validation errors
  if (err instanceof ZodError) {
    const errorDetails = err.errors.map((e) => ({
      loc: e.path,
      msg: e.message,
      type: e.code,
    }));

    return res.status(422).json({
      error: 'validation_error',
      message: 'Request validation failed.',
      detail: 'Request validation failed.',
      request_id: requestId,
      details: errorDetails,
    });
  }

  // Handle Custom HttpError
  if (err instanceof HttpError) {
    return res.status(err.statusCode).json({
      error: err.error,
      message: err.message,
      detail: err.detail,
      request_id: requestId,
      details: err.details,
    });
  }

  // Handle standard express errors (e.g. invalid JSON body)
  if (err instanceof SyntaxError && 'status' in err && (err as any).status === 400 && 'body' in err) {
    return res.status(400).json({
      error: 'bad_request',
      message: 'Invalid JSON payload.',
      detail: err.message,
      request_id: requestId,
      details: [],
    });
  }

  // Debug: raw error output to stdout
  console.error('=== UNHANDLED ERROR DEBUG ===');
  console.error('Type:', typeof err, err?.constructor?.name);
  console.error('Message:', err?.message);
  console.error('Stack:', err?.stack);
  console.error('Full error:', JSON.stringify(err, Object.getOwnPropertyNames(err)));
  console.error('=== END DEBUG ===');

  // Log unhandled exceptions
  logger.error(`Unhandled application exception: ${err?.message || String(err)}`, {
    error_message: err?.message,
    stack: err?.stack,
    requestId,
  });

  return res.status(500).json({
    error: 'internal_server_error',
    message: 'An unexpected error occurred.',
    detail: 'An unexpected error occurred.',
    request_id: requestId,
    details: [],
  });
};
