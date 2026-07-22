import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { ToolDefinition } from '@flue/runtime';
import type { InspectionMetadata } from '../tools/repository.ts';
import {
  createDebugLogger,
  createPassThroughBudget,
  createRepositoryReader,
  createStepBudget,
} from '../tools/repository.ts';
import { createListFilesTool } from '../tools/list-files.ts';
import { createReadFileTool } from '../tools/read-file.ts';
import { createSearchCodeTool } from '../tools/search-code.ts';
import {
  AuthenticationError,
  classifyError,
  ExternalServiceError,
  InvalidToolResponseError,
  NotFoundError,
  RateLimitError,
  TimeoutError,
} from '../reliability/errors.ts';
import {
  backoffDelay,
  isTransient,
  parseRetryConfig,
  runWithRetry,
  type RetryConfig,
  type SleepFn,
} from '../reliability/retry.ts';
import { createReliabilityLogger } from '../reliability/observability.ts';
import {
  createFailureInjector,
  noFailureInjection,
} from '../reliability/failure-injection.ts';
import { wrapToolWithReliability, SafeToolError } from '../reliability/resilient-tool.ts';
import {
  validateContentSize,
  validateReadResult,
  validateSearchResult,
} from '../reliability/validation.ts';
import {
  executeWithFallback,
} from '../reliability/fallback.ts';
import { createSampleRepo, removeRepo } from './helpers.ts';

const noDebug = () => createDebugLogger(false);
const noReliabilityLog = () => createReliabilityLogger(false);
const fastRetry: RetryConfig = {
  maxAttempts: 3,
  initialDelayMs: 1,
  maxDelayMs: 10,
  timeoutMs: 2_000,
};

// Mock sleep that resolves immediately for fast tests
const instantSleep: SleepFn = () => Promise.resolve();

let root: string;

before(async () => {
  root = await createSampleRepo();
});

after(async () => {
  await removeRepo(root);
});

// ---------------------------------------------------------------------------
// 1. Error classification
// ---------------------------------------------------------------------------

