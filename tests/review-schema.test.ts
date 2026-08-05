import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  parseReviewResult,
  recoverFindings,
  recoverReviewResult,
  reviewResultSchema,
  safeParseReviewResult,
} from '../review/schema.ts';
import * as v from 'valibot';

const validResult = {
  summary: 'Looks good overall with one concern.',
  verdict: 'COMMENT',
  findings: [
    {
      severity: 'medium',
      path: 'src/auth.ts',
      line: 42,
      title: 'Unhandled error in login',
      explanation: 'The catch block swallows the error silently.',
      suggestion: 'return Result.err(error)',
      confidence: 0.7,
    },
  ],
};

describe('review schema', () => {
  test('parses and normalizes a legacy review result', () => {
    const result = parseReviewResult(validResult);
    assert.equal(result.verdict, 'COMMENT');
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].severity, 'P2');
  });

  test('accepts canonical P0-P3 severity values', () => {
    const parsed = safeParseReviewResult({
      summary: 'No blocking issues found.',
      verdict: 'COMMENT',
      findings: [
        {
          severity: 'P0',
          path: 'src/auth.ts',
          title: 'Critical issue',
          explanation: 'Evidence',
          confidence: 1,
        },
        {
          severity: 'P1',
          path: 'src/auth.ts',
          line: 42,
          title: 'High issue',
          explanation: 'Evidence',
          confidence: 0.9,
        },
        {
          severity: 'P2',
          path: 'src/auth.ts',
          line: 42,
          title: 'Medium issue',
          explanation: 'Evidence',
          confidence: 0.7,
        },
        {
          severity: 'P3',
          path: 'src/auth.ts',
          line: 42,
          title: 'Low issue',
          explanation: 'Evidence',
          confidence: 0.5,
        },
      ],
    });
    assert.equal(parsed.ok, true);
    if (parsed.ok)
      assert.deepEqual(
        parsed.value.findings.map((finding) => finding.severity),
        ['P0', 'P1', 'P2', 'P3'],
      );
  });

  test('accepts an empty findings array', () => {
    const result = parseReviewResult({
      summary: 'No blocking issues found.',
      verdict: 'COMMENT',
      findings: [],
    });
    assert.deepEqual(result.findings, []);
  });

  test('rejects an APPROVE verdict', () => {
    const parsed = safeParseReviewResult({ summary: 'lgtm', verdict: 'APPROVE', findings: [] });
    assert.equal(parsed.ok, false);
  });

  test('rejects findings over the max count', () => {
    const tooMany = {
      summary: 's',
      verdict: 'COMMENT',
      findings: Array.from({ length: 51 }, () => ({
        severity: 'P3',
        path: 'a.ts',
        line: 1,
        title: 't',
        explanation: 'e',
        confidence: 0.1,
      })),
    };
    const parsed = safeParseReviewResult(tooMany);
    assert.equal(parsed.ok, false);
  });

  test('accepts body-only findings without line citations', () => {
    const parsed = safeParseReviewResult({
      summary: 'Evidence is attached to the changed file.',
      verdict: 'COMMENT',
      findings: [
        {
          severity: 'P2',
          path: 'src/auth.ts',
          title: 'Body-only finding',
          explanation: 'Evidence',
          confidence: 0.8,
        },
      ],
    });
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.equal(parsed.value.findings[0].line, undefined);
  });

  test('recovers valid findings while reporting malformed items', () => {
    const recovered = recoverFindings([
      {
        severity: 'low',
        path: 'a.ts',
        line: 1,
        title: 'Valid',
        explanation: 'Evidence',
        confidence: 0.5,
      },
      {
        severity: 'P2',
        path: 'b.ts',
        title: 'Also valid',
        explanation: 'Evidence',
        confidence: 0.8,
      },
      {
        severity: 'P9',
        path: 'c.ts',
        title: 'Malformed',
        explanation: 'Missing priority',
        confidence: 0.8,
      },
    ]);
    assert.deepEqual(
      recovered.findings.map((finding) => finding.severity),
      ['P3', 'P2'],
    );
    assert.equal(recovered.rejectedFindings, 1);
    assert.equal(recovered.issues.length, 1);
    assert.match(recovered.issues[0], /findings\.2/);
  });

  test('recovers a review envelope with mixed findings', () => {
    const recovered = recoverReviewResult({
      summary: 'Mixed result.',
      verdict: 'COMMENT',
      findings: [
        {
          severity: 'P1',
          path: 'a.ts',
          line: 2,
          title: 'Valid',
          explanation: 'Evidence',
          confidence: 0.9,
        },
        {
          severity: 'bad',
          path: 'b.ts',
          title: 'Invalid',
          explanation: 'Evidence',
          confidence: 0.9,
        },
      ],
    });
    assert.equal(recovered.ok, true);
    if (recovered.ok) {
      assert.equal(recovered.value.findings.length, 1);
      assert.equal(recovered.value.findings[0].severity, 'P1');
      assert.equal(recovered.rejectedFindings, 1);
      assert.equal(recovered.issues.length, 1);
    }
  });

  test('rejects a malformed review envelope during recovery', () => {
    const recovered = recoverReviewResult({ verdict: 'COMMENT', findings: [] });
    assert.equal(recovered.ok, false);
  });

  test('rejects confidence outside [0,1]', () => {
    const parsed = safeParseReviewResult({
      summary: 's',
      verdict: 'COMMENT',
      findings: [
        { severity: 'P3', path: 'a.ts', line: 1, title: 't', explanation: 'e', confidence: 1.5 },
      ],
    });
    assert.equal(parsed.ok, false);
  });

  test('rejects unknown severity', () => {
    const parsed = safeParseReviewResult({
      summary: 's',
      verdict: 'COMMENT',
      findings: [
        {
          severity: 'blocker',
          path: 'a.ts',
          line: 1,
          title: 't',
          explanation: 'e',
          confidence: 0.5,
        },
      ],
    });
    assert.equal(parsed.ok, false);
  });

  test('safeParse returns issues list on failure', () => {
    const parsed = safeParseReviewResult({ verdict: 'COMMENT' });
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.ok(parsed.issues.length > 0);
  });

  test('schema is a valibot object schema', () => {
    assert.equal(v.is(reviewResultSchema, validResult), true);
  });

  test('accepts a valid previousFindingClassifications array', () => {
    const parsed = safeParseReviewResult({
      ...validResult,
      previousFindingClassifications: [
        { path: 'src/auth.ts', line: 42, title: 'SQL injection', status: 'resolved' },
        {
          path: 'src/utils.ts',
          line: 10,
          title: 'Unused import',
          status: 'still-present',
          note: 'Still there',
        },
      ],
    });
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.value.previousFindingClassifications?.length, 2);
      assert.equal(parsed.value.previousFindingClassifications?.[0].status, 'resolved');
    }
  });

  test('accepts a review result without previousFindingClassifications', () => {
    const parsed = safeParseReviewResult(validResult);
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.equal(parsed.value.previousFindingClassifications, undefined);
  });

  test('rejects an invalid finding status', () => {
    const parsed = safeParseReviewResult({
      ...validResult,
      previousFindingClassifications: [
        { path: 'src/auth.ts', line: 42, title: 'SQL injection', status: 'fixed' },
      ],
    });
    assert.equal(parsed.ok, false);
  });

  test('rejects a classification missing required fields', () => {
    const parsed = safeParseReviewResult({
      ...validResult,
      previousFindingClassifications: [{ path: 'src/auth.ts', line: 42, status: 'resolved' }],
    });
    assert.equal(parsed.ok, false);
  });

  test('accepts a valid proposedLearnings array', () => {
    const parsed = safeParseReviewResult({
      ...validResult,
      proposedLearnings: [
        {
          category: 'convention',
          content: 'Always use parameterized queries for SQL.',
          justification: 'SQL injection found in 2 PRs this month.',
        },
        {
          category: 'test-command',
          content: 'Run npm run check before submitting.',
          justification: 'CI failures from untested changes.',
        },
      ],
    });
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.value.proposedLearnings?.length, 2);
      assert.equal(parsed.value.proposedLearnings?.[0].category, 'convention');
    }
  });

  test('accepts a review result without proposedLearnings', () => {
    const parsed = safeParseReviewResult(validResult);
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.equal(parsed.value.proposedLearnings, undefined);
  });

  test('rejects an invalid learning category', () => {
    const parsed = safeParseReviewResult({
      ...validResult,
      proposedLearnings: [{ category: 'random', content: 'test', justification: 'test' }],
    });
    assert.equal(parsed.ok, false);
  });

  test('rejects a proposed learning missing required fields', () => {
    const parsed = safeParseReviewResult({
      ...validResult,
      proposedLearnings: [{ category: 'convention', content: 'test' }],
    });
    assert.equal(parsed.ok, false);
  });
});
