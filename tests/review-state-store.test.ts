import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createGitHubReviewStateStore } from '../review/review-state-store.ts';
import type { GitHubClient, IssueComment } from '../github/client.ts';
import { encodeReviewState, type ReviewState } from '../review/review-state.ts';

function createFakeClient(comments: IssueComment[] = []): GitHubClient & {
  createdComments: { body: string }[];
  updatedComments: { id: number; body: string }[];
  commentList: IssueComment[];
} {
  const createdComments: { body: string }[] = [];
  const updatedComments: { id: number; body: string }[] = [];
  let commentList = [...comments];
  let nextId = 1000;

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
    async submitReview() {
      return { id: 1, html_url: 'u' };
    },
    async listIssueComments() {
      return commentList;
    },
    async createIssueComment(_prNumber: number, body: string) {
      createdComments.push({ body });
      const id = nextId++;
      commentList.push({
        id,
        body,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        user: { login: 'github-actions[bot]' },
      });
      return { id, html_url: `https://github.com/o/r/issues/1#issuecomment-${id}` };
    },
    async updateIssueComment(commentId: number, body: string) {
      updatedComments.push({ id: commentId, body });
      const idx = commentList.findIndex((c) => c.id === commentId);
      if (idx >= 0) commentList[idx] = { ...commentList[idx], body };
      return {
        id: commentId,
        html_url: `https://github.com/o/r/issues/1#issuecomment-${commentId}`,
      };
    },
  } as unknown as GitHubClient & {
    createdComments: typeof createdComments;
    updatedComments: typeof updatedComments;
    commentList: IssueComment[];
  };
  client.createdComments = createdComments;
  client.updatedComments = updatedComments;
  client.commentList = commentList;
  return client;
}

const sampleState: ReviewState = {
  reviewedHeadSha: 'abc123',
  findings: [
    {
      severity: 'P2',
      path: 'src/auth.ts',
      line: 10,
      title: 'Silent error',
      explanation: 'Error is swallowed.',
      confidence: 0.7,
    },
  ],
  reviewedAt: 1_700_000_000_000,
};

