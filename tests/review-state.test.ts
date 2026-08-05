import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  encodeReviewState,
  isReviewStateComment,
  parseReviewState,
  type ReviewState,
} from '../review/review-state.ts';

const sampleState: ReviewState = {
  reviewedHeadSha: 'abc123def456',
  findings: [
    {
      severity: 'P1',
      path: 'src/auth.ts',
      line: 42,
      title: 'SQL injection',
      explanation: 'User input is concatenated into the query.',
      suggestion: 'Use parameterized queries.',
      confidence: 0.9,
    },
    {
      severity: 'P3',
      path: 'src/utils.ts',
      line: 10,
      title: 'Unused import',
      explanation: 'The import is never used.',
      confidence: 0.6,
    },
  ],
  reviewedAt: 1_700_000_000_000,
};

describe('encodeReviewState', () => {
  test('wraps JSON in an HTML comment with the state marker', () => {
    const body = encodeReviewState(sampleState);
    assert.match(body, /<!--\s*flue-review-state/);
    assert.match(body, /-->/);
    assert.ok(body.includes('abc123def456'));
  });

  test('includes the visible placeholder after the hidden block', () => {
    const body = encodeReviewState(sampleState);
    assert.ok(body.includes('_Flue review state (automated; do not edit)._'));
    // Hidden block comes before the placeholder.
    const markerEnd = body.indexOf('-->');
    const placeholder = body.indexOf('_Flue review state');
    assert.ok(markerEnd > -1 && placeholder > markerEnd);
  });

  test('is detected by isReviewStateComment', () => {
    const body = encodeReviewState(sampleState);
    assert.equal(isReviewStateComment(body), true);
  });
});

describe('parseReviewState', () => {
  test('round-trips an encoded state', () => {
    const body = encodeReviewState(sampleState);
    const parsed = parseReviewState(body);
    assert.deepEqual(parsed, sampleState);
  });

  test('returns null for a non-state comment', () => {
    assert.equal(parseReviewState('just a regular comment'), null);
  });

  test('returns null for an empty string', () => {
    assert.equal(parseReviewState(''), null);
  });

  test('returns null for malformed JSON inside the marker', () => {
    const body = '<!-- flue-review-state\n{not valid json}\n-->';
    assert.equal(parseReviewState(body), null);
  });

  test('returns null for a state with invalid findings', () => {
    const body =
      '<!-- flue-review-state\n{"reviewedHeadSha":"abc","findings":[{"bad":true}],"reviewedAt":1}\n-->';
    assert.equal(parseReviewState(body), null);
  });

  test('returns null for a state missing reviewedHeadSha', () => {
    const body = '<!-- flue-review-state\n{"findings":[],"reviewedAt":1}\n-->';
    assert.equal(parseReviewState(body), null);
  });

  test('parses a state with empty findings', () => {
    const state: ReviewState = {
      reviewedHeadSha: 'sha1',
      findings: [],
      reviewedAt: 123,
    };
    const body = encodeReviewState(state);
    const parsed = parseReviewState(body);
    assert.deepEqual(parsed, state);
  });

  test('parses a legacy HTML-comment-only body (no visible placeholder)', () => {
    const legacy = `<!-- flue-review-state\n${JSON.stringify(sampleState)}\n-->`;
    const parsed = parseReviewState(legacy);
    assert.deepEqual(parsed, sampleState);
  });
});

describe('isReviewStateComment', () => {
  test('returns false for a regular comment', () => {
    assert.equal(isReviewStateComment('looks good to me'), false);
  });

  test('returns true for an encoded state', () => {
    assert.equal(isReviewStateComment(encodeReviewState(sampleState)), true);
  });

  test('returns true for a legacy HTML-comment-only body', () => {
    const legacy = `<!-- flue-review-state\n${JSON.stringify(sampleState)}\n-->`;
    assert.equal(isReviewStateComment(legacy), true);
  });
});
