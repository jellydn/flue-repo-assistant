import { defineTool, type ToolDefinition } from '@flue/runtime';
import * as v from 'valibot';
import type { DebugLogger, InspectionMetadata, StepBudget } from '../tools/repository.ts';
import { summarizeInput } from '../tools/repository.ts';
import { classifyError, type ReliabilityError } from './errors.ts';
import type { ReliabilityLogger } from './observability.ts';
import { runWithRetry, type RetryConfig } from './retry.ts';

/**
 * Fallback behaviour: when `search_code` repeatedly fails, attempt a direct
 * `read_file` if the requested path is known (e.g. from a plan step or a
 * previous partial result). If both fail, return a clear partial-response
 * message explaining what could not be retrieved.
 *
 * The fallback is implemented as a tool wrapper around search_code that
 * transparently falls back to read_file. It consumes exactly one inspection
 * step for the primary attempt and, if the fallback is used, one additional
 * step for the read_file call.
 */

export type FallbackResult = {
  primaryTool: string;
  primarySucceeded: boolean;
  fallbackUsed: boolean;
  fallbackSucceeded: boolean;
  result: unknown;
  partialMessage?: string;
  inspection: InspectionMetadata;
};

/**
 * Attempt search_code; if it fails, attempt read_file with the known path;
 * if both fail, return a partial-response message. Never fabricates data.
 */
export async function executeWithFallback(
  primaryTool: ToolDefinition,
  fallbackTool: ToolDefinition | undefined,
  input: Record<string, unknown>,
  knownPath: string | undefined,
  operation: string,
  budget: StepBudget,
  debug: DebugLogger,
  retryConfig: RetryConfig,
  reliabilityLog: ReliabilityLogger,
): Promise<FallbackResult> {
  const inspection = budget.consume(primaryTool.name);
  const inputSummary = summarizeInput(input);

  // Try primary (search_code)
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await runWithRetry(
      operation,
      async (signal) => primaryTool.run({ input: input as any, signal }),
      retryConfig,
      reliabilityLog,
    );

    reliabilityLog.log({
      operation: `${operation}:fallback`,
      attempt: 1,
      maxAttempts: 1,
      durationMs: 0,
      retried: false,
      fallbackUsed: false,
      outcome: 'success',
    });

    return {
      primaryTool: primaryTool.name,
      primarySucceeded: true,
      fallbackUsed: false,
      fallbackSucceeded: false,
      result,
      inspection,
    };
  } catch (primaryError) {
    const classifiedPrimary = classifyError(primaryError);

    // Don't fallback for permanent errors (auth, permission, not found)
    if (!classifiedPrimary.retryable) {
      reliabilityLog.log({
        operation: `${operation}:fallback`,
        attempt: 1,
        maxAttempts: 1,
        durationMs: 0,
        errorCategory: classifiedPrimary.category,
        retried: false,
        fallbackUsed: false,
        outcome: 'fallback_failed',
        message: classifiedPrimary.userMessage,
      });

      return {
        primaryTool: primaryTool.name,
        primarySucceeded: false,
        fallbackUsed: false,
        fallbackSucceeded: false,
        result: null,
        partialMessage: classifiedPrimary.userMessage,
        inspection,
      };
    }

    // Try fallback (read_file) if we have a known path
    if (fallbackTool && knownPath) {
      try {
        const fallbackInspection = budget.consume(fallbackTool.name);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fallbackResult = await runWithRetry(
          `${operation}:fallback`,
          async (signal) =>
            fallbackTool.run({
              input: { path: knownPath, startLine: 1 } as any,
              signal,
            }),
          retryConfig,
          reliabilityLog,
        );

        reliabilityLog.log({
          operation: `${operation}:fallback`,
          attempt: 1,
          maxAttempts: 1,
          durationMs: 0,
          retried: false,
          fallbackUsed: true,
          outcome: 'fallback_success',
        });

        return {
          primaryTool: primaryTool.name,
          primarySucceeded: false,
          fallbackUsed: true,
          fallbackSucceeded: true,
          result: fallbackResult,
          partialMessage:
            'Repository search is temporarily unavailable. I used direct file reading as a fallback and found partial context.',
          inspection: fallbackInspection,
        };
      } catch (fallbackError) {
        const classifiedFallback = classifyError(fallbackError);
        reliabilityLog.log({
          operation: `${operation}:fallback`,
          attempt: 1,
          maxAttempts: 1,
          durationMs: 0,
          errorCategory: classifiedFallback.category,
          retried: false,
          fallbackUsed: true,
          outcome: 'fallback_failed',
          message: classifiedFallback.userMessage,
        });

        return {
          primaryTool: primaryTool.name,
          primarySucceeded: false,
          fallbackUsed: true,
          fallbackSucceeded: false,
          result: null,
          partialMessage:
            'Repository search is temporarily unavailable and the fallback file read also failed. I could not verify the answer. You can retry the request.',
          inspection,
        };
      }
    }

    // No fallback available or no known path
    reliabilityLog.log({
      operation: `${operation}:fallback`,
      attempt: 1,
      maxAttempts: 1,
      durationMs: 0,
      errorCategory: classifiedPrimary.category,
      retried: false,
      fallbackUsed: false,
      outcome: 'fallback_failed',
      message: classifiedPrimary.userMessage,
    });

    return {
      primaryTool: primaryTool.name,
      primarySucceeded: false,
      fallbackUsed: false,
      fallbackSucceeded: false,
      result: null,
      partialMessage: `${classifiedPrimary.userMessage} You can retry the request.`,
      inspection,
    };
  }
}

/** User-facing messages for common failure scenarios. */
export const FALLBACK_MESSAGES = {
  searchFailed: 'Repository search is temporarily unavailable. I could not verify the answer.',
  fallbackSucceeded: 'I found partial context using a fallback, but the primary search failed.',
  bothFailed: 'Repository search and the fallback file read both failed. I could not retrieve the information. You can retry the request.',
  partial: 'I found partial context, but one supporting file could not be loaded.',
} as const;
