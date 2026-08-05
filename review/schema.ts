import * as v from 'valibot';

/**
 * Structured review output contract. The agent emits this shape through the
 * `submit_review` tool; the trusted GitHub adapter validates it before posting.
 *
 * `verdict` is never `APPROVE` — the reviewer never auto-approves. When no
 * blocking issues are found, the agent uses `COMMENT` with an empty findings
 * array and a summary such as "No blocking issues found."
 */

/**
 * Finding priority follows the P0-P3 convention used by the reviewer:
 * P0 is a critical production/security issue and P3 is a low-priority issue.
 */
export const severitySchema = v.picklist(['P0', 'P1', 'P2', 'P3']);

/** Legacy severity labels accepted when reading older agent output or state. */
export const legacySeveritySchema = v.picklist(['critical', 'high', 'medium', 'low']);

export const verdictSchema = v.picklist(['COMMENT', 'REQUEST_CHANGES']);

/**
 * Hard ceiling on findings per review. This schema is both the `submit_review`
 * tool input and what the trusted adapter re-validates, so it is the single
 * source of truth for the cap; {@link ./limits.ts} derives its configurable
 * maximum from this constant to keep the two from drifting apart.
 */
export const REVIEW_FINDINGS_CEILING = 50;

const findingFields = {
  path: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
  /** A finding can be body-only when no valid changed-line citation exists. */
  line: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  title: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  /** Explanation is the evidence-backed rationale for the finding. */
  explanation: v.pipe(v.string(), v.minLength(1), v.maxLength(2000)),
  suggestion: v.optional(v.pipe(v.string(), v.maxLength(2000))),
  confidence: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
};

const canonicalFindingSchema = v.object({
  severity: severitySchema,
  ...findingFields,
});

const legacyFindingSchema = v.object({
  severity: legacySeveritySchema,
  ...findingFields,
});

function normalizeSeverity(
  severity: v.InferOutput<typeof legacySeveritySchema> | v.InferOutput<typeof severitySchema>,
): v.InferOutput<typeof severitySchema> {
  switch (severity) {
    case 'critical':
      return 'P0';
    case 'high':
      return 'P1';
    case 'medium':
      return 'P2';
    case 'low':
      return 'P3';
    default:
      return severity;
  }
}

/**
 * Shared finding schema. It accepts both the canonical P0-P3 contract and the
 * pre-normalization severity labels, but always emits the canonical shape.
 * This keeps persisted review state and older direct callers readable while
 * ensuring every reviewer pipeline consumer sees one normalized structure.
 */
export const findingSchema = v.pipe(
  v.union([canonicalFindingSchema, legacyFindingSchema]),
  v.transform((finding) => ({
    ...finding,
    severity: normalizeSeverity(finding.severity),
  })),
);

/**
 * Classification of a previous finding in an incremental review. The agent
 * assesses whether each prior finding was addressed by the new commits.
 *
 * A finding is identified by its `path` + optional `line` + `title` triple,
 * which is stable across review runs for the same issue when a line exists.
 */
export const findingStatusSchema = v.picklist([
  'resolved',
  'still-present',
  'obsolete',
  'uncertain',
]);

export const findingClassificationSchema = v.object({
  path: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
  line: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  title: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  status: findingStatusSchema,
  note: v.optional(v.pipe(v.string(), v.maxLength(500))),
});

/**
 * Category for a proposed repository learning. The agent suggests learnings
 * it discovered during review; a human reviews and manually adds them to
 * `.flue/repository-learnings.md`. The agent never writes to `.flue/` directly.
 */
export const learningCategorySchema = v.picklist([
  'convention',
  'test-command',
  'architecture',
  'common-issue',
  'documentation',
]);

export const proposedLearningSchema = v.object({
  category: learningCategorySchema,
  content: v.pipe(v.string(), v.minLength(1), v.maxLength(1000)),
  justification: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
});

/** Hard ceiling on proposed learnings per review. */
export const PROPOSED_LEARNINGS_CEILING = 20;

const reviewResultEnvelopeFields = {
  summary: v.pipe(v.string(), v.minLength(1), v.maxLength(4000)),
  verdict: verdictSchema,
  previousFindingClassifications: v.optional(
    v.pipe(v.array(findingClassificationSchema), v.maxLength(REVIEW_FINDINGS_CEILING)),
  ),
  proposedLearnings: v.optional(
    v.pipe(v.array(proposedLearningSchema), v.maxLength(PROPOSED_LEARNINGS_CEILING)),
  ),
};

export const reviewResultSchema = v.object({
  ...reviewResultEnvelopeFields,
  findings: v.pipe(v.array(findingSchema), v.maxLength(REVIEW_FINDINGS_CEILING)),
});

