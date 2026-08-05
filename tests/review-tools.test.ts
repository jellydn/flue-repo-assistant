import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { invokeTool } from '../reliability/tool-invocation.ts';
import {
  createGetDiffHunksTool,
  createGetIncrementalDiffTool,
  createGetPrDiffTool,
  createGetPrMetadataTool,
  createGetPreviousReviewStateTool,
  createGetReviewContextTool,
  createListChangedFilesTool,
  createReadChangedFileTool,
  createSubmitReviewTool,
} from '../review/review-tools.ts';
import type { PrDataSource } from '../review/pr-data.ts';
import type { ReviewPublisher } from '../github/adapter.ts';
import { DEFAULT_REVIEW_LIMITS } from '../review/limits.ts';

const DIFF = [
  'diff --git a/src/auth.ts b/src/auth.ts',
  '--- a/src/auth.ts',
  '+++ b/src/auth.ts',
  '@@ -10,3 +10,5 @@',
  ' context',
  '-old',
  '+new one',
  '+new two',
  ' context',
  'diff --git a/package-lock.json b/package-lock.json',
  '--- a/package-lock.json',
  '+++ b/package-lock.json',
  '@@ -1,1 +1,2 @@',
  ' {',
  '+  "new": "dep"',
].join('\n');

function createFakeDataSource(): PrDataSource {
  return {
    async getMetadata() {
      return {
        number: 7,
        title: 'Fix auth',
        body: 'Improves error handling',
        author: 'alice',
        baseSha: 'aaa',
        headSha: 'hhh',
        changedFiles: [
          { path: 'src/auth.ts', status: 'modified', additions: 2, deletions: 1, skip: false },
          {
            path: 'package-lock.json',
            status: 'modified',
            additions: 1,
            deletions: 0,
            skip: true,
            skipReason: 'lockfile',
          },
        ],
      };
    },
    async getDiff() {
      return { content: DIFF, truncated: false, totalLines: DIFF.split('\n').length };
    },
    async listChangedFiles() {
      return [
        { path: 'src/auth.ts', status: 'modified', additions: 2, deletions: 1, skip: false },
        {
          path: 'package-lock.json',
          status: 'modified',
          additions: 1,
          deletions: 0,
          skip: true,
          skipReason: 'lockfile',
        },
      ];
    },
    async getDiffHunks(p) {
      if (p === 'src/auth.ts') {
        return [{ oldStart: 10, oldEnd: 12, newStart: 10, newEnd: 14 }];
      }
      return [];
    },
    async readChangedFile(p, startLine = 1, endLine?) {
      const content = `1: import { x } from "./x.ts";\n2: export const y = x;\n3: `;
      return {
        path: p,
        startLine,
        endLine: endLine ?? 3,
        totalLines: 3,
        content,
        truncated: false,
      };
    },
    async getReviewState() {
      return null;
    },
    async getIncrementalDiff() {
      return {
        isFirstReview: true,
        previousReviewedSha: null,
        content: '',
        truncated: false,
        totalLines: 0,
      };
    },
    async getReviewContext() {
      return {
        files: [
          {
            path: 'AGENTS.md',
            label: 'Project instructions (AGENTS.md)',
            content: '# Project\nUse Node 22.',
            truncated: false,
            totalLines: 2,
          },
        ],
        message: 'Loaded 1 repository context file(s).',
      };
    },
  };
}

async function run<T>(
  tool: Parameters<typeof invokeTool>[0],
  data: Record<string, unknown>,
): Promise<T> {
  return invokeTool<T>(tool, { toolCallId: 'test', data });
}