describe('error classification', () => {
  test('TimeoutError is retryable', () => {
    const err = new TimeoutError('timed out', 5000);
    assert.equal(err.retryable, true);
    assert.equal(err.category, 'timeout');
    assert.ok(err.userMessage.length > 0);
    assert.ok(!err.userMessage.includes('stack'));
  });

  test('RateLimitError is retryable', () => {
    const err = new RateLimitError('429 Too Many Requests', 1000);
    assert.equal(err.retryable, true);
    assert.equal(err.category, 'rate_limit');
  });

  test('AuthenticationError is not retryable', () => {
    const err = new AuthenticationError('401 Unauthorized');
    assert.equal(err.retryable, false);
    assert.equal(err.category, 'authentication');
  });

  test('NotFoundError is not retryable', () => {
    const err = new NotFoundError('ENOENT: no such file');
    assert.equal(err.retryable, false);
    assert.equal(err.category, 'not_found');
  });

  test('InvalidToolResponseError is not retryable', () => {
    const err = new InvalidToolResponseError('missing field');
    assert.equal(err.retryable, false);
    assert.equal(err.category, 'invalid_tool_response');
  });

  test('classifyError maps ENOENT to NotFoundError', () => {
    const e = new Error('not found') as NodeJS.ErrnoException;
    e.code = 'ENOENT';
    const classified = classifyError(e);
    assert.equal(classified.category, 'not_found');
    assert.equal(classified.retryable, false);
  });

  test('classifyError maps EACCES to PermissionError', () => {
    const e = new Error('permission denied') as NodeJS.ErrnoException;
    e.code = 'EACCES';
    const classified = classifyError(e);
    assert.equal(classified.category, 'permission');
    assert.equal(classified.retryable, false);
  });

  test('classifyError maps 503 to ExternalServiceError (retryable)', () => {
    const e = new Error('HTTP 503 Service Unavailable');
    const classified = classifyError(e);
    assert.equal(classified.category, 'external_service');
    assert.equal(classified.retryable, true);
  });

  test('classifyError maps 429 to RateLimitError (retryable)', () => {
    const e = new Error('HTTP 429 Too Many Requests');
    const classified = classifyError(e);
    assert.equal(classified.category, 'rate_limit');
    assert.equal(classified.retryable, true);
  });

  test('user messages never contain stack traces', () => {
    const errors = [
      new TimeoutError('at /internal/path.ts:42', 1000),
      new AuthenticationError('at /auth/provider.ts:10:5 key=sk-xxx'),
      new NotFoundError('at /fs/read.ts:88'),
      new ExternalServiceError('at /http/client.ts:200 token=abc123'),
    ];
    for (const err of errors) {
      assert.ok(err.userMessage.length > 0);
      assert.doesNotMatch(err.userMessage, /at \//);
      assert.doesNotMatch(err.userMessage, /sk-|token=|key=/i);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Retry logic
// ---------------------------------------------------------------------------

describe('runWithRetry', () => {
  test('first attempt fails with transient error, second attempt succeeds', async () => {
    let calls = 0;
    const result = await runWithRetry(
      'test-op',
      async () => {
        calls += 1;
        if (calls === 1) throw new Error('HTTP 503 Service Unavailable');
        return 'success';
      },
      fastRetry,
      noReliabilityLog(),
      instantSleep,
    );
    assert.equal(result, 'success');
    assert.equal(calls, 2);
  });

  test('all retry attempts fail with transient errors', async () => {
    let calls = 0;
    await assert.rejects(
      runWithRetry(
        'test-op',
        async () => {
          calls += 1;
          throw new Error('HTTP 503 Service Unavailable');
        },
        fastRetry,
        noReliabilityLog(),
        instantSleep,
      ),
      /Service Unavailable|external/i,
    );
    assert.equal(calls, 3); // maxAttempts
  });

  test('permanent error is not retried', async () => {
    let calls = 0;
    await assert.rejects(
      runWithRetry(
        'test-op',
        async () => {
          calls += 1;
          throw new AuthenticationError('401 Unauthorized');
        },
        fastRetry,
        noReliabilityLog(),
        instantSleep,
      ),
      /Authentication/i,
    );
    assert.equal(calls, 1);
  });

  test('NotFoundError is not retried', async () => {
    let calls = 0;
    await assert.rejects(
      runWithRetry(
        'test-op',
        async () => {
          calls += 1;
          throw new NotFoundError('file not found');
        },
        fastRetry,
        noReliabilityLog(),
        instantSleep,
      ),
      /not found/i,
    );
    assert.equal(calls, 1);
  });

  test('request exceeds its timeout', async () => {
    const config: RetryConfig = {
      maxAttempts: 1,
      initialDelayMs: 1,
      maxDelayMs: 10,
      timeoutMs: 50, // 50ms timeout
    };
    await assert.rejects(
      runWithRetry(
        'test-op',
        async (signal) => {
          // Simulate a long operation that respects the abort signal
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, 10_000);
            signal.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(new Error('timeout: operation aborted'));
            });
          });
          return 'should not reach';
        },
        config,
        noReliabilityLog(),
        instantSleep,
      ),
      /timeout/i,
    );
  });

  test('isTransient correctly classifies errors', () => {
    assert.equal(isTransient(new TimeoutError('t', 100)), true);
    assert.equal(isTransient(new RateLimitError('r')), true);
    assert.equal(isTransient(new ExternalServiceError('e')), true);
    assert.equal(isTransient(new AuthenticationError('a')), false);
    assert.equal(isTransient(new NotFoundError('n')), false);
    assert.equal(isTransient(new InvalidToolResponseError('i')), false);
  });

  test('backoffDelay stays within bounds', () => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      const delay = backoffDelay(attempt, 500, 5_000);
      assert.ok(delay >= 0);
      assert.ok(delay <= 5_000);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. parseRetryConfig
// ---------------------------------------------------------------------------

describe('parseRetryConfig', () => {
  test('uses defaults with empty env', () => {
    const config = parseRetryConfig({});
    assert.equal(config.maxAttempts, 3);
    assert.equal(config.initialDelayMs, 500);
    assert.equal(config.maxDelayMs, 5_000);
    assert.equal(config.timeoutMs, 15_000);
  });

  test('overrides from env', () => {
    const config = parseRetryConfig({
      REPO_ASSISTANT_MAX_ATTEMPTS: '5',
      REPO_ASSISTANT_INITIAL_DELAY_MS: '200',
      REPO_ASSISTANT_MAX_DELAY_MS: '3000',
      REPO_ASSISTANT_TIMEOUT_MS: '8000',
    });
    assert.equal(config.maxAttempts, 5);
    assert.equal(config.initialDelayMs, 200);
    assert.equal(config.maxDelayMs, 3_000);
    assert.equal(config.timeoutMs, 8_000);
  });

  test('falls back to defaults for invalid values', () => {
    const config = parseRetryConfig({
      REPO_ASSISTANT_MAX_ATTEMPTS: 'not-a-number',
      REPO_ASSISTANT_TIMEOUT_MS: '-5',
    });
    assert.equal(config.maxAttempts, 3);
    assert.equal(config.timeoutMs, 15_000);
  });
});

// ---------------------------------------------------------------------------
// 4. Tool-output validation
// ---------------------------------------------------------------------------

describe('output validation', () => {
  test('validateSearchResult rejects malformed output', () => {
    const result = validateSearchResult({ __malformed: true, garbage: '###' });
    assert.equal(result.ok, false);
    assert.ok(result.error instanceof InvalidToolResponseError);
  });

  test('validateSearchResult rejects missing required fields', () => {
    const result = validateSearchResult({ matches: [], path: '.' });
    assert.equal(result.ok, false);
    assert.match(result.error.message, /filesSearched/);
  });

  test('validateSearchResult accepts valid output', () => {
    const valid = {
      matches: [{ path: 'src/auth.ts', line: 1, excerpt: 'export function login' }],
      filesSearched: 5,
      query: 'login',
      path: '.',
      truncated: false,
      inspection: { used: 1, remaining: 7, limit: 8 },
    };
    const result = validateSearchResult(valid);
    assert.equal(result.ok, true);
  });

  test('validateReadResult rejects oversized content', () => {
    const oversized = {
      path: 'big.ts',
      content: 'x'.repeat(200_001),
      startLine: 1,
      endLine: 1,
      totalLines: 1,
      truncated: false,
      inspection: { used: 1, remaining: 7, limit: 8 },
    };
    const result = validateReadResult(oversized);
    assert.equal(result.ok, false);
    assert.match(result.error.message, /exceeds/);
  });

  test('validateReadResult accepts valid output', () => {
    const valid = {
      path: 'src/config.ts',
      content: '1: export const PORT = 3000;',
      startLine: 1,
      endLine: 1,
      totalLines: 4,
      truncated: false,
      inspection: { used: 1, remaining: 7, limit: 8 },
    };
    const result = validateReadResult(valid);
    assert.equal(result.ok, true);
  });

  test('validateContentSize rejects oversized strings', () => {
    const result = validateContentSize('x'.repeat(200_001));
    assert.equal(result.ok, false);
  });

  test('validateSearchResult rejects match with invalid line type', () => {
    const invalid = {
      matches: [{ path: 'x.ts', line: 'not-a-number', excerpt: 'text' }],
      filesSearched: 1,
      query: 'x',
      path: '.',
      truncated: false,
      inspection: { used: 1, remaining: 7, limit: 8 },
    };
    const result = validateSearchResult(invalid);
    assert.equal(result.ok, false);
    assert.match(result.error.message, /path\/line\/excerpt/);
  });
});

// ---------------------------------------------------------------------------
// 5. Resilient tool wrapper
// ---------------------------------------------------------------------------

describe('wrapToolWithReliability', () => {
  test('successful call passes through after validation', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(8);
    const passThrough = createPassThroughBudget(budget);
    const rawTool = createReadFileTool(repository, passThrough, noDebug());
    const wrapped = wrapToolWithReliability(
      rawTool, budget, noDebug(), fastRetry, noReliabilityLog(), noFailureInjection,
    );
    const result = await wrapped.run({
      input: { path: 'src/config.ts', startLine: 1 },
    }) as { content: string; inspection: InspectionMetadata };
    assert.match(result.content, /PORT/);
    assert.equal(result.inspection.used, 1);
  });

  test('retries transient failure then succeeds', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(8);
    let rawCalls = 0;
    const rawTool: ToolDefinition = {
      name: 'search_code',
      description: 'test',
      input: undefined,
      output: undefined,
      async run() {
        rawCalls += 1;
        if (rawCalls === 1) throw new Error('HTTP 503 Service Unavailable');
        return {
          matches: [{ path: 'x.ts', line: 1, excerpt: 'found' }],
          filesSearched: 1,
          query: 'x',
          path: '.',
          truncated: false,
          inspection: { used: 1, remaining: 7, limit: 8 },
        };
      },
    };
    const wrapped = wrapToolWithReliability(
      rawTool, budget, noDebug(), fastRetry, noReliabilityLog(), noFailureInjection, instantSleep,
    );
    const result = await wrapped.run({
      input: { query: 'x', path: '.', caseSensitive: false },
    }) as { matches: unknown[] };
    assert.equal(rawCalls, 2);
    assert.ok(result.matches.length > 0);
  });

  test('permanent error is not retried and produces SafeToolError', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(8);
    let rawCalls = 0;
    const rawTool: ToolDefinition = {
      name: 'read_file',
      description: 'test',
      input: undefined,
      output: undefined,
      async run() {
        rawCalls += 1;
        throw new Error('HTTP 401 Unauthorized');
      },
    };
    const wrapped = wrapToolWithReliability(
      rawTool, budget, noDebug(), fastRetry, noReliabilityLog(), noFailureInjection, instantSleep,
    );
    await assert.rejects(
      wrapped.run({ input: { path: 'x.ts', startLine: 1 } }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        // The error message should be user-safe (no stack traces)
        assert.doesNotMatch((err as Error).message, /at \//);
        assert.equal(rawCalls, 1);
        return true;
      },
    );
  });

  test('malformed output is rejected with InvalidToolResponseError', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(8);
    const rawTool: ToolDefinition = {
      name: 'search_code',
      description: 'test',
      input: undefined,
      output: undefined,
      async run() {
        return { __malformed: true, garbage: '###' };
      },
    };
    const wrapped = wrapToolWithReliability(
      rawTool, budget, noDebug(), fastRetry, noReliabilityLog(), noFailureInjection, instantSleep,
    );
    await assert.rejects(
      wrapped.run({ input: { query: 'x', path: '.', caseSensitive: false } }),
      /failed/i,
    );
  });

  test('retries do not consume additional budget', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(8);
    let rawCalls = 0;
    const rawTool: ToolDefinition = {
      name: 'search_code',
      description: 'test',
      input: undefined,
      output: undefined,
      async run() {
        rawCalls += 1;
        if (rawCalls < 3) throw new Error('HTTP 503');
        return {
          matches: [], filesSearched: 1, query: 'x', path: '.',
          truncated: false, inspection: budget.snapshot(),
        };
      },
    };
    const wrapped = wrapToolWithReliability(
      rawTool, budget, noDebug(), fastRetry, noReliabilityLog(), noFailureInjection, instantSleep,
    );
    await wrapped.run({ input: { query: 'x', path: '.', caseSensitive: false } });
    assert.equal(rawCalls, 3);
    // Only 1 budget slot consumed, not 3
    assert.equal(budget.used, 1);
  });
});

