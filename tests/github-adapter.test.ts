import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createReviewPublisher } from '../github/adapter.ts';
import { GitHubApiError, type GitHubClient, type GitHubReviewPayload } from '../github/client.ts';
import type { ReviewLimits } from '../review/limits.ts';
import { DEFAULT_REVIEW_LIMITS } from '../review/limits.ts';
import type { ReviewStateStore } from '../review/review-state-store.ts';

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
].join('\n');

const DIFF_WITH_DELETED = [
  'diff --git a/src/auth.ts b/src/auth.ts',
  '--- a/src/auth.ts',
  '+++ b/src/auth.ts',
  '@@ -10,3 +10,5 @@',
  ' context',
  '-old',
  '+new one',
  '+new two',
  ' context',
  'diff --git a/src/old.ts b/src/old.ts',
  'deleted file mode 100644',
  '--- a/src/old.ts',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-gone one',
  '-gone two',
].join('\n');

const limits: ReviewLimits = DEFAULT_REVIEW_LIMITS;

function createFakeClient(): GitHubClient & {
  submitted: { prNumber: number; payload: GitHubReviewPayload }[];
} {
  const submitted: { prNumber: number; payload: GitHubReviewPayload }[] = [];
  const client = {
    owner: 'o',
    repo: 'r',
    token: 'secret',
    apiUrl: 'https://api.github.com',
    async getPr() {
      return {
        number: 1,
        title: 't',
        body: 'b',
        user: { login: 'alice' },
        head: { sha: 'h', ref: 'feature' },
        base: { sha: 'b', ref: 'main' },
        draft: false,
      };
    },
    async submitReview(prNumber: number, payload: GitHubReviewPayload) {
      submitted.push({ prNumber, payload });
      return { id: 42, html_url: 'https://github.com/o/r/pulls/1#review-42' };
    },
  } as unknown as GitHubClient & { submitted: typeof submitted };
  client.submitted = submitted;
  return client;
}