describe('review tools', () => {
  test('get_pr_metadata returns metadata and changed files', async () => {
    const ds = createFakeDataSource();
    const tool = createGetPrMetadataTool(ds);
    const result = await run<{ number: number; changedFiles: unknown[] }>(tool, {});
    assert.equal(result.number, 7);
    assert.equal(result.changedFiles.length, 2);
  });

  test('get_pr_diff returns truncated diff content', async () => {
    const ds = createFakeDataSource();
    const tool = createGetPrDiffTool(ds, DEFAULT_REVIEW_LIMITS);
    const result = await run<{ content: string; truncated: boolean; totalLines: number }>(tool, {});
    assert.match(result.content, /diff --git/);
    assert.equal(result.truncated, false);
  });

  test('list_changed_files reports skip flags and counts', async () => {
    const ds = createFakeDataSource();
    const tool = createListChangedFilesTool(ds, DEFAULT_REVIEW_LIMITS);
    const result = await run<{
      files: Array<{ path: string; skip: boolean }>;
      totalFiles: number;
      skippedByFilter: number;
    }>(tool, {});
    assert.equal(result.totalFiles, 2);
    assert.equal(result.skippedByFilter, 1);
    const lockfile = result.files.find((f) => f.path === 'package-lock.json');
    assert.equal(lockfile?.skip, true);
  });

  test('read_changed_file returns numbered lines', async () => {
    const ds = createFakeDataSource();
    const tool = createReadChangedFileTool(ds);
    const result = await run<{ path: string; content: string; totalLines: number }>(tool, {
      path: 'src/auth.ts',
    });
    assert.match(result.content, /^1:/);
    assert.equal(result.totalLines, 3);
  });

  test('read_changed_file rejects endLine < startLine', async () => {
    const ds = createFakeDataSource();
    const tool = createReadChangedFileTool(ds);
    await assert.rejects(() => run(tool, { path: 'src/auth.ts', startLine: 10, endLine: 5 }));
  });

  test('get_diff_hunks returns hunk ranges for a file', async () => {
    const ds = createFakeDataSource();
    const tool = createGetDiffHunksTool(ds);
    const result = await run<{ path: string; hunks: Array<{ newStart: number }> }>(tool, {
      path: 'src/auth.ts',
    });
    assert.equal(result.hunks.length, 1);
    assert.equal(result.hunks[0].newStart, 10);
  });

  test('submit_review recovers valid findings and reports malformed items', async () => {
    let published: any = null;
    const fakePublisher: ReviewPublisher = {
      async publish(result) {
        published = result;
        return {
          reviewId: 98,
          htmlUrl: 'https://example/review/98',
          submittedFindings: 1,
          skippedFindings: 0,
          validationIssues: [],
        };
      },
    };
    const tool = createSubmitReviewTool(fakePublisher);
    const raw = await tool.run({
      toolCallId: 'test',
      log: { info() {}, warn() {}, error() {} },
      data: {
        summary: 'Mixed findings.',
        verdict: 'COMMENT',
        findings: [
          {
            severity: 'low',
            path: 'a.ts',
            line: 1,
            title: 'valid',
            explanation: 'e',
            confidence: 0.5,
          },
          'malformed scalar',
        ],
      },
    });
    const envelope = raw as {
      output: { reviewId: number; validationIssues: string[] };
      terminate?: boolean;
    };
    assert.equal(envelope.output.reviewId, 98);
    assert.equal(envelope.terminate, true);
    assert.match(envelope.output.validationIssues.join('\n'), /findings\.1/);
    assert.equal(published.findings.length, 1);
    assert.equal(published.findings[0].severity, 'P3');
  });

  test('submit_review rejects when every finding is malformed', async () => {
    const fakePublisher: ReviewPublisher = {
      async publish() {
        throw new Error('publisher should not be called');
      },
    };
    const tool = createSubmitReviewTool(fakePublisher);
    await assert.rejects(
      Promise.resolve().then(() =>
        tool.run({
          toolCallId: 'test',
          log: { info() {}, warn() {}, error() {} },
          data: {
            summary: 'Invalid findings.',
            verdict: 'COMMENT',
            findings: [null],
          },
        }),
      ),
      /rejected all 1 finding/,
    );
  });

  test('submit_review publishes and terminates the turn', async () => {
    let published: unknown = null;
    const fakePublisher: ReviewPublisher = {
      async publish(result) {
        published = result;
        return {
          reviewId: 99,
          htmlUrl: 'https://example/review/99',
          submittedFindings: 1,
          skippedFindings: 0,
          validationIssues: [],
        };
      },
    };
    const tool = createSubmitReviewTool(fakePublisher);
    const raw = await tool.run({
      toolCallId: 'test',
      log: { info() {}, warn() {}, error() {} },
      data: {
        summary: 's',
        verdict: 'COMMENT',
        findings: [
          { severity: 'P3', path: 'a.ts', line: 1, title: 't', explanation: 'e', confidence: 0.5 },
        ],
      },
    });
    const envelope = raw as { output: { reviewId: number; message: string }; terminate?: boolean };
    assert.equal(envelope.output.reviewId, 99);
    assert.equal(envelope.terminate, true);
    assert.ok(published);
  });

  test('get_previous_review_state returns isFirstReview when no state', async () => {
    const ds = createFakeDataSource();
    const tool = createGetPreviousReviewStateTool(ds);
    const result = await run<{
      isFirstReview: boolean;
      reviewedHeadSha: string | null;
      message: string;
    }>(tool, {});
    assert.equal(result.isFirstReview, true);
    assert.equal(result.reviewedHeadSha, null);
    assert.match(result.message, /first review/i);
  });

  test('get_previous_review_state returns previous findings when state exists', async () => {
    const ds: PrDataSource = {
      ...createFakeDataSource(),
      async getReviewState() {
        return {
          reviewedHeadSha: 'abc123',
          findings: [
            {
              severity: 'P1',
              path: 'src/auth.ts',
              line: 10,
              title: 'SQL injection',
              explanation: 'e',
              confidence: 0.9,
            },
          ],
          reviewedAt: 1_700_000_000_000,
        };
      },
    };
    const tool = createGetPreviousReviewStateTool(ds);
    const result = await run<{
      isFirstReview: boolean;
      reviewedHeadSha: string;
      findings: unknown[];
      reviewedAt: number;
    }>(tool, {});
    assert.equal(result.isFirstReview, false);
    assert.equal(result.reviewedHeadSha, 'abc123');
    assert.equal(result.findings.length, 1);
    assert.equal(result.reviewedAt, 1_700_000_000_000);
  });

  test('get_incremental_diff returns first-review result when no state', async () => {
    const ds = createFakeDataSource();
    const tool = createGetIncrementalDiffTool(ds, DEFAULT_REVIEW_LIMITS);
    const result = await run<{
      isFirstReview: boolean;
      previousReviewedSha: string | null;
      content: string;
    }>(tool, {});
    assert.equal(result.isFirstReview, true);
    assert.equal(result.previousReviewedSha, null);
    assert.equal(result.content, '');
  });

  test('get_incremental_diff returns incremental content when state exists', async () => {
    const ds: PrDataSource = {
      ...createFakeDataSource(),
      async getReviewState() {
        return { reviewedHeadSha: 'prev', findings: [], reviewedAt: 1 };
      },
      async getIncrementalDiff() {
        return {
          isFirstReview: false,
          previousReviewedSha: 'prev',
          content: 'incremental diff here',
          truncated: false,
          totalLines: 3,
        };
      },
    };
    const tool = createGetIncrementalDiffTool(ds, DEFAULT_REVIEW_LIMITS);
    const result = await run<{
      isFirstReview: boolean;
      previousReviewedSha: string;
      content: string;
    }>(tool, {});
    assert.equal(result.isFirstReview, false);
    assert.equal(result.previousReviewedSha, 'prev');
    assert.equal(result.content, 'incremental diff here');
  });

  test('get_review_context returns repository context files', async () => {
    const ds = createFakeDataSource();
    const tool = createGetReviewContextTool(ds);
    const result = await run<{
      files: Array<{ path: string; label: string; content: string }>;
      message: string;
    }>(tool, {});
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].path, 'AGENTS.md');
    assert.match(result.message, /Loaded 1 repository context file/);
  });

  test('get_review_context returns empty files when none exist', async () => {
    const ds: PrDataSource = {
      ...createFakeDataSource(),
      async getReviewContext() {
        return {
          files: [],
          message: 'No repository context files found.',
        };
      },
    };
    const tool = createGetReviewContextTool(ds);
    const result = await run<{
      files: unknown[];
      message: string;
    }>(tool, {});
    assert.equal(result.files.length, 0);
    assert.match(result.message, /No repository context files found/);
  });
});
