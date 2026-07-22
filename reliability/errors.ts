/**
 * Structured error types for the reliability layer.
 *
 * Each error carries a stable `category` string for logging and a `retryable`
 * flag so the retry logic can decide without instanceof chains. The original
 * error is preserved as `cause` where supported.
 */

export type ErrorCategory =
  | 'timeout'
  | 'rate_limit'
  | 'authentication'
  | 'not_found'
  | 'invalid_tool_response'
  | 'external_service'
  | 'permission'
  | 'validation'
  | 'unknown';

export abstract class ReliabilityError extends Error {
  abstract readonly category: ErrorCategory;
  abstract readonly retryable: boolean;
  readonly userMessage: string;

  constructor(message: string, userMessage: string, cause?: unknown) {
    super(message, cause instanceof Error ? { cause } : undefined);
    this.name = this.constructor.name;
    this.userMessage = userMessage;
  }
}

/** An operation exceeded its configured timeout. Retriable. */
export class TimeoutError extends ReliabilityError {
  readonly category = 'timeout' as const;
  readonly retryable = true;
  constructor(
    message: string,
    readonly durationMs: number,
    cause?: unknown,
  ) {
    super(
      message,
      'The repository service timed out. You can retry the request.',
      cause,
    );
  }
}

/** HTTP 429 or an explicit rate-limit signal. Retriable with backoff. */
export class RateLimitError extends ReliabilityError {
  readonly category = 'rate_limit' as const;
  readonly retryable = true;
  constructor(
    message: string,
    readonly retryAfterMs?: number,
    cause?: unknown,
  ) {
    super(
      message,
      'Repository search is temporarily unavailable due to rate limiting. Please retry shortly.',
      cause,
    );
  }
}

/** HTTP 401/403 or missing credentials. Not retryable. */
export class AuthenticationError extends ReliabilityError {
  readonly category = 'authentication' as const;
  readonly retryable = false;
  constructor(message: string, cause?: unknown) {
    super(
      message,
      'Authentication failed. Check that the configured API key is valid.',
      cause,
    );
  }
}

/** HTTP 403 or filesystem EACCES. Not retryable. */
export class PermissionError extends ReliabilityError {
  readonly category = 'permission' as const;
  readonly retryable = false;
  constructor(message: string, cause?: unknown) {
    super(
      message,
      'Permission denied. The configured credentials lack access to this resource.',
      cause,
    );
  }
}

/** File or resource not found (ENOENT, HTTP 404). Not retryable. */
export class NotFoundError extends ReliabilityError {
  readonly category = 'not_found' as const;
  readonly retryable = false;
  constructor(message: string, cause?: unknown) {
    super(
      message,
      'I could not access that file because it does not exist or is not accessible.',
      cause,
    );
  }
}

/** Tool returned malformed/missing/oversized output. Not retryable. */
export class InvalidToolResponseError extends ReliabilityError {
  readonly category = 'invalid_tool_response' as const;
  readonly retryable = false;
  constructor(message: string, cause?: unknown) {
    super(
      message,
      'The tool returned an unexpected response. The result was discarded.',
      cause,
    );
  }
}

/** Catch-all for transient external failures (HTTP 5xx, connection reset). */
export class ExternalServiceError extends ReliabilityError {
  readonly category = 'external_service' as const;
  readonly retryable = true;
  constructor(message: string, userMessage?: string, cause?: unknown) {
    super(
      message,
      userMessage ??
        'Repository search is temporarily unavailable. I could not verify the answer.',
      cause,
    );
  }
}

/** Map a raw error to a {@link ReliabilityError} subclass when possible. */
export function classifyError(error: unknown): ReliabilityError {
  if (error instanceof ReliabilityError) return error;

  if (error instanceof Error) {
    const msg = error.message;

    // Node filesystem codes
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return new NotFoundError(msg, error);
    if (code === 'EACCES' || code === 'EPERM')
      return new PermissionError(msg, error);
    if (code === 'ETIMEDOUT' || code === 'ECONNABORTED' || msg.includes('timeout'))
      return new TimeoutError(msg, 0, error);
    if (code === 'ECONNRESET' || code === 'ECONNREFUSED')
      return new ExternalServiceError(msg, undefined, error);

    // HTTP-like patterns in message
    if (/\b401\b/.test(msg) || /unauthor/i.test(msg))
      return new AuthenticationError(msg, error);
    if (/\b403\b/.test(msg) || /forbidden/i.test(msg))
      return new PermissionError(msg, error);
    if (/\b404\b/.test(msg) || /not found/i.test(msg))
      return new NotFoundError(msg, error);
    if (/\b408\b/.test(msg) || /request timeout/i.test(msg))
      return new TimeoutError(msg, 0, error);
    if (/\b429\b/.test(msg) || /rate.?limit/i.test(msg))
      return new RateLimitError(msg, undefined, error);
    if (/\b50[0234]\b/.test(msg))
      return new ExternalServiceError(msg, undefined, error);
  }

  return new ExternalServiceError(
    error instanceof Error ? error.message : String(error),
    undefined,
    error,
  );
}
