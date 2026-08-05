/**
 * Trusted review publisher — the narrow boundary between the agent's
 * structured output and the GitHub mutation API.
 *
 * The agent never holds the GitHub token or a generic shell. It calls
 * `submit_review` with a {@link ReviewResult}; this adapter:
 *   1. Re-validates the result against the Valibot schema.
 *   2. Confirms every finding's `path` is among the PR's changed files.
 *   3. Clamps each finding's `line` to a valid diff hunk for that file so
 *      GitHub accepts the inline comment. Findings on files with no usable
 *      right-side hunk (deleted or binary) are dropped from inline comments.
 *   4. Caps the number of findings to the configured limit.
 *   5. Posts exactly one review (COMMENT or REQUEST_CHANGES, never APPROVE)
 *      with inline comments via {@link GitHubClient}.
 *
 * Findings whose path is not in the diff, or whose file has no postable hunk,
 * are dropped from inline comments but still summarized in the review body so
 * no analysis is silently lost. GitHub's create-review API is atomic — one
 * invalid comment 422s the whole request — so if the inline POST is rejected
 * with a 422 the adapter retries once as a body-only review rather than losing
 * every finding.
 */

import { type FileDiff, findFileDiff, hunkForLine, parseUnifiedDiff } from '../review/diff.ts';
import type { ReviewLimits } from '../review/limits.ts';
import {
  type Finding,
  type FindingClassification,
  type ProposedLearning,
  type ReviewResult,
  safeParseReviewResult,
} from '../review/schema.ts';
import type { ReviewStateStore } from '../review/review-state-store.ts';
import {
  GitHubApiError,
  type GitHubClient,
  type GitHubReviewComment,
  type GitHubReviewPayload,
} from './client.ts';

export type ReviewPublishResult = {
  reviewId: number;
  htmlUrl: string;
  submittedFindings: number;
  skippedFindings: number;
  /** Issues that prevented posting (never includes raw agent output). */
  validationIssues: string[];
};

export type ReviewPublisherOptions = {
  client: GitHubClient;
  prNumber: number;
  /** Head SHA under review — persisted in the review state for incremental runs. */
  headSha: string;
  /** Provider for the full unified diff, used to validate inline-comment line numbers. Resolved once and cached. */
  diffProvider: () => Promise<string>;
  limits: ReviewLimits;
  /** Optional store for persistent review state. When provided, the publisher
   * saves the current head SHA and findings after posting so the next
   * `synchronize` run can produce an incremental review. */
  stateStore?: ReviewStateStore;
};

export type ReviewPublisher = {
  publish(result: unknown): Promise<ReviewPublishResult>;
};

export function createReviewPublisher(options: ReviewPublisherOptions): ReviewPublisher {
  let cachedDiff: string | null = null;
  let cachedFileDiffs: FileDiff[] | null = null;
  let cachedChangedPaths: Set<string> | null = null;

  async function resolveDiff(): Promise<{
    fileDiffs: FileDiff[];
    changedPaths: Set<string>;
  }> {
    if (cachedDiff === null) {
      cachedDiff = await options.diffProvider();
      cachedFileDiffs = parseUnifiedDiff(cachedDiff);
      cachedChangedPaths = new Set(cachedFileDiffs.map((f) => f.path));
    }
    return {
      fileDiffs: cachedFileDiffs!,
      changedPaths: cachedChangedPaths!,
    };
  }

  return {
    async publish(result: unknown): Promise<ReviewPublishResult> {
      const parsed = safeParseReviewResult(result);
      if (!parsed.ok) {
        throw new Error(
          `submit_review received an invalid review result:\n- ${parsed.issues.join('\n- ')}`,
        );
      }

      const { fileDiffs, changedPaths } = await resolveDiff();
      return publishValidatedReview(
        parsed.value,
        options.client,
        options.prNumber,
        options.headSha,
        fileDiffs,
        changedPaths,
        options.limits,
        options.stateStore,
      );
    },
  };
}