/**
 * Tool-boundary input schema. Findings are opaque so malformed objects,
 * scalars, and nulls can reach the trusted recovery boundary. The tool
 * description documents the expected finding fields; `recoverReviewResult`
 * validates every item before publication.
 */
export const reviewResultInputSchema = v.object({
  ...reviewResultEnvelopeFields,
  findings: v.array(v.unknown()),
});

export type Severity = v.InferOutput<typeof severitySchema>;
export type LegacySeverity = v.InferOutput<typeof legacySeveritySchema>;
export type Verdict = v.InferOutput<typeof verdictSchema>;
export type Finding = v.InferOutput<typeof findingSchema>;
export type FindingStatus = v.InferOutput<typeof findingStatusSchema>;
export type FindingClassification = v.InferOutput<typeof findingClassificationSchema>;
export type LearningCategory = v.InferOutput<typeof learningCategorySchema>;
export type ProposedLearning = v.InferOutput<typeof proposedLearningSchema>;
export type ReviewResult = v.InferOutput<typeof reviewResultSchema>;

/**
 * Parse and validate an unknown value as a {@link ReviewResult}. Throws a
 * Valibot `ValiError` on invalid input so the caller can surface a clear
 * message.
 */
export function parseReviewResult(value: unknown): ReviewResult {
  return v.parse(reviewResultSchema, value);
}

/**
 * Safe validation that never throws. Returns the parsed result or a list of
 * human-readable issues. Used by the trusted adapter to reject malformed
 * agent output without crashing the run.
 */
export function safeParseReviewResult(
  value: unknown,
): { ok: true; value: ReviewResult } | { ok: false; issues: string[] } {
  const result = v.safeParse(reviewResultSchema, value);
  if (result.success) return { ok: true, value: result.output };
  const issues = result.issues.map(formatIssue);
  return { ok: false, issues };
}

/** Result of validating findings independently so valid items can be retained. */
export type RecoverableFindings = {
  findings: Finding[];
  issues: string[];
  rejectedFindings: number;
};

/**
 * Validate each finding independently. Malformed items are reported by index,
 * while valid findings are normalized and returned for body-only recovery.
 */
export function recoverFindings(value: unknown): RecoverableFindings {
  if (!Array.isArray(value)) {
    return { findings: [], issues: ['findings: expected an array'], rejectedFindings: 0 };
  }

  const findings: Finding[] = [];
  const issues: string[] = [];
  let rejectedFindings = 0;
  for (const [index, item] of value.entries()) {
    const result = v.safeParse(findingSchema, item);
    if (result.success) {
      findings.push(result.output);
    } else {
      rejectedFindings += 1;
      issues.push(
        ...result.issues.map(
          (issue) => `findings.${index}.${formatIssuePath(issue)}: ${issue.message}`,
        ),
      );
    }
  }
  if (findings.length > REVIEW_FINDINGS_CEILING) {
    issues.push(`findings: more than ${REVIEW_FINDINGS_CEILING} valid findings were supplied`);
    findings.splice(REVIEW_FINDINGS_CEILING);
  }
  return { findings, issues, rejectedFindings };
}

/**
 * Recover a review envelope when individual findings are malformed. Envelope
 * metadata and optional sections remain strict; only the findings array is
 * independently recoverable. This is intended for trusted boundaries such as
 * the publisher, not as a replacement for the strict tool input schema.
 */
export function recoverReviewResult(
  value: unknown,
):
  | { ok: true; value: ReviewResult; issues: string[]; rejectedFindings: number }
  | { ok: false; issues: string[] } {
  const envelope = v.safeParse(
    v.object({
      ...reviewResultEnvelopeFields,
      findings: v.unknown(),
    }),
    value,
  );
  if (!envelope.success) {
    return { ok: false, issues: envelope.issues.map(formatIssue) };
  }

  const recovered = recoverFindings(envelope.output.findings);
  return {
    ok: true,
    value: {
      summary: envelope.output.summary,
      verdict: envelope.output.verdict,
      findings: recovered.findings,
      previousFindingClassifications: envelope.output.previousFindingClassifications,
      proposedLearnings: envelope.output.proposedLearnings,
    },
    issues: recovered.issues,
    rejectedFindings: recovered.rejectedFindings,
  };
}

function formatIssue(issue: v.BaseIssue<unknown>): string {
  return `${formatIssuePath(issue)}: ${issue.message}`;
}

function formatIssuePath(issue: v.BaseIssue<unknown>): string {
  return issue.path ? issue.path.map((part) => String(part.key)).join('.') : '(root)';
}
