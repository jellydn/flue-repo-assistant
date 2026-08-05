import type { AttributedFinding } from './specialists.ts';
import { findingSchema, type Finding } from './schema.ts';
import * as v from 'valibot';

export const ADVISOR_DECISIONS = ['accept', 'revise', 'reject'] as const;
export type AdvisorDecision = (typeof ADVISOR_DECISIONS)[number];

export type AdvisorInput = {
  finding: AttributedFinding;
  diff: string;
  repositoryContext?: string;
};

export type AdvisorResult = {
  decision: AdvisorDecision;
  finding?: Partial<Finding>;
  reason: string;
};

export type AdvisorRunner = (input: AdvisorInput, signal: AbortSignal) => Promise<unknown>;

export type AdvisorConfig = {
  enabled: boolean;
  model: string;
  timeoutMs: number;
};

export type AdvisedFinding = AttributedFinding & {
  advisor: {
    decision: AdvisorDecision;
    reason: string;
  };
};

export type AdvisorReport = {
  findings: AdvisedFinding[];
  decisions: Array<{
    title: string;
    path: string;
    decision: AdvisorDecision;
    reason: string;
  }>;
  errors: string[];
};

const DEFAULT_ADVISOR_TIMEOUT_MS = 30_000;
const MIN_ADVISOR_TIMEOUT_MS = 100;
const MAX_ADVISOR_TIMEOUT_MS = 300_000;

const advisorResultSchema = v.object({
  decision: v.picklist(ADVISOR_DECISIONS),
  finding: v.optional(v.unknown()),
  reason: v.pipe(v.string(), v.minLength(1), v.maxLength(2000)),
});

/** Parse advisor configuration without exposing provider credentials. */
export function parseAdvisorConfig(env: Record<string, string | undefined>): AdvisorConfig {
  const rawTimeout = env.PR_REVIEW_ADVISOR_TIMEOUT_MS;
  const timeoutMs =
    rawTimeout === undefined || rawTimeout === '' ? DEFAULT_ADVISOR_TIMEOUT_MS : Number(rawTimeout);
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < MIN_ADVISOR_TIMEOUT_MS ||
    timeoutMs > MAX_ADVISOR_TIMEOUT_MS
  ) {
    throw new Error(
      `PR_REVIEW_ADVISOR_TIMEOUT_MS must be an integer in [${MIN_ADVISOR_TIMEOUT_MS}, ${MAX_ADVISOR_TIMEOUT_MS}].`,
    );
  }
  return {
    enabled: env.PR_REVIEW_ADVISOR_ENABLED === 'true',
    model: env.PR_REVIEW_ADVISOR_MODEL ?? 'openrouter/cohere/north-mini-code:free',
    timeoutMs,
  };
}

/**
 * Validate candidate findings before publication. The advisor is fail-safe:
 * disabled or failed advice retains candidates unchanged, while explicit
 * rejection removes a finding and explicit revision is validated before use.
 */
export async function runAdvisor(options: {
  config: AdvisorConfig;
  candidates: AttributedFinding[];
  diff: string;
  repositoryContext?: string;
  runner?: AdvisorRunner;
  signal?: AbortSignal;
}): Promise<AdvisorReport> {
  if (!options.config.enabled) {
    return {
      findings: options.candidates.map((finding) => ({
        ...finding,
        advisor: { decision: 'accept', reason: 'Advisor disabled; candidate retained.' },
      })),
      decisions: options.candidates.map((finding) =>
        decisionFor(finding, 'accept', 'Advisor disabled; candidate retained.'),
      ),
      errors: [],
    };
  }

  const runner = options.runner;
  if (!runner) {
    return {
      findings: options.candidates.map((finding) => ({
        ...finding,
        advisor: {
          decision: 'accept',
          reason: 'Advisor runner unavailable; candidate retained safely.',
        },
      })),
      decisions: options.candidates.map((finding) =>
        decisionFor(finding, 'accept', 'Advisor runner unavailable; candidate retained safely.'),
      ),
      errors: ['Advisor is enabled but no runner was configured; candidates were retained.'],
    };
  }
  const results = await Promise.all(
    options.candidates.map((finding) => adviseOne(finding, { ...options, runner })),
  );
  const findings: AdvisedFinding[] = [];
  const decisions = results.map((result) =>
    decisionFor(result.finding, result.decision.decision, result.decision.reason),
  );
  const errors = results.flatMap((result) => (result.error ? [result.error] : []));

  for (const result of results) {
    if (result.decision.decision === 'reject') continue;
    findings.push({
      ...result.finding,
      advisor: {
        decision: result.decision.decision,
        reason: result.decision.reason,
      },
    });
  }
  return { findings, decisions, errors };
}

async function adviseOne(
  finding: AttributedFinding,
  options: {
    config: AdvisorConfig;
    diff: string;
    repositoryContext?: string;
    runner: AdvisorRunner;
    signal?: AbortSignal;
  },
): Promise<{
  finding: AttributedFinding;
  decision: { decision: AdvisorDecision; reason: string };
  error?: string;
}> {
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  try {
    const raw = await withTimeout(
      options.runner(
        { finding, diff: options.diff, repositoryContext: options.repositoryContext },
        signal,
      ),
      options.config.timeoutMs,
      () => controller.abort(),
    );
    const parsed = v.safeParse(advisorResultSchema, raw);
    if (!parsed.success) {
      return {
        finding,
        decision: {
          decision: 'accept',
          reason: 'Advisor response was malformed; candidate retained safely.',
        },
        error: `Advisor response for "${finding.title}" was malformed.`,
      };
    }
    if (parsed.output.decision === 'revise') {
      const revised = validateRevision(finding, parsed.output.finding);
      if (!revised.ok) {
        return {
          finding,
          decision: {
            decision: 'accept',
            reason: 'Advisor revision was invalid; candidate retained safely.',
          },
          error: `Advisor revision for "${finding.title}" was invalid: ${revised.reason}`,
        };
      }
      return {
        finding: { ...finding, ...revised.finding },
        decision: { decision: 'revise', reason: parsed.output.reason },
      };
    }
    return {
      finding,
      decision: { decision: parsed.output.decision, reason: parsed.output.reason },
    };
  } catch (error) {
    return {
      finding,
      decision: {
        decision: 'accept',
        reason: 'Advisor failed or timed out; candidate retained safely.',
      },
      error: `Advisor failed for "${finding.title}": ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    controller.abort();
  }
}

function validateRevision(
  original: AttributedFinding,
  revision: unknown,
): { ok: true; finding: Partial<Finding> } | { ok: false; reason: string } {
  if (revision === null || typeof revision !== 'object')
    return { ok: false, reason: 'expected an object' };
  const merged = { ...original, ...(revision as Record<string, unknown>) };
  const parsed = v.safeParse(findingSchema, merged);
  if (!parsed.success)
    return { ok: false, reason: parsed.issues.map((issue) => issue.message).join('; ') };
  return {
    ok: true,
    finding: {
      severity: parsed.output.severity,
      title: parsed.output.title,
      explanation: parsed.output.explanation,
      suggestion: parsed.output.suggestion,
      confidence: parsed.output.confidence,
    },
  };
}

function decisionFor(
  finding: AttributedFinding,
  decision: AdvisorDecision,
  reason: string,
): { title: string; path: string; decision: AdvisorDecision; reason: string } {
  return { title: finding.title, path: finding.path, decision, reason };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`advisor timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