describe('review state store', () => {
  test('load returns null when no state comment exists', async () => {
    const client = createFakeClient([
      { id: 1, body: 'Great PR!', created_at: '', updated_at: '', user: { login: 'bob' } },
    ]);
    const store = createGitHubReviewStateStore(client, 1);
    const state = await store.load();
    assert.equal(state, null);
  });

  test('load returns the state from the hidden comment', async () => {
    const client = createFakeClient([
      { id: 1, body: 'Nice work', created_at: '', updated_at: '', user: { login: 'bob' } },
      {
        id: 2,
        body: encodeReviewState(sampleState),
        created_at: '',
        updated_at: '',
        user: { login: 'github-actions[bot]' },
      },
    ]);
    const store = createGitHubReviewStateStore(client, 1);
    const state = await store.load();
    assert.deepEqual(state, sampleState);
  });

  test('save creates a new comment when none exists', async () => {
    const client = createFakeClient([]);
    const store = createGitHubReviewStateStore(client, 1);
    await store.save(sampleState);
    assert.equal(client.createdComments.length, 1);
    assert.equal(client.updatedComments.length, 0);
    assert.match(client.createdComments[0].body, /flue-review-state/);
  });

  test('save updates the existing comment when one exists', async () => {
    const client = createFakeClient([
      {
        id: 5,
        body: encodeReviewState(sampleState),
        created_at: '',
        updated_at: '',
        user: { login: 'github-actions[bot]' },
      },
    ]);
    const store = createGitHubReviewStateStore(client, 1);
    // Load first to populate the cached comment id.
    await store.load();
    const newState: ReviewState = {
      reviewedHeadSha: 'new456',
      findings: [],
      reviewedAt: 1_700_000_001_000,
    };
    await store.save(newState);
    assert.equal(client.createdComments.length, 0);
    assert.equal(client.updatedComments.length, 1);
    assert.equal(client.updatedComments[0].id, 5);
    assert.match(client.updatedComments[0].body, /new456/);
  });

  test('save without prior load finds and updates the existing comment', async () => {
    const client = createFakeClient([
      {
        id: 3,
        body: encodeReviewState(sampleState),
        created_at: '',
        updated_at: '',
        user: { login: 'github-actions[bot]' },
      },
    ]);
    const store = createGitHubReviewStateStore(client, 1);
    await store.save({ ...sampleState, reviewedHeadSha: 'updated' });
    assert.equal(client.updatedComments.length, 1);
    assert.equal(client.updatedComments[0].id, 3);
  });

  test('uses the most recent state comment when multiple exist', async () => {
    const oldState: ReviewState = { reviewedHeadSha: 'old', findings: [], reviewedAt: 100 };
    const client = createFakeClient([
      {
        id: 1,
        body: encodeReviewState(oldState),
        created_at: '',
        updated_at: '',
        user: { login: 'github-actions[bot]' },
      },
      {
        id: 2,
        body: encodeReviewState(sampleState),
        created_at: '',
        updated_at: '',
        user: { login: 'github-actions[bot]' },
      },
    ]);
    const store = createGitHubReviewStateStore(client, 1);
    const state = await store.load();
    assert.equal(state?.reviewedHeadSha, 'abc123');
    // Save should update the most recent one (id=2).
    await store.save({ ...sampleState, reviewedHeadSha: 'new' });
    assert.equal(client.updatedComments[0].id, 2);
  });

  test('ignores state comments from non-bot users', async () => {
    const client = createFakeClient([
      {
        id: 1,
        body: encodeReviewState(sampleState),
        created_at: '',
        updated_at: '',
        user: { login: 'malicious-user' },
      },
    ]);
    const store = createGitHubReviewStateStore(client, 1);
    const state = await store.load();
    assert.equal(state, null);
  });

  test('ignores state comments with null user', async () => {
    const client = createFakeClient([
      { id: 1, body: 'regular comment', created_at: '', updated_at: '', user: null },
      {
        id: 2,
        body: encodeReviewState(sampleState),
        created_at: '',
        updated_at: '',
        // null user — should be ignored for state comments
        user: null,
      },
    ]);
    const store = createGitHubReviewStateStore(client, 1);
    // With the bot filter, null-user state comments are ignored.
    // But createFakeClient sets user to github-actions[bot] on created comments,
    // and the existing test data uses null. The bot filter requires [bot] suffix.
    // So this should return null.
    const state = await store.load();
    assert.equal(state, null);
  });

  test('load returns state from a bot user comment', async () => {
    const client = createFakeClient([
      {
        id: 1,
        body: encodeReviewState(sampleState),
        created_at: '',
        updated_at: '',
        user: { login: 'github-actions[bot]' },
      },
    ]);
    const store = createGitHubReviewStateStore(client, 1);
    const state = await store.load();
    assert.deepEqual(state, sampleState);
  });

  test('rejects state comment from a non-matching bot user (e.g. spoof-app[bot])', async () => {
    const client = createFakeClient([
      {
        id: 1,
        body: encodeReviewState(sampleState),
        created_at: '',
        updated_at: '',
        user: { login: 'spoof-app[bot]' },
      },
    ]);
    const store = createGitHubReviewStateStore(client, 1);
    const state = await store.load();
    assert.equal(state, null);
  });

  test('honors custom expectedBotLogin', async () => {
    const client = createFakeClient([
      {
        id: 1,
        body: encodeReviewState(sampleState),
        created_at: '',
        updated_at: '',
        user: { login: 'custom-app[bot]' },
      },
    ]);
    const store = createGitHubReviewStateStore(client, 1, 'custom-app[bot]');
    const state = await store.load();
    assert.deepEqual(state, sampleState);
  });
});