describe('review publisher', () => {
  test('posts a COMMENT review with inline comments', async () => {
    const client = createFakeClient();
    const publisher = createReviewPublisher({
      client,
      prNumber: 1,
      headSha: 'head123',
      diffProvider: async () => DIFF,
      limits,
    });

    const result = await publisher.publish({
      summary: 'One medium issue.',
      verdict: 'COMMENT',
      findings: [
        {
          severity: 'P2',
          path: 'src/auth.ts',
          line: 11,
          title: 'Silent error',
          explanation: 'The error is swallowed.',
          suggestion: 'return Result.err(e)',
          confidence: 0.8,
        },
      ],
    });

    assert.equal(result.reviewId, 42);
    assert.equal(result.submittedFindings, 1);
    assert.equal(result.skippedFindings, 0);
    assert.equal(client.submitted[0].payload.event, 'COMMENT');
    assert.equal(client.submitted[0].payload.comments.length, 1);
    const comment = client.submitted[0].payload.comments[0];
    assert.equal(comment.path, 'src/auth.ts');
    assert.equal(comment.side, 'RIGHT');
    assert.match(comment.body, /P2\] Silent error/);
    assert.match(comment.body, /Suggestion/);
  });

  test('uses REQUEST_CHANGES when verdict is REQUEST_CHANGES', async () => {
    const client = createFakeClient();
    const publisher = createReviewPublisher({
      client,
      prNumber: 1,
      headSha: 'head123',
      diffProvider: async () => DIFF,
      limits,
    });

    await publisher.publish({
      summary: 'Blocking issue.',
      verdict: 'REQUEST_CHANGES',
      findings: [
        {
          severity: 'P0',
          path: 'src/auth.ts',
          line: 11,
          title: 'SQL injection',
          explanation: 'User input concatenated into query.',
          confidence: 0.9,
        },
      ],
    });

    assert.equal(client.submitted[0].payload.event, 'REQUEST_CHANGES');
  });

  test('drops findings whose path is not in the diff', async () => {
    const client = createFakeClient();
    const publisher = createReviewPublisher({
      client,
      prNumber: 1,
      headSha: 'head123',
      diffProvider: async () => DIFF,
      limits,
    });

    const result = await publisher.publish({
      summary: 's',
      verdict: 'COMMENT',
      findings: [
        {
          severity: 'P3',
          path: 'not-in-diff.ts',
          line: 1,
          title: 'x',
          explanation: 'y',
          confidence: 0.5,
        },
      ],
    });

    assert.equal(result.submittedFindings, 0);
    assert.equal(result.skippedFindings, 1);
    assert.equal(client.submitted[0].payload.comments.length, 0);
    // Still summarized in the body
    assert.match(client.submitted[0].payload.body, /not posted inline/);
  });

  test('clamps an out-of-range line to the nearest hunk', async () => {
    const client = createFakeClient();
    const publisher = createReviewPublisher({
      client,
      prNumber: 1,
      headSha: 'head123',
      diffProvider: async () => DIFF,
      limits,
    });

    await publisher.publish({
      summary: 's',
      verdict: 'COMMENT',
      findings: [
        {
          severity: 'P3',
          path: 'src/auth.ts',
          line: 9999,
          title: 'x',
          explanation: 'y',
          confidence: 0.5,
        },
      ],
    });

    // Hunk new range is 10..14; 9999 clamps to 14.
    assert.equal(client.submitted[0].payload.comments[0].line, 14);
  });

  test('caps findings to maxFindings', async () => {
    const client = createFakeClient();
    const publisher = createReviewPublisher({
      client,
      prNumber: 1,
      headSha: 'head123',
      diffProvider: async () => DIFF,
      limits: { ...limits, maxFindings: 2 },
    });

    const result = await publisher.publish({
      summary: 's',
      verdict: 'COMMENT',
      findings: Array.from({ length: 5 }, (_, i) => ({
        severity: 'P3' as const,
        path: 'src/auth.ts',
        line: 10 + i,
        title: `t${i}`,
        explanation: 'e',
        confidence: 0.5,
      })),
    });

    assert.equal(result.submittedFindings, 2);
    assert.equal(result.skippedFindings, 3);
  });

  test('rejects an invalid review result', async () => {
    const client = createFakeClient();
    const publisher = createReviewPublisher({
      client,
      prNumber: 1,
      headSha: 'head123',
      diffProvider: async () => DIFF,
      limits,
    });

    await assert.rejects(() => publisher.publish({ verdict: 'COMMENT' }), /invalid review result/);
    assert.equal(client.submitted.length, 0);
  });

  test('handles an empty findings array (no blocking issues)', async () => {
    const client = createFakeClient();
    const publisher = createReviewPublisher({
      client,
      prNumber: 1,
      headSha: 'head123',
      diffProvider: async () => DIFF,
      limits,
    });

    const result = await publisher.publish({
      summary: 'No blocking issues found.',
      verdict: 'COMMENT',
      findings: [],
    });

    assert.equal(result.submittedFindings, 0);
    assert.equal(client.submitted[0].payload.comments.length, 0);
    assert.match(client.submitted[0].payload.body, /No blocking issues found/);
  });

  test('drops findings on deleted files but still posts the review', async () => {
    const client = createFakeClient();
    const publisher = createReviewPublisher({
      client,
      prNumber: 1,
      headSha: 'head123',
      diffProvider: async () => DIFF_WITH_DELETED,
      limits,
    });

    const result = await publisher.publish({
      summary: 's',
      verdict: 'COMMENT',
      findings: [
        {
          severity: 'P2',
          path: 'src/old.ts',
          line: 1,
          title: 'on deleted file',
          explanation: 'e',
          confidence: 0.6,
        },
        {
          severity: 'P2',
          path: 'src/auth.ts',
          line: 11,
          title: 'valid finding',
          explanation: 'e',
          confidence: 0.6,
        },
      ],
    });

    // The deleted-file finding cannot be an inline comment (no right-side
    // lines) but must not sink the whole review.
    assert.equal(result.submittedFindings, 1);
    assert.equal(result.skippedFindings, 1);
    const comments = client.submitted[0].payload.comments;
    assert.equal(comments.length, 1);
    assert.equal(comments[0].path, 'src/auth.ts');
    assert.match(client.submitted[0].payload.body, /not posted inline/);
    assert.match(client.submitted[0].payload.body, /deleted/);
  });

  test('falls back to a body-only review when inline comments 422', async () => {
    const submitted: GitHubReviewPayload[] = [];
    const client = {
      async submitReview(_prNumber: number, payload: GitHubReviewPayload) {
        submitted.push(payload);
        if (payload.comments.length > 0) {
          throw new GitHubApiError('Validation Failed', 422, '{"message":"invalid line"}');
        }
        return { id: 7, html_url: 'https://github.com/o/r/pulls/1#review-7' };
      },
    } as unknown as GitHubClient;

    const publisher = createReviewPublisher({
      client,
      prNumber: 1,
      headSha: 'head123',
      diffProvider: async () => DIFF,
      limits,
    });

    const result = await publisher.publish({
      summary: 's',
      verdict: 'COMMENT',
      findings: [
        {
          severity: 'P2',
          path: 'src/auth.ts',
          line: 11,
          title: 't',
          explanation: 'e',
          confidence: 0.7,
        },
      ],
    });

    assert.equal(submitted.length, 2);
    assert.equal(submitted[0].comments.length, 1);
    assert.equal(submitted[1].comments.length, 0);
    assert.equal(result.reviewId, 7);
    assert.equal(result.submittedFindings, 0);
    assert.match(result.validationIssues.join('\n'), /body-only/);
  });

  test('rethrows non-422 submit errors', async () => {
    const client = {
      async submitReview() {
        throw new GitHubApiError('Server Error', 500, 'boom');
      },
    } as unknown as GitHubClient;

    const publisher = createReviewPublisher({
      client,
      prNumber: 1,
      headSha: 'head123',
      diffProvider: async () => DIFF,
      limits,
    });

    await assert.rejects(
      () =>
        publisher.publish({
          summary: 's',
          verdict: 'COMMENT',
          findings: [
            {
              severity: 'P3',
              path: 'src/auth.ts',
              line: 11,
              title: 't',
              explanation: 'e',
              confidence: 0.5,
            },
          ],
        }),
      /Server Error/,
    );
  });

  test('saves review state after successful review', async () => {
    const client = createFakeClient();
    const saved: unknown[] = [];
    const stateStore: ReviewStateStore = {
      async load() {
        return null;
      },
      async save(state) {
        saved.push(state);
      },
    };
    const publisher = createReviewPublisher({
      client,
      prNumber: 1,
      headSha: 'sha-after-review',
      diffProvider: async () => DIFF,
      limits,
      stateStore,
    });

    await publisher.publish({
      summary: 's',
      verdict: 'COMMENT',
      findings: [
        {
          severity: 'P2',
          path: 'src/auth.ts',
          line: 11,
          title: 't',
          explanation: 'e',
          confidence: 0.7,
        },
      ],
    });

    assert.equal(saved.length, 1);
    const state = saved[0] as { reviewedHeadSha: string; findings: unknown[]; reviewedAt: number };
    assert.equal(state.reviewedHeadSha, 'sha-after-review');
    assert.equal(state.findings.length, 1);
    assert.ok(state.reviewedAt > 0);
  });

  test('saves empty findings state after a clean review', async () => {
    const saved: unknown[] = [];
    const stateStore: ReviewStateStore = {
      async load() {
        return null;
      },
      async save(state) {
        saved.push(state);
      },
    };
    const publisher = createReviewPublisher({
      client: createFakeClient(),
      prNumber: 1,
      headSha: 'clean-sha',
      diffProvider: async () => DIFF,
      limits,
      stateStore,
    });

    await publisher.publish({
      summary: 'No blocking issues found.',
      verdict: 'COMMENT',
      findings: [],
    });

    assert.equal(saved.length, 1);
    const state = saved[0] as { reviewedHeadSha: string; findings: unknown[] };
    assert.equal(state.reviewedHeadSha, 'clean-sha');
    assert.equal(state.findings.length, 0);
  });

  test('saves capped findings in state when findings exceed maxFindings', async () => {
    const saved: unknown[] = [];
    const stateStore: ReviewStateStore = {
      async load() {
        return null;
      },
      async save(state) {
        saved.push(state);
      },
    };
    const publisher = createReviewPublisher({
      client: createFakeClient(),
      prNumber: 1,
      headSha: 'head',
      diffProvider: async () => DIFF,
      limits: { ...limits, maxFindings: 2 },
      stateStore,
    });

    await publisher.publish({
      summary: 's',
      verdict: 'COMMENT',
      findings: Array.from({ length: 5 }, (_, i) => ({
        severity: 'P3' as const,
        path: 'src/auth.ts',
        line: 10 + i,
        title: `t${i}`,
        explanation: 'e',
        confidence: 0.5,
      })),
    });

    const state = saved[0] as { findings: unknown[] };
    assert.equal(state.findings.length, 2);
  });

  test('does not save state when review submission fails', async () => {
    const saved: unknown[] = [];
    const stateStore: ReviewStateStore = {
      async load() {
        return null;
      },
      async save(state) {
        saved.push(state);
      },
    };
    const client = {
      async submitReview() {
        throw new GitHubApiError('Server Error', 500, 'boom');
      },
    } as unknown as GitHubClient;

    const publisher = createReviewPublisher({
      client,
      prNumber: 1,
      headSha: 'head',
      diffProvider: async () => DIFF,
      limits,
      stateStore,
    });

    await assert.rejects(() =>
      publisher.publish({
        summary: 's',
        verdict: 'COMMENT',
        findings: [
          {
            severity: 'P3',
            path: 'src/auth.ts',
            line: 11,
            title: 't',
            explanation: 'e',
            confidence: 0.5,
          },
        ],
      }),
    );
    assert.equal(saved.length, 0);
  });

  test('state-save failure does not throw after successful review', async () => {
    const client = createFakeClient();
    const stateStore: ReviewStateStore = {
      async load() {
        return null;
      },
      async save() {
        throw new Error('API unavailable');
      },
    };
    const publisher = createReviewPublisher({
      client,
      prNumber: 1,
      headSha: 'head',
      diffProvider: async () => DIFF,
      limits,
      stateStore,
    });

    const result = await publisher.publish({
      summary: 's',
      verdict: 'COMMENT',
      findings: [
        {
          severity: 'P3',
          path: 'src/auth.ts',
          line: 11,
          title: 't',
          explanation: 'e',
          confidence: 0.5,
        },
      ],
    });

    // Review was posted successfully despite state-save failure
    assert.equal(result.reviewId, 42);
    assert.ok(result.validationIssues.some((v) => v.includes('Failed to persist review state')));
  });

  test('renders previous finding classifications in the review body', async () => {
    const client = createFakeClient();
    const publisher = createReviewPublisher({
      client,
      prNumber: 1,
      headSha: 'head',
      diffProvider: async () => DIFF,
      limits,
    });

    await publisher.publish({
      summary: 'Incremental review.',
      verdict: 'COMMENT',
      findings: [],
      previousFindingClassifications: [
        {
          path: 'src/auth.ts',
          line: 11,
          title: 'SQL injection',
          status: 'resolved',
          note: 'Fixed by parameterized query',
        },
        { path: 'src/auth.ts', line: 20, title: 'Missing test', status: 'still-present' },
        { path: 'src/old.ts', line: 5, title: 'Dead code', status: 'obsolete' },
        {
          path: 'src/utils.ts',
          line: 30,
          title: 'Race condition',
          status: 'uncertain',
          note: 'Need more context',
        },
      ],
    });

    const body = client.submitted[0].payload.body;
    assert.match(body, /Previous findings status/);
    assert.match(body, /✅.*resolved.*SQL injection/);
    assert.match(body, /⚠️.*still-present.*Missing test/);
    assert.match(body, /🗑️.*obsolete.*Dead code/);
    assert.match(body, /❓.*uncertain.*Race condition/);
  });

  test('excludes dropped findings from saved state', async () => {
    const client = createFakeClient();
    let savedState: any = null;
    const stateStore: ReviewStateStore = {
      async load() {
        return null;
      },
      async save(s) {
        savedState = s;
      },
    };
    const publisher = createReviewPublisher({
      client,
      prNumber: 1,
      headSha: 'head',
      diffProvider: async () => DIFF,
      limits,
      stateStore,
    });

    await publisher.publish({
      summary: 's',
      verdict: 'COMMENT',
      findings: [
        {
          severity: 'P3',
          path: 'src/auth.ts',
          line: 11,
          title: 'Valid finding',
          explanation: 'e',
          confidence: 0.5,
        },
        {
          severity: 'P2',
          path: 'src/nonexistent.ts',
          line: 5,
          title: 'Dropped finding',
          explanation: 'e',
          confidence: 0.5,
        },
      ],
    });

    assert.equal(savedState.findings.length, 1);
    assert.equal(savedState.findings[0].path, 'src/auth.ts');
  });

  test('renders proposed learnings in the review body', async () => {
    const client = createFakeClient();
    const publisher = createReviewPublisher({
      client,
      prNumber: 1,
      headSha: 'head',
      diffProvider: async () => DIFF,
      limits,
    });

    await publisher.publish({
      summary: 'Review with learnings.',
      verdict: 'COMMENT',
      findings: [],
      proposedLearnings: [
        {
          category: 'convention',
          content: 'Always use parameterized queries for SQL.',
          justification: 'SQL injection found in 2 PRs.',
        },
        {
          category: 'test-command',
          content: 'Run npm run check before submitting.',
          justification: 'CI failures from untested changes.',
        },
      ],
    });

    const body = client.submitted[0].payload.body;
    assert.match(body, /Proposed repository learnings/);
    assert.match(body, /\[convention\].*parameterized queries/);
    assert.match(body, /\[test-command\].*npm run check/);
    assert.match(body, /SQL injection found in 2 PRs/);
    assert.match(body, /manually/);
  });

  test('does not render proposed learnings section when none provided', async () => {
    const client = createFakeClient();
    const publisher = createReviewPublisher({
      client,
      prNumber: 1,
      headSha: 'head',
      diffProvider: async () => DIFF,
      limits,
    });

    await publisher.publish({
      summary: 'Clean review.',
      verdict: 'COMMENT',
      findings: [],
    });

    const body = client.submitted[0].payload.body;
    assert.doesNotMatch(body, /Proposed repository learnings/);
  });

  test('normalizes multiline proposed learnings to single lines in review body', async () => {
    const client = createFakeClient();
    const publisher = createReviewPublisher({
      client,
      prNumber: 1,
      headSha: 'head',
      diffProvider: async () => DIFF,
      limits,
    });

    await publisher.publish({
      summary: 'Review with multiline learnings.',
      verdict: 'COMMENT',
      findings: [],
      proposedLearnings: [
        {
          category: 'convention',
          content: 'Line 1\nLine 2',
          justification: 'Justification line 1\r\nJustification line 2',
        },
      ],
    });

    const body = client.submitted[0].payload.body;
    assert.match(body, /- \*\*\[convention\]\*\* Line 1 Line 2/);
    assert.match(body, /— _Justification line 1 Justification line 2_/);
  });
});
