import { defineTool, type ToolDefinition } from '@flue/runtime';
import type { DebugLogger, InspectionMetadata, StepBudget } from '../tools/repository.ts';
import { summarizeInput, wrapWithBudget } from '../tools/repository.ts';
import { classifyError, type ReliabilityError } from './errors.ts';
import { runWithRetry, type RetryConfig, type SleepFn, defaultSleep } from './retry.ts';
import type { ReliabilityLogger } from './observability.ts';
import type { FailureInjector } from './failure-injection.ts';
import { noFailureInjection } from './failure-injection.ts';
import {
  validateListResult,
  validateReadResult,
  validateSearchDocsResult,
  validateSearchResult,
  type ValidationResult,
} from './validation.ts';

export type ToolValidator<T> = (output: unknown) => ValidationResult<T>;

const validators: Record<string, ToolValidator<unknown>> = {
  list_files: validateListResult,
  read_file: validateReadResult,
  search_code: validateSearchResult,
  search_docs: validateSearchDocsResult,
};

/**
 * Wrap an existing tool's `run` with retry, timeout, output validation, and
 * failure injection. The wrapper consumes exactly one inspection step per
 * *logical* call (not per retry attempt), so retries do not multiply budget
 * consumption.
 *
 * The raw tool must be created with a pass-through budget so its internal
 * `consume()` calls are no-ops; the wrapper consumes the real budget once.
 */
export function wrapToolWithReliability(
  rawTool: ToolDefinition,
  budget: StepBudget,
  debug: DebugLogger,
  retryConfig: RetryConfig,
  reliabilityLog: ReliabilityLogger,
  injector: FailureInjector = noFailureInjection,
  sleep: SleepFn = defaultSleep,
): ToolDefinition {
  const validator = validators[rawTool.name];

  return defineTool({
    name: rawTool.name,
    description: rawTool.description,
    input: rawTool.input,
    output: rawTool.output,
    async run({ input, signal }) {
      signal?.throwIfAborted();

      // Consume budget once for this logical call (not per retry)
      const inspection: InspectionMetadata = budget.consume(rawTool.name);
      const inputSummary = summarizeInput(input);

      try {
        const result = await runWithRetry(
          rawTool.name,
          async (retrySignal) => {
            if (injector.shouldTimeout(rawTool.name)) {
              // Hang until the timeout fires
              await new Promise<void>(() => {});
              throw new Error('timeout');
            }

            const injected = injector.maybeFail(rawTool.name, 0);
            if (injected) throw injected;

            const combinedSignal = retrySignal.aborted
              ? retrySignal
              : signal && signal.aborted
                ? signal
                : retrySignal;

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const output = await rawTool.run({
              input: input as any,
              signal: combinedSignal,
            });

            if (injector.shouldMalform(rawTool.name)) {
              return {
                __malformed: true,
                garbage: '###not-json###',
                partial: 'garbled',
              };
            }

            return output;
          },
          retryConfig,
          reliabilityLog,
          sleep,
        );

        // Validate the output
        if (validator) {
          const validation = validator(result);
          if (!validation.ok) {
            debug.log({
              tool: rawTool.name,
              status: 'error',
              inputSummary,
              inspection,
            });
            throw validation.error;
          }
        }

        debug.log({
          tool: rawTool.name,
          status: 'success',
          inputSummary,
          count: countResult(rawTool.name, result),
          inspection,
        });

        return result;
      } catch (error) {
        debug.log({
          tool: rawTool.name,
          status: 'error',
          inputSummary,
          inspection,
        });

        const classified = classifyError(error);
        throw wrapWithBudget(
          new SafeToolError(rawTool.name, classified),
          rawTool.name,
          inspection,
        );
      }
    },
  });
}

/**
 * Error that exposes a user-safe message without stack traces, provider
 * internals, or API keys. The original error is preserved as `cause`.
 */
export class SafeToolError extends Error {
  constructor(
    readonly toolName: string,
    readonly reliabilityError: ReliabilityError,
  ) {
    super(
      `${toolName}: ${reliabilityError.userMessage}`,
      { cause: reliabilityError },
    );
    this.name = 'SafeToolError';
  }
}

function countResult(toolName: string, result: unknown): number | undefined {
  if (toolName === 'search_code' || toolName === 'search_docs') {
    const matches = (result as { matches?: unknown[] })?.matches;
    return Array.isArray(matches) ? matches.length : undefined;
  }
  if (toolName === 'list_files') {
    const entries = (result as { entries?: unknown[] })?.entries;
    return Array.isArray(entries) ? entries.length : undefined;
  }
  if (toolName === 'read_file') {
    const total = (result as { totalLines?: number })?.totalLines;
    return total;
  }
  return undefined;
}
