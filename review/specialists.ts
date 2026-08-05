import type { Finding, Severity } from './schema.ts';
import { recoverFindings } from './schema.ts';

/** Specialist roles supported by the review pipeline. */
export const SPECIALIST_ROLES = ['correctness', 'security', 'testing', 'architecture'] as const;
export type SpecialistRole = (typeof SPECIALIST_ROLES)[number];

/** Context shared with each specialist runner. */
export type SpecialistContext = {
  prNumber?: number;
  title?: string;
  body?: string;
  diff: string;
  changedFiles: string[];
  repositoryContext?: string;
};

/** A finding with trusted provenance retained through adjudication. */
export type AttributedFinding = Finding & {
  sources: SpecialistRole[];
};

export type SpecialistRunner = (
  role: SpecialistRole,
  context: SpecialistContext,
  signal: AbortSignal,
) => Promise<unknown>;

export type SpecialistConfig = {
  enabledRoles: SpecialistRole[];
  timeoutMs: number;
};

export type SpecialistRoleResult = {
  role: SpecialistRole;
  status: 'fulfilled' | 'rejected' | 'timed-out';
  findings: AttributedFinding[];
  validationIssues: string[];
  error?: string;
};

export type SpecialistReviewReport = {
  findings: AttributedFinding[];
  roles: SpecialistRoleResult[];
  errors: string[];
  validationIssues: string[];
};

const DEFAULT_SPECIALIST_TIMEOUT_MS = 30_000;
const MIN_SPECIALIST_TIMEOUT_MS = 100;
const MAX_SPECIALIST_TIMEOUT_MS = 300_000;
const severityRank: Record<Severity, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

/** Parse specialist roles and timeout from environment variables. */
export function parseSpecialistConfig(env: Record<string, string | undefined>): SpecialistConfig {
  const rawRoles = env.PR_REVIEW_SPECIALISTS;
  const enabledRoles = rawRoles ? parseRoles(rawRoles) : [...SPECIALIST_ROLES];
  const rawTimeout = env.PR_REVIEW_SPECIALIST_TIMEOUT_MS;
  const timeoutMs =
    rawTimeout === undefined || rawTimeout === ''
      ? DEFAULT_SPECIALIST_TIMEOUT_MS
      : Number(rawTimeout);

  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < MIN_SPECIALIST_TIMEOUT_MS ||
    timeoutMs > MAX_SPECIALIST_TIMEOUT_MS
  ) {
    throw new Error(
      `PR_REVIEW_SPECIALIST_TIMEOUT_MS must be an integer in [${MIN_SPECIALIST_TIMEOUT_MS}, ${MAX_SPECIALIST_TIMEOUT_MS}].`,
    );
  }

  return { enabledRoles, timeoutMs };
}

function parseRoles(raw: string): SpecialistRole[] {
  const requested = raw
    .split(',')
    .map((role) => role.trim().toLowerCase())
    .filter(Boolean);
  const unknown = requested.filter(
    (role): role is string => !SPECIALIST_ROLES.includes(role as SpecialistRole),
  );
  if (unknown.length > 0) {
    throw new Error(
      `PR_REVIEW_SPECIALISTS contains unknown role(s): ${unknown.join(', ')}. Allowed roles: ${SPECIALIST_ROLES.join(', ')}.`,
    );
  }
  return SPECIALIST_ROLES.filter((role) => requested.includes(role));
}

/**
 * Run enabled specialists concurrently. Each role is independently validated,
 * timed out, and attributed, so one bad or slow specialist cannot erase the
 * successful findings produced by the others.
 */
export async function runSpecialistReview(options: {
  config: SpecialistConfig;
  context: SpecialistContext;
  runner: SpecialistRunner;
  signal?: AbortSignal;
}): Promise<SpecialistReviewReport> {
  const rolePromises = options.config.enabledRoles.map((role) => runOneSpecialist(role, options));
  const settled = await Promise.all(rolePromises);
  const findings = adjudicateFindings(settled.flatMap((result) => result.findings));
  return {
    findings,
    roles: settled,
    errors: settled.flatMap((result) => (result.error ? [`${result.role}: ${result.error}`] : [])),
    validationIssues: settled.flatMap((result) =>
      result.validationIssues.map((issue) => `${result.role}: ${issue}`),
    ),
  };
}

async function runOneSpecialist(
  role: SpecialistRole,
  options: {
    config: SpecialistConfig;
    context: SpecialistContext;
    runner: SpecialistRunner;
    signal?: AbortSignal;
  },
): Promise<SpecialistRoleResult> {
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`specialist timed out after ${options.config.timeoutMs}ms`));
  }, options.config.timeoutMs);

  try {
    const raw = await withTimeout(
      options.runner(role, options.context, signal),
      options.config.timeoutMs,
      () => {
        timedOut = true;
        controller.abort(new Error(`specialist timed out after ${options.config.timeoutMs}ms`));
      },
    );
    const recovered = recoverFindings(raw);
    return {
      role,
      status: 'fulfilled',
      findings: recovered.findings.map((finding) => ({ ...finding, sources: [role] })),
      validationIssues: recovered.issues,
    };
  } catch (error) {
    return {
      role,
      status: timedOut ? 'timed-out' : 'rejected',
      findings: [],
      validationIssues: [],
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Deterministically consolidate overlapping findings. Exact path/title matches
 * are grouped even when line numbers drift; same-path findings with nearby
 * lines and the same normalized title are also considered overlapping. The
 * highest severity wins, confidence is calibrated upward only when multiple
 * specialists independently report the same issue, and all source roles are
 * retained for observability.
 */
export function adjudicateFindings(findings: AttributedFinding[]): AttributedFinding[] {
  const groups: AttributedFinding[][] = [];
  for (const finding of findings) {
    const matchingGroups = groups.filter((group) =>
      group.some((member) => overlaps(member, finding)),
    );
    if (matchingGroups.length === 0) {
      groups.push([finding]);
      continue;
    }
    const [first, ...rest] = matchingGroups;
    first.push(finding, ...rest.flat());
    for (const group of rest) groups.splice(groups.indexOf(group), 1);
  }

  return groups
    .map((group) => {
      const representative = [...group].sort((a, b) => {
        const severity = severityRank[a.severity] - severityRank[b.severity];
        return severity || b.confidence - a.confidence || a.sources[0].localeCompare(b.sources[0]);
      })[0];
      const sources = [...new Set(group.flatMap((finding) => finding.sources))].sort();
      const confidence = Math.min(
        1,
        Math.max(...group.map((finding) => finding.confidence)) + (sources.length - 1) * 0.05,
      );
      return { ...representative, confidence, sources };
    })
    .sort(
      (a, b) => severityRank[a.severity] - severityRank[b.severity] || b.confidence - a.confidence,
    );
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`specialist timed out after ${timeoutMs}ms`));
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

function overlaps(a: AttributedFinding, b: AttributedFinding): boolean {
  if (a.path !== b.path) return false;
  if (normalizeTitle(a.title) !== normalizeTitle(b.title)) return false;
  if (a.line === undefined || b.line === undefined) return true;
  return Math.abs(a.line - b.line) <= 2;
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