// ---------------------------------------------------------------------------
// 6. Fallback behaviour
// ---------------------------------------------------------------------------

describe('fallback', () => {
  test('primary tool fails transiently, fallback read_file succeeds', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(8);
    const readFile = createReadFileTool(repository, budget, noDebug());
    const failingSearch: ToolDefinition = {
      name: 'search_code',
      description: 'test',
      input: undefined,
      output: undefined,
      async run() {
        throw new ExternalServiceError('HTTP 503');
      },
    };
    const result = await executeWithFallback(
      failingSearch,
      readFile,
      { query: 'auth', path: '.', caseSensitive: false },
      'src/auth.ts',
      'search_with_fallback',
      budget,
      noDebug(),
      fastRetry,
      noReliabilityLog(),
    );
    assert.equal(result.primarySucceeded, false);
    assert.equal(result.fallbackUsed, true);
    assert.equal(result.fallbackSucceeded, true);
    assert.ok(result.partialMessage?.includes('fallback'));
  });

  test('both primary and fallback fail', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(8);
    const failingSearch: ToolDefinition = {
      name: 'search_code',
      description: 'test',
      input: undefined,
      output: undefined,
      async run() {
        throw new ExternalServiceError('HTTP 503');
      },
    };
    const failingRead: ToolDefinition = {
      name: 'read_file',
      description: 'test',
      input: undefined,
      output: undefined,
      async run() {
        throw new NotFoundError('file not found');
      },
    };
    const result = await executeWithFallback(
      failingSearch,
      failingRead,
      { query: 'auth', path: '.', caseSensitive: false },
      'nonexistent.ts',
      'search_with_fallback',
      budget,
      noDebug(),
      fastRetry,
      noReliabilityLog(),
    );
    assert.equal(result.primarySucceeded, false);
    assert.equal(result.fallbackUsed, true);
    assert.equal(result.fallbackSucceeded, false);
    assert.ok(result.partialMessage);
    assert.match(result.partialMessage, /retry/i);
  });

  test('permanent error does not trigger fallback', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(8);
    const readFile = createReadFileTool(repository, budget, noDebug());
    const authFailingSearch: ToolDefinition = {
      name: 'search_code',
      description: 'test',
      input: undefined,
      output: undefined,
      async run() {
        throw new AuthenticationError('401 Unauthorized');
      },
    };
    const result = await executeWithFallback(
      authFailingSearch,
      readFile,
      { query: 'auth', path: '.', caseSensitive: false },
      'src/auth.ts',
      'search_with_fallback',
      budget,
      noDebug(),
      fastRetry,
      noReliabilityLog(),
    );
    assert.equal(result.primarySucceeded, false);
    assert.equal(result.fallbackUsed, false);
    assert.equal(result.fallbackSucceeded, false);
    assert.ok(result.partialMessage);
    assert.doesNotMatch(result.partialMessage, /at \//);
  });
});

