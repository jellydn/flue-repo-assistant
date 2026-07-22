import { classifyError, ReliabilityError } from './errors.ts';
import type { ReliabilityLogger } from './observability.ts';

/**
 * Configurable retry policy. All values can be overridden through environment
 * variables parsed by {@link parseRetryConfig}.
 */
export type RetryConfig = {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  /** Per-operation timeout in milliseconds. */
  timeoutMs: number;
};

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  initialDelayMs: 500,
  maxDelayMs: 5_000,
  timeoutMs: 15_000,
};

export function parseRetryConfig(env: Record<string, string | undefined>): RetryConfig {
  const num = (key: string, fallback: number, min = 1, max = Infinity) => {
    const raw = env[key];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min || n > max) return fallback;
    return n;
  };
  return {
    maxAttempts: num('REPO_ASSISTANT_MAX_ATTEMPTS', DEFAULT_RETRY_CONFIG.maxAttempts, 1, 10),
    initialDelayMs: num('REPO_ASSISTANT_INITIAL_DELAY_MS', DEFAULT_RETRY_CONFIG.initialDelayMs, 0, 60_000),
    maxDelayMs: num('REPO_ASSISTANT_MAX_DELAY_MS', DEFAULT_RETRY_CONFIG.maxDelayMs, 1, 120_000),
    timeoutMs: num('REPO_ASSISTANT_TIMEOUT_MS', DEFAULT_RETRY_CONFIG.timeoutMs, 100, 300_000),
  };
}

/**
 * Compute exponential backoff with full jitter: delay is a random value
 * between 0 and `base * 2^(attempt-1)`, capped at `maxDelayMs`.
 */
export function backoffDelay(
  attempt: number,
  initialDelayMs: number,
  maxDelayMs: number,
): number {
  const expo = initialDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(expo, maxDelayMs);
  return Math.random() * capped;
}

/**
 * Determine whether an error is transient and should be retried.
 *
 * Retriable: timeout, rate_limit, external_service (5xx, connection reset).
 * Not retriable: authentication, permission, not_found, invalid_tool_response,
 * validation, unknown non-transient.
 */
export function isTransient(error: unknown): boolean {
  const classified = error instanceof ReliabilityError ? error : classifyError(error);
  return classified.retryable;
}

/**
 * Injectable sleep function. Tests pass a mock; production uses setTimeout.
 */
export type SleepFn = (ms: number) => Promise<void>;

export const defaultSleep: SleepFn = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `operation` with retry, exponential backoff + jitter, and a per-attempt
 * timeout. Only transient errors are retried; permanent errors fail
 * immediately. The timeout uses AbortController so it works with any
 * promise-based operation that accepts a signal.
 *
 * Nested retry layers MUST NOT each retry independently. Callers should pass
 * `maxAttempts: 1` at outer layers or use `runWithRetry` at only one level.
 */
export async function runWithRetry<T>(
  operation: string,
  fn: (signal: AbortSignal) => Promise<T>,
  config: RetryConfig,
  logger: ReliabilityLogger,
  sleep: SleepFn = defaultSleep,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      config.timeoutMs,
    );

    try {
      const result = await fn(controller.signal);
      const durationMs = Date.now() - start;
      clearTimeout(timer);
      logger.log({
        operation,
        attempt,
        maxAttempts: config.maxAttempts,
        durationMs,
        retried: attempt > 1,
        fallbackUsed: false,
        outcome: 'success',
      });
      return result;
    } catch (error) {
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      const classified = classifyError(error);
      const transient = classified.retryable;

      logger.log({
        operation,
        attempt,
        maxAttempts: config.maxAttempts,
        durationMs,
        errorCategory: classified.category,
        retried: attempt > 1,
        fallbackUsed: false,
        outcome: 'error',
        message: classified.userMessage,
      });

      lastError = classified;

      if (!transient || attempt >= config.maxAttempts) {
        throw classified;
      }

      const delay = backoffDelay(
        attempt,
        config.initialDelayMs,
        config.maxDelayMs,
      );
      await sleep(delay);
    }
  }

  // Unreachable, but satisfies the type checker
  throw lastError ?? new Error(`${operation} exhausted all attempts`);
}