async function publishValidatedReview(
  result: ReviewResult,
  client: GitHubClient,
  prNumber: number,
  headSha: string,
  fileDiffs: FileDiff[],
  changedPaths: Set<string>,
  limits: ReviewLimits,
  stateStore?: ReviewStateStore,
): Promise<ReviewPublishResult> {
  const capped = result.findings.slice(0, limits.maxFindings);
  const skippedFindings = result.findings.length - capped.length;

  const inlineComments: GitHubReviewComment[] = [];
  const droppedFindings: { finding: Finding; reason: string }[] = [];

  for (const finding of capped) {
    if (!changedPaths.has(finding.path)) {
      droppedFindings.push({
        finding,
        reason: `path "${finding.path}" is not in the PR diff`,
      });
      continue;
    }

    if (finding.line === undefined) {
      droppedFindings.push({
        finding,
        reason: `finding "${finding.title}" has no line citation; posted in the review body`,
      });
      continue;
    }

    const fileDiff = findFileDiff(fileDiffs, finding.path);
    const hunk = fileDiff ? hunkForLine(fileDiff, finding.line) : null;

    // A postable inline comment needs a right-side (new-file) line. Deleted
    // files have only `+0,0` hunks (newEnd === 0) and binary/unchanged files
    // have no hunks at all; GitHub rejects line 0 or a line outside any hunk,
    // and because the create-review call is atomic one bad comment would 422
    // the whole review. Drop these to the body instead.
    if (!hunk) {
      droppedFindings.push({
        finding,
        reason: `file "${finding.path}" has no diff hunks (binary or unchanged)`,
      });
      continue;
    }
    if (hunk.newEnd === 0) {
      droppedFindings.push({
        finding,
        reason: `file "${finding.path}" is deleted; inline comments need right-side lines`,
      });
      continue;
    }

    inlineComments.push({
      path: finding.path,
      line: clampToHunk(hunk.newStart, hunk.newEnd, finding.line),
      side: 'RIGHT',
      body: formatFindingBody(finding),
    });
  }

  const event: GitHubReviewPayload['event'] =
    result.verdict === 'REQUEST_CHANGES' ? 'REQUEST_CHANGES' : 'COMMENT';

  const payload: GitHubReviewPayload = {
    event,
    body: formatReviewBody(
      result.summary,
      capped,
      droppedFindings,
      skippedFindings,
      result.previousFindingClassifications,
      result.proposedLearnings,
    ),
    comments: inlineComments,
  };

  const validationIssues = droppedFindings.map((d) => d.reason);
  let postedInline = inlineComments.length;
  let submitted: { id: number; html_url: string };
  try {
    submitted = await client.submitReview(prNumber, payload);
  } catch (error) {
    // Atomic-API safety net: if GitHub rejects the inline comments (422),
    // retry once without them so the validated findings still land as a
    // body-only review instead of losing the whole review.
    if (error instanceof GitHubApiError && error.status === 422 && inlineComments.length > 0) {
      submitted = await client.submitReview(prNumber, {
        ...payload,
        comments: [],
      });
      postedInline = 0;
      validationIssues.push(
        'GitHub rejected the inline comments (422); posted a body-only review instead.',
      );
    } else {
      throw error;
    }
  }

  // Persist the review state (findings actually shown to the user) for incremental
  // reviews. Save even when there are no findings — an empty state tells the next
  // run that this SHA was reviewed and found clean, so it can produce a focused
  // incremental diff.
  //
  // This is best-effort: the review was already posted to GitHub, so a state-
  // write failure must not cause the run to throw (which could trigger a
  // retry that posts a duplicate review). The next run simply falls back to
  // a full review when no state is found.
  const stateSaveError: string[] = [];
  const shown = capped.filter((f) => !droppedFindings.some((d) => d.finding === f));
  if (stateStore) {
    try {
      await stateStore.save({
        reviewedHeadSha: headSha,
        findings: shown,
        reviewedAt: Date.now(),
      });
    } catch (error) {
      stateSaveError.push(
        `Failed to persist review state: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    reviewId: submitted.id,
    htmlUrl: submitted.html_url,
    submittedFindings: postedInline,
    skippedFindings: skippedFindings + droppedFindings.length,
    validationIssues: [...validationIssues, ...stateSaveError],
  };
}

function clampToHunk(newStart: number, newEnd: number, line: number): number {
  if (line < newStart) return newStart;
  if (line > newEnd) return newEnd;
  return line;
}

function formatFindingBody(finding: Finding): string {
  const parts = [
    `**[${finding.severity.toUpperCase()}] ${finding.title}**`,
    '',
    finding.explanation,
  ];
  if (finding.suggestion) {
    parts.push('', '**Suggestion:**', '```', finding.suggestion, '```');
  }
  parts.push('', `_confidence: ${finding.confidence}_`);
  return parts.join('\n');
}

function formatReviewBody(
  summary: string,
  findings: Finding[],
  droppedFindings: { finding: Finding; reason: string }[],
  skippedFindings: number,
  classifications?: FindingClassification[],
  proposedLearnings?: ProposedLearning[],
): string {
  const lines = ['## Flue PR Review', '', summary, ''];
  const inlineFindings = findings.filter(
    (finding) => !droppedFindings.some((dropped) => dropped.finding === finding),
  );

  if (findings.length === 0) {
    lines.push('No blocking issues found.');
  } else {
    lines.push('### Findings', '');
    for (const f of inlineFindings) {
      const location = f.line === undefined ? f.path : `${f.path}:${f.line}`;
      lines.push(`- **[${f.severity}]** ${f.title} — \`${location}\``);
    }
  }

  if (classifications && classifications.length > 0) {
    lines.push('', '### Previous findings status', '');
    const icons: Record<string, string> = {
      resolved: '✅',
      'still-present': '⚠️',
      obsolete: '🗑️',
      uncertain: '❓',
    };
    for (const c of classifications) {
      const icon = icons[c.status] ?? '•';
      const location = c.line === undefined ? c.path : `${c.path}:${c.line}`;
      lines.push(`- ${icon} ${c.status}: ${c.title} — \`${location}\``);
    }
  }

  function toSingleLine(str: string): string {
    return str.replace(/[\r\n]+/g, ' ').trim();
  }

  if (proposedLearnings && proposedLearnings.length > 0) {
    lines.push(
      '',
      '### Proposed repository learnings',
      '',
      '_Suggestions for `.flue/repository-learnings.md`. Review and apply manually — the agent cannot modify files._',
      '',
    );
    for (const learning of proposedLearnings) {
      const content = toSingleLine(learning.content);
      const justification = toSingleLine(learning.justification);
      lines.push(`- **[${learning.category}]** ${content}`);
      lines.push(`  — _${justification}_`);
    }
  }

  if (droppedFindings.length > 0) {
    lines.push('', '### Findings not posted inline', '');
    for (const d of droppedFindings) {
      lines.push(`- ${d.finding.title} — ${d.reason}`);
    }
  }

  if (skippedFindings > 0) {
    lines.push(
      '',
      `_(${skippedFindings} finding(s) skipped over the ${findings.length} reviewed limit.)_`,
    );
  }

  lines.push('', '---', '_Automated review by the Flue PR Review Agent._');
  return lines.join('\n');
}