// ---------------------------------------------------------------------------
// 7. User-facing error safety
// ---------------------------------------------------------------------------

describe('user-facing error safety', () => {
  test('SafeToolError message contains no stack traces or secrets', () => {
    const internal = new ExternalServiceError(
      'at /internal/provider.ts:42 token=sk-abc123',
    );
    const safe = new SafeToolError('search_code', internal);
    assert.doesNotMatch(safe.message, /at \//);
    assert.doesNotMatch(safe.message, /sk-|token=/i);
    assert.ok(safe.message.length > 0);
  });

  test('SafeToolError message contains no absolute paths', () => {
    const internal = new TimeoutError(
      'operation at /home/user/workspace/repo/tools/x.ts timed out',
      5000,
    );
    const safe = new SafeToolError('read_file', internal);
    assert.doesNotMatch(safe.message, /\/home\//);
    assert.doesNotMatch(safe.message, /\/workspace\//);
  });

  test('all reliability error userMessages are safe', () => {
    const errors = [
      new TimeoutError('internal stack at /x.ts:1', 1000),
      new RateLimitError('internal at /y.ts:2 key=secret', 1000),
      new AuthenticationError('at /z.ts:3'),
      new NotFoundError('at /a.ts:4'),
      new InvalidToolResponseError('at /b.ts:5'),
      new ExternalServiceError('at /c.ts:6 token=abc'),
    ];
    for (const err of errors) {
      assert.doesNotMatch(err.userMessage, /at \//);
      assert.doesNotMatch(err.userMessage, /sk-|token=|key=/i);
      assert.doesNotMatch(err.userMessage, /\/home\//);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Failure injection
// ---------------------------------------------------------------------------

describe('failure injection', () => {
  test('noFailureInjection is a no-op', () => {
    assert.equal(noFailureInjection.maybeFail('any', 1), undefined);
    assert.equal(noFailureInjection.shouldTimeout('any'), false);
    assert.equal(noFailureInjection.shouldMalform('any'), false);
  });

  test('FAIL_FIRST_N_REQUESTS injects transient failures', () => {
    const injector = createFailureInjector({ FAIL_FIRST_N_REQUESTS: '2' });
    assert.ok(injector.maybeFail('search_code', 1));
    assert.ok(injector.maybeFail('search_code', 1));
    assert.equal(injector.maybeFail('search_code', 1), undefined);
  });

  test('SIMULATE_TOOL_TIMEOUT makes operations hang', () => {
    const injector = createFailureInjector({ SIMULATE_TOOL_TIMEOUT: 'true' });
    assert.equal(injector.shouldTimeout('search_code'), true);
  });

  test('SIMULATE_MALFORMED_RESPONSE garbles output', () => {
    const injector = createFailureInjector({ SIMULATE_MALFORMED_RESPONSE: 'true' });
    assert.equal(injector.shouldMalform('read_file'), true);
  });

  test('FAIL_OPERATION restricts to one operation', () => {
    const injector = createFailureInjector({
      FAIL_FIRST_N_REQUESTS: '1',
      FAIL_OPERATION: 'search_code',
    });
    assert.ok(injector.maybeFail('search_code', 1));
    assert.equal(injector.maybeFail('read_file', 1), undefined);
  });

  test('no env vars returns no-op injector', () => {
    const injector = createFailureInjector({});
    assert.equal(injector.maybeFail('any', 1), undefined);
  });
});

// ---------------------------------------------------------------------------
// 9. Reliability observability
// ---------------------------------------------------------------------------

describe('reliability observability', () => {
  test('logs structured events when enabled', async () => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => lines.push(args.join(' '));
    try {
      const logger = createReliabilityLogger(true);
      let calls = 0;
      await runWithRetry(
        'test-op',
        async () => {
          calls += 1;
          if (calls === 1) throw new Error('HTTP 503');
          return 'ok';
        },
        fastRetry,
        logger,
        instantSleep,
      );
    } finally {
      console.error = original;
    }
    const logLines = lines.filter((l) => l.includes('repo-assistant:reliability'));
    assert.ok(logLines.length >= 2);
    // First attempt should be error
    assert.match(logLines[0], /"outcome":"error"/);
    // Should contain attempt and operation
    assert.match(logLines[0], /"operation":"test-op"/);
    assert.match(logLines[0], /"attempt":1/);
    // Should not contain secrets
    assert.doesNotMatch(logLines[0], /sk-|token=|key=/i);
  });

  test('disabled logger produces no output', async () => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => lines.push(args.join(' '));
    try {
      const logger = createReliabilityLogger(false);
      await runWithRetry(
        'test-op',
        async () => 'ok',
        fastRetry,
        logger,
        instantSleep,
      );
    } finally {
      console.error = original;
    }
    assert.equal(lines.filter((l) => l.includes('reliability')).length, 0);
  });
});
