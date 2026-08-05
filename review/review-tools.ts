import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import type { ReviewPublisher } from '../github/adapter.ts';
import type { DiffHunk } from './diff.ts';
import type { ReviewLimits } from './limits.ts';
import type {
  GetDiffResult,
  IncrementalDiffResult,
  PrDataSource,
  PrMetadata,
  ReadChangedFileResult,
  ReviewContextResult,
} from './pr-data.ts';
import type { ReviewState } from './review-state.ts';
import { recoverReviewResult, reviewResultInputSchema } from './schema.ts';

const MAX_PATH_LENGTH = 500;

export function createGetPrMetadataTool(dataSource: PrDataSource) {
  return defineTool({
    name: 'get_pr_metadata',
    description:
      'Load pull-request metadata: number, title, body, author, base/head SHAs, and the changed-file list (with skip flags for lockfiles, generated, vendored, and binary files). Call this first to understand the PR scope.',
    input: v.object({}),
    async run() {
      const metadata: PrMetadata = await dataSource.getMetadata();
      return { output: metadata };
    },
  });
}

export function createGetPrDiffTool(dataSource: PrDataSource, limits: ReviewLimits) {
  return defineTool({
    name: 'get_pr_diff',
    description: `Return the unified diff for the whole PR, truncated to at most ${limits.maxDiffLines} lines. Use this to see exactly what changed. Skip-reviewed files (lockfiles, generated, snapshots, vendored) are still present in the diff but should not be analyzed.`,
    input: v.object({}),
    async run() {
      const diff: GetDiffResult = await dataSource.getDiff(limits.maxDiffLines);
      return { output: diff };
    },
  });
}

export function createListChangedFilesTool(dataSource: PrDataSource, limits: ReviewLimits) {
  return defineTool({
    name: 'list_changed_files',
    description: `List the files changed in this PR with per-file additions, deletions, status, and a skip flag. Capped at ${limits.maxFiles} files; the rest are summarized. Use this to pick which files to inspect closely.`,
    input: v.object({}),
    async run() {
      const all = await dataSource.listChangedFiles();
      const reviewed = all.slice(0, limits.maxFiles);
      const skippedCount = reviewed.filter((f) => f.skip).length;
      return {
        output: {
          files: reviewed,
          totalFiles: all.length,
          truncated: all.length > limits.maxFiles,
          skippedByFilter: skippedCount,
          skippedByFilterTotal: all.filter((f) => f.skip).length,
        },
      };
    },
  });
}

export function createReadChangedFileTool(dataSource: PrDataSource) {
  return defineTool({
    name: 'read_changed_file',
    description:
      "Read a bounded line range (≤400 lines) from the post-PR version of a changed file. The path must be one of the PR's changed files (see list_changed_files); other paths are rejected. Use after list_changed_files to inspect surrounding context for a finding. Returns numbered lines and the total line count.",
    input: v.object({
      path: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_PATH_LENGTH)),
      startLine: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 1),
      endLine: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
    }),
    async run({ data }) {
      if (data.endLine !== undefined && data.endLine < data.startLine) {
        throw new Error('endLine must be greater than or equal to startLine.');
      }
      const result: ReadChangedFileResult = await dataSource.readChangedFile(
        data.path,
        data.startLine,
        data.endLine,
      );
      return { output: result };
    },
  });
}

export function createGetDiffHunksTool(dataSource: PrDataSource) {
  return defineTool({
    name: 'get_diff_hunks',
    description:
      'Return the diff hunk line ranges (new-file side) for one changed file. Use to confirm which line numbers are valid for inline findings before calling submit_review.',
    input: v.object({
      path: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_PATH_LENGTH)),
    }),
    async run({ data }) {
      const hunks: DiffHunk[] = await dataSource.getDiffHunks(data.path);
      return { output: { path: data.path, hunks } };
    },
  });
}

export function createGetPreviousReviewStateTool(dataSource: PrDataSource) {
  return defineTool({
    name: 'get_previous_review_state',
    description:
      'Load the previous review state from the hidden PR comment. Returns the reviewed head SHA, the findings from the last review, and the timestamp — or null when this is the first review. Call this early to determine whether this is a full review or an incremental review.',
    input: v.object({}),
    async run() {
      const state: ReviewState | null = await dataSource.getReviewState();
      if (!state) {
        return {
          output: {
            isFirstReview: true,
            reviewedHeadSha: null,
            findings: [],
            reviewedAt: null,
            message: 'No previous review found. This is the first review — review the full diff.',
          },
        };
      }
      return {
        output: {
          isFirstReview: false,
          reviewedHeadSha: state.reviewedHeadSha,
          findings: state.findings,
          reviewedAt: state.reviewedAt,
          message: `Previous review was at ${state.reviewedHeadSha.slice(0, 7)} with ${state.findings.length} finding(s). Use get_incremental_diff to see what changed since then, then classify each previous finding in submit_review.`,
        },
      };
    },
  });
}

export function createGetIncrementalDiffTool(dataSource: PrDataSource, limits: ReviewLimits) {
  return defineTool({
    name: 'get_incremental_diff',
    description: `Return the incremental diff since the last reviewed SHA (git diff prevSha...headSha), truncated to at most ${limits.maxDiffLines} lines. When this is the first review, returns isFirstReview=true with an empty diff. Use this after get_previous_review_state to focus on what changed since the last review.`,
    input: v.object({}),
    async run() {
      const result: IncrementalDiffResult = await dataSource.getIncrementalDiff(
        limits.maxDiffLines,
      );
      return { output: result };
    },
  });
}

export function createGetReviewContextTool(dataSource: PrDataSource) {
  return defineTool({
    name: 'get_review_context',
    description:
      'Load repository-specific review context: AGENTS.md, CONTRIBUTING.md, .github/pull_request_template.md, .flue/review-instructions.md, and .flue/repository-learnings.md. Only files that exist are returned. Call this early to understand conventions, test commands, review priorities, and past learnings before analyzing the diff.',
    input: v.object({}),
    async run() {
      const result: ReviewContextResult = await dataSource.getReviewContext();
      return { output: result };
    },
  });
}

export function createSubmitReviewTool(publisher: ReviewPublisher) {
  return defineTool({
    name: 'submit_review',
    description:
      'Submit the final PR review. Accepts a structured ReviewResult (summary, verdict, findings). Each finding should include severity P0-P3, path, optional line, title, explanation, optional suggestion, and confidence. The trusted publisher validates paths/lines against the PR diff, keeps body-only findings when no valid line exists, and posts one GitHub review with inline comments. Verdict is COMMENT or REQUEST_CHANGES — never APPROVE. Call this exactly once when the review is complete. When there are no blocking issues, use verdict COMMENT with an empty findings array.',
    input: reviewResultInputSchema,
    async run({ data }) {
      const recovered = recoverReviewResult(data);
      if (!recovered.ok) {
        throw new Error(
          `submit_review received an invalid review result:\n- ${recovered.issues.join('\\n- ')}`,
        );
      }
      if (data.findings.length > 0 && recovered.value.findings.length === 0) {
        throw new Error(
          `submit_review rejected all ${data.findings.length} finding(s):\\n- ${recovered.issues.join('\\n- ')}`,
        );
      }
      const published = await publisher.publish(recovered.value);
      const recoveryIssues = recovered.issues;
      return {
        output: {
          ...published,
          validationIssues: [...recoveryIssues, ...published.validationIssues],
          message: `Review posted (${published.submittedFindings} inline finding(s), ${published.skippedFindings} skipped). ${published.htmlUrl}`,
        },
        terminate: true,
      };
    },
  });
}
