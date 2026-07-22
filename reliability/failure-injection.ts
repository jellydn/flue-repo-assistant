/**
 * Failure injection for testing and demos.
 *
 * Controlled by environment variables:
 *   FAIL_FIRST_N_REQUESTS=2        Fail the first N calls to any operation
 *   SIMULATE_TOOL_TIMEOUT=true      Make operations hang until the timeout fires
 *   SIMULATE_MALFORMED_RESPONSE=true Return garbled output instead of real data
 *   FAIL_OPERATION=search_code      Restrict failure to one operation name
 *
 * In production this is a no-op passthrough. The injector is dependency-
 * injected into the reliability wrapper, so it can be replaced in tests.
 */

export type FailureInjector = {
  /** Return a simulated error for this attempt, or undefined to proceed. */
  maybeFail(operation: string, attempt: number): Error | undefined;
  /** Return true to make the operation hang (timeout will fire). */
  shouldTimeout(operation: string): boolean;
  /** Return true to return a malformed output instead of the real result. */
  shouldMalform(operation: string): boolean;
};

const noOpInjector: FailureInjector = {
  maybeFail: () => undefined,
  shouldTimeout: () => false,
  shouldMalform: () => false,
};

export { noOpInjector as noFailureInjection };

/** Parse failure-injection env vars into a {@link FailureInjector}. */
export function createFailureInjector(
  env: Record<string, string | undefined>,
): FailureInjector {
  const failFirstN = parseNum(env['FAIL_FIRST_N_REQUESTS'], 0);
  const timeoutOps = parseBool(env['SIMULATE_TOOL_TIMEOUT']);
  const malformOps = parseBool(env['SIMULATE_MALFORMED_RESPONSE']);
  const restrictedOp = env['FAIL_OPERATION'] ?? '';

  if (failFirstN === 0 && !timeoutOps && !malformOps) {
    return noOpInjector;
  }

  let callCount = 0;

  return {
    maybeFail(operation, attempt) {
      if (restrictedOp && operation !== restrictedOp) return undefined;
      if (failFirstN <= 0) return undefined;
      callCount += 1;
      if (callCount <= failFirstN) {
        // Simulate a transient 503 for the first N calls
        return new Error(
          `Simulated transient failure (503) for ${operation}, call ${callCount}/${failFirstN}`,
        );
      }
      return undefined;
    },
    shouldTimeout(operation) {
      if (restrictedOp && operation !== restrictedOp) return false;
      return timeoutOps;
    },
    shouldMalform(operation) {
      if (restrictedOp && operation !== restrictedOp) return false;
      return malformOps;
    },
  };
}

function parseNum(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function parseBool(raw: string | undefined): boolean {
  return raw === 'true' || raw === '1' || raw === 'yes';
}
