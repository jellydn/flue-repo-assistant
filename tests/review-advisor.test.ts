import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseAdvisorConfig, runAdvisor, type AdvisorInput } from '../review/advisor.ts';
import type { AttributedFinding } from '../review/specialists.ts';

const candidate: AttributedFinding = {
  severity: 'P1',
  path: 'src/auth.ts',
  line: 10,
  title: 'Handle auth error',
  explanation: 'The error is swallowed.',
  confidence: 0.7,
  sources: ['correctness'],
};

const input = {
  finding: candidate,
  diff: 'diff',
  repositoryContext: 'context',
} satisfies AdvisorInput;

describe('advisor validation', () => {
  test('parses disabled and model-specific configuration', () => {
    assert.deepEqual(parseAdvisorConfig({}), {
      enabled: false,
      model: 'openrouter/cohere/north-mini-code:free',
      timeoutMs: 30_000,
    });
    assert.deepEqual(
      parseAdvisorConfig({
        PR_REVIEW_ADVISOR_ENABLED: 'true',
        PR_REVIEW_ADVISOR_MODEL: 'provider/advisor',
        PR_REVIEW_ADVISOR_TIMEOUT_MS: '500',
      }),
      {
        enabled: true,
        model: 'provider/advisor',
        timeoutMs: 500,
      },
    );
    assert.throws(() => parseAdvisorConfig({ PR_REVIEW_ADVISOR_TIMEOUT_MS: '99' }), /integer/);
  });

  test('retains candidates when advisor is disabled', async () => {
    const report = await runAdvisor({
      config: parseAdvisorConfig({}),
      candidates: [candidate],
      diff: 'diff',
    });
    assert.equal(report.findings.length, 1);
    assert.equal(report.findings[0].advisor.decision, 'accept');
    assert.equal(report.errors.length, 0);
  });

  test('accepts a finding with an observable reason', async () => {
    const report = await runAdvisor({
      config: { enabled: true, model: 'advisor', timeoutMs: 1000 },
      candidates: [candidate],
      diff: 'diff',
      runner: async (received) => {
        assert.equal(received.finding.title, input.finding.title);
        return { decision: 'accept', reason: 'Evidence and severity are supported.' };
      },
    });
    assert.equal(report.findings.length, 1);
    assert.equal(report.findings[0].advisor.reason, 'Evidence and severity are supported.');
    assert.equal(report.decisions[0].decision, 'accept');
  });

  test('applies a valid revision', async () => {
    const report = await runAdvisor({
      config: { enabled: true, model: 'advisor', timeoutMs: 1000 },
      candidates: [candidate],
      diff: 'diff',
      runner: async () => ({
        decision: 'revise',
        reason: 'Lower confidence and clarify the evidence.',
        finding: { severity: 'P2', confidence: 0.6, explanation: 'Clarified evidence.' },
      }),
    });
    assert.equal(report.findings.length, 1);
    assert.equal(report.findings[0].severity, 'P2');
    assert.equal(report.findings[0].confidence, 0.6);
    assert.equal(report.findings[0].advisor.decision, 'revise');
  });

  test('retains the original finding when a revision is invalid', async () => {
    const report = await runAdvisor({
      config: { enabled: true, model: 'advisor', timeoutMs: 1000 },
      candidates: [candidate],
      diff: 'diff',
      runner: async () => ({
        decision: 'revise',
        reason: 'Bad revision.',
        finding: { severity: 'P9' },
      }),
    });
    assert.equal(report.findings.length, 1);
    assert.equal(report.findings[0].severity, 'P1');
    assert.match(report.errors.join('\n'), /revision.*invalid/);
  });

  test('rejects a finding explicitly', async () => {
    const report = await runAdvisor({
      config: { enabled: true, model: 'advisor', timeoutMs: 1000 },
      candidates: [candidate],
      diff: 'diff',
      runner: async () => ({ decision: 'reject', reason: 'No changed-line evidence.' }),
    });
    assert.equal(report.findings.length, 0);
    assert.equal(report.decisions[0].decision, 'reject');
  });

  test('retains a finding when the advisor response is malformed', async () => {
    const report = await runAdvisor({
      config: { enabled: true, model: 'advisor', timeoutMs: 1000 },
      candidates: [candidate],
      diff: 'diff',
      runner: async () => ({ decision: 'maybe' }),
    });
    assert.equal(report.findings.length, 1);
    assert.match(report.errors.join('\n'), /malformed/);
  });

  test('retains a finding when the advisor times out', async () => {
    const report = await runAdvisor({
      config: { enabled: true, model: 'advisor', timeoutMs: 10 },
      candidates: [candidate],
      diff: 'diff',
      runner: async () => new Promise(() => {}),
    });
    assert.equal(report.findings.length, 1);
    assert.match(report.errors.join('\n'), /timed out/);
  });
});
