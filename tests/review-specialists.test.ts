import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  SPECIALIST_ROLES,
  adjudicateFindings,
  parseSpecialistConfig,
  runSpecialistReview,
  type AttributedFinding,
  type SpecialistContext,
} from '../review/specialists.ts';

const context: SpecialistContext = {
  prNumber: 1,
  title: 'Test PR',
  diff: 'diff --git a/src/auth.ts b/src/auth.ts',
  changedFiles: ['src/auth.ts'],
};

const finding = (
  overrides: Partial<{
    severity: 'P0' | 'P1' | 'P2' | 'P3';
    path: string;
    line: number;
    title: string;
    explanation: string;
    confidence: number;
  }> = {},
) => ({
  severity: 'P2' as const,
  path: 'src/auth.ts',
  line: 10,
  title: 'Handle auth error',
  explanation: 'The error is swallowed.',
  confidence: 0.7,
  ...overrides,
});

describe('specialist review orchestration', () => {
  test('enables all roles by default and supports role selection', () => {
    assert.deepEqual(parseSpecialistConfig({}).enabledRoles, SPECIALIST_ROLES);
    assert.deepEqual(
      parseSpecialistConfig({ PR_REVIEW_SPECIALISTS: 'security,testing' }).enabledRoles,
      ['security', 'testing'],
    );
    assert.throws(
      () => parseSpecialistConfig({ PR_REVIEW_SPECIALISTS: 'security,unknown' }),
      /unknown role/,
    );
    assert.throws(
      () => parseSpecialistConfig({ PR_REVIEW_SPECIALIST_TIMEOUT_MS: '99' }),
      /integer/,
    );
  });

  test('runs enabled specialists concurrently', async () => {
    const started: string[] = [];
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resultPromise = runSpecialistReview({
      config: { enabledRoles: ['correctness', 'security'], timeoutMs: 1_000 },
      context,
      runner: async (role) => {
        started.push(role);
        await barrier;
        return [finding({ title: `${role} issue` })];
      },
    });
    while (started.length < 2) await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(started, ['correctness', 'security']);
    release();
    const report = await resultPromise;
    assert.equal(report.roles.length, 2);
    assert.equal(report.findings.length, 2);
  });

  test('keeps successful findings when one specialist fails', async () => {
    const report = await runSpecialistReview({
      config: { enabledRoles: ['correctness', 'security'], timeoutMs: 1_000 },
      context,
      runner: async (role) => {
        if (role === 'security') throw new Error('provider unavailable');
        return [finding({ title: 'Correctness issue' })];
      },
    });
    assert.equal(report.findings.length, 1);
    assert.equal(report.roles.find((role) => role.role === 'security')?.status, 'rejected');
    assert.match(report.errors.join('\n'), /provider unavailable/);
  });

  test('times out a runner that ignores AbortSignal', async () => {
    const started = Date.now();
    const report = await runSpecialistReview({
      config: { enabledRoles: ['security'], timeoutMs: 10 },
      context,
      runner: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return [finding({ title: 'Late finding' })];
      },
    });
    assert.ok(Date.now() - started < 90);
    assert.equal(report.roles[0].status, 'timed-out');
  });

  test('keeps successful findings when one specialist times out', async () => {
    const report = await runSpecialistReview({
      config: { enabledRoles: ['correctness', 'security'], timeoutMs: 10 },
      context,
      runner: async (role, _context, signal) => {
        if (role === 'security') {
          await new Promise<void>((resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
        }
        return [finding({ title: 'Correctness issue' })];
      },
    });
    assert.equal(report.findings.length, 1);
    assert.equal(report.roles.find((role) => role.role === 'security')?.status, 'timed-out');
  });

  test('validates specialist output and reports malformed items', async () => {
    const report = await runSpecialistReview({
      config: { enabledRoles: ['testing'], timeoutMs: 1_000 },
      context,
      runner: async () => [finding(), { severity: 'invalid' }],
    });
    assert.equal(report.findings.length, 1);
    assert.equal(report.findings[0].sources[0], 'testing');
    assert.equal(report.validationIssues.length, 1);
  });

  test('deduplicates overlapping findings and retains source roles', () => {
    const findings: AttributedFinding[] = [
      {
        ...finding({ severity: 'P2' as const, line: 10, confidence: 0.7 }),
        sources: ['correctness'],
      },
      { ...finding({ severity: 'P1' as const, line: 12, confidence: 0.8 }), sources: ['security'] },
      { ...finding({ severity: 'P3' as const, line: 40, confidence: 0.9 }), sources: ['testing'] },
    ];
    const result = adjudicateFindings(findings);
    assert.equal(result.length, 2);
    assert.equal(result[0].severity, 'P1');
    assert.deepEqual(result[0].sources, ['correctness', 'security']);
    assert.ok(Math.abs(result[0].confidence - 0.85) < Number.EPSILON);
  });

  test('merges transitive overlaps into one finding group', () => {
    const result = adjudicateFindings([
      { ...finding({ line: 10, title: 'Auth error handling' }), sources: ['correctness'] },
      { ...finding({ line: 12, title: 'Auth error handling' }), sources: ['security'] },
      { ...finding({ line: 14, title: 'Auth error handling' }), sources: ['testing'] },
    ]);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].sources, ['correctness', 'security', 'testing']);
  });

  test('does not deduplicate different paths or unrelated titles', () => {
    const result = adjudicateFindings([
      { ...finding(), sources: ['correctness'] },
      { ...finding({ path: 'src/other.ts' }), sources: ['security'] },
      { ...finding({ title: 'Add a missing test' }), sources: ['testing'] },
    ]);
    assert.equal(result.length, 3);
  });
});
