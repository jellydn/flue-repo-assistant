import type { ErrorCategory } from './errors.ts';

/**
 * Structured event emitted by the retry and fallback layers for observability.
 * Never contains secrets, file contents, or absolute paths.
 */
export type ReliabilityEvent = {
  operation: string;
  attempt: number;
  maxAttempts: number;
  durationMs: number;
  errorCategory?: ErrorCategory;
  retried: boolean;
  fallbackUsed: boolean;
  outcome: 'success' | 'error' | 'fallback_success' | 'fallback_failed' | 'partial';
  message?: string;
};

export type ReliabilityLogger = {
  log(event: ReliabilityEvent): void;
};

/**
 * Safe structured logger. Controlled by REPO_ASSISTANT_DEBUG. Logs one JSON
 * line per event to stderr. Never logs secrets, file contents, or absolute
 * paths—only the operation name, attempt counts, duration, error category,
 * and outcome.
 */
export function createReliabilityLogger(enabled: boolean): ReliabilityLogger {
  return {
    log(event) {
      if (!enabled) return;
      const safe = {
        operation: event.operation,
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        durationMs: Math.round(event.durationMs),
        errorCategory: event.errorCategory ?? null,
        retried: event.retried,
        fallbackUsed: event.fallbackUsed,
        outcome: event.outcome,
      };
      console.error(
        `[repo-assistant:reliability] ${JSON.stringify(safe)}`,
      );
    },
  };
}
