import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { ToolDefinition } from '@flue/runtime';
import type { InspectionMetadata } from '../tools/repository.ts';
import {
  createDebugLogger,
  createRepositoryReader,
  createStepBudget,
} from '../tools/repository.ts';
import { createListFilesTool } from '../tools/list-files.ts';
import { createReadFileTool } from '../tools/read-file.ts';
import { createSearchCodeTool } from '../tools/search-code.ts';
import { createSearchDocsTool } from '../tools/search-docs.ts';
import { createCallTracker } from '../investigation/call-tracker.ts';
import {
  createEvidenceCollector,
  extractEvidence,
  isDocumentationFile,
} from '../investigation/evidence.ts';
import {
  calculateConfidence,
  formatAnswer,
  formatCitation,
} from '../investigation/answer.ts';
import {
  runInvestigation,
  buildToolMap,
  DEFAULT_MAX_ITERATIONS,
} from '../investigation/loop.ts';
import type {
  Confidence,
  DecisionFn,
  Evidence,
  GroundedAnswer,
  InvestigationResult,
} from '../investigation/types.ts';
import { createSampleRepo, removeRepo } from './helpers.ts';

const noDebug = () => createDebugLogger(false);
let root: string;

before(async () => {
  root = await createSampleRepo();
});

after(async () => {
  await removeRepo(root);
});

// ---------------------------------------------------------------------------
// 1. search_docs tool
// ---------------------------------------------------------------------------

type SearchDocsResult = {
  query: string;
  path: string;
  matches: Array<{ path: string; line: number; excerpt: string }>;
  filesSearched: number;
  truncated: boolean;
  inspection: InspectionMetadata;
};

describe('search_docs tool', () => {
  test('finds relevant Markdown documentation files', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(8);
    const tool = createSearchDocsTool(repository, budget, noDebug());
    const result = (await tool.run({
      input: { query: 'authentication', path: '.', caseSensitive: false },
    })) as SearchDocsResult;
    assert.ok(result.matches.length > 0);
    // Should find matches in README.md, AGENTS.md, and docs/architecture.md
    const paths = new Set(result.matches.map((m) => m.path));
    assert.ok(paths.has('README.md') || paths.has('docs/architecture.md'));
    // Should not find source code files
    assert.ok(!paths.has('src/auth.ts'));
  });

  test('excludes irrelevant directories (node_modules)', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(8);
    const tool = createSearchDocsTool(repository, budget, noDebug());
    const result = (await tool.run({
      input: { query: 'login', path: '.', caseSensitive: false },
    })) as SearchDocsResult;
    // node_modules/ignored.js is NOT a doc file, so it should never appear
    assert.ok(
      result.matches.every((m) => !m.path.includes('node_modules')),
    );
  });

  test('handles zero matches clearly', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(8);
    const tool = createSearchDocsTool(repository, budget, noDebug());
    const result = (await tool.run({
      input: { query: 'doesnotexistxyz', path: '.', caseSensitive: false },
    })) as SearchDocsResult;
    assert.deepEqual(result.matches, []);
    assert.equal(result.truncated, false);
    assert.ok(result.filesSearched > 0);
  });

  test('consumes exactly one inspection step', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(8);
    const tool = createSearchDocsTool(repository, budget, noDebug());
    await tool.run({
      input: { query: 'architecture', path: '.', caseSensitive: false },
    });
    assert.equal(budget.used, 1);
  });

  test('searches docs/ subdirectory files', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(8);
    const tool = createSearchDocsTool(repository, budget, noDebug());
    const result = (await tool.run({
      input: { query: 'layered design', path: '.', caseSensitive: false },
    })) as SearchDocsResult;
    const archHit = result.matches.find((m) => m.path === 'docs/architecture.md');
    assert.ok(archHit, 'should find docs/architecture.md');
  });

  test('shares budget with other inspection tools', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(3);
    const searchDocs = createSearchDocsTool(repository, budget, noDebug());
    const searchCode = createSearchCodeTool(repository, budget, noDebug());
    const readFile = createReadFileTool(repository, budget, noDebug());
    await searchDocs.run({ input: { query: 'auth', path: '.', caseSensitive: false } });
    await searchCode.run({ input: { query: 'login', path: '.', caseSensitive: false } });
    await readFile.run({ input: { path: 'src/config.ts', startLine: 1 } });
    assert.equal(budget.used, 3);
    assert.equal(budget.remaining, 0);
  });
});

// ---------------------------------------------------------------------------
// 2. Evidence collector
// ---------------------------------------------------------------------------

describe('evidence collector', () => {
  test('adds and deduplicates evidence by file + line range', () => {
    const collector = createEvidenceCollector();
    const ev: Evidence = {
      filePath: 'src/auth.ts',
      lineStart: 1,
      lineEnd: 5,
      excerpt: 'export function login()',
      sourceType: 'code',
      relevance: 1.0,
    };
    assert.equal(collector.add(ev), true);
    assert.equal(collector.add(ev), false); // duplicate
    assert.equal(collector.count, 1);
  });

  test('truncates long excerpts', () => {
    const collector = createEvidenceCollector();
    collector.add({
      filePath: 'big.ts',
      lineStart: 1,
      lineEnd: 1,
      excerpt: 'x'.repeat(1000),
      sourceType: 'code',
    });
    assert.ok(collector.items[0].excerpt.length <= 500);
  });

  test('tracks documentation vs code evidence', () => {
    const collector = createEvidenceCollector();
    collector.add({
      filePath: 'README.md',
      lineStart: 1,
      lineEnd: 1,
      excerpt: '# Project',
      sourceType: 'documentation',
    });
    collector.add({
      filePath: 'src/auth.ts',
      lineStart: 1,
      lineEnd: 1,
      excerpt: 'login()',
      sourceType: 'code',
    });
    assert.equal(collector.hasDocumentation, true);
    assert.equal(collector.hasCode, true);
    assert.equal(collector.files.size, 2);
  });

  test('extractEvidence from search_docs results adds documentation evidence', () => {
    const collector = createEvidenceCollector();
    extractEvidence('search_docs', {
      matches: [{ path: 'README.md', line: 3, excerpt: 'authentication' }],
    }, collector);
    assert.equal(collector.count, 1);
    assert.equal(collector.items[0].sourceType, 'documentation');
    assert.equal(collector.items[0].relevance, 0.5);
  });

  test('extractEvidence from read_file results adds high-relevance evidence', () => {
    const collector = createEvidenceCollector();
    extractEvidence('read_file', {
      path: 'src/auth.ts',
      startLine: 1,
      endLine: 5,
      content: 'export function login() {}',
    }, collector);
    assert.equal(collector.count, 1);
    assert.equal(collector.items[0].sourceType, 'code');
    assert.equal(collector.items[0].relevance, 1.0);
  });

  test('extractEvidence from list_files adds no evidence', () => {
    const collector = createEvidenceCollector();
    extractEvidence('list_files', { entries: [], path: '.' }, collector);
    assert.equal(collector.count, 0);
  });

  test('isDocumentationFile detects markdown and text', () => {
    assert.equal(isDocumentationFile('README.md'), true);
    assert.equal(isDocumentationFile('docs/guide.txt'), true);
    assert.equal(isDocumentationFile('src/auth.ts'), false);
  });
});

// ---------------------------------------------------------------------------
// 3. Call tracker
// ---------------------------------------------------------------------------

describe('call tracker', () => {
  test('blocks repeated identical calls', () => {
    const tracker = createCallTracker();
    const input = { query: 'auth', path: '.', caseSensitive: false };
    assert.equal(tracker.has('search_code', input), false);
    tracker.record({ tool: 'search_code', input, timestamp: Date.now() });
    assert.equal(tracker.has('search_code', input), true);
  });

  test('allows same tool with different input', () => {
    const tracker = createCallTracker();
    tracker.record({
      tool: 'search_code',
      input: { query: 'auth' },
      timestamp: Date.now(),
    });
    assert.equal(
      tracker.has('search_code', { query: 'login' }),
      false,
    );
  });

  test('canonicalizes input key order', () => {
    const tracker = createCallTracker();
    tracker.record({
      tool: 'search_code',
      input: { path: '.', query: 'auth' },
      timestamp: Date.now(),
    });
    // Different key order, same content → should be detected as duplicate
    assert.equal(
      tracker.has('search_code', { query: 'auth', path: '.' }),
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Confidence and answer formatting
// ---------------------------------------------------------------------------

describe('confidence calculation', () => {
  test('Insufficient when no evidence', () => {
    assert.equal(calculateConfidence([]), 'Insufficient');
  });

  test('Low when only search matches (leads)', () => {
    const evidence: Evidence[] = [
      { filePath: 'a.ts', lineStart: 1, lineEnd: 1, excerpt: 'x', sourceType: 'code', relevance: 0.5 },
    ];
    assert.equal(calculateConfidence(evidence), 'Low');
  });

  test('Medium when read evidence from one file', () => {
    const evidence: Evidence[] = [
      { filePath: 'a.ts', lineStart: 1, lineEnd: 10, excerpt: 'x', sourceType: 'code', relevance: 1.0 },
    ];
    assert.equal(calculateConfidence(evidence), 'Medium');
  });

  test('High when reads from 2+ files', () => {
    const evidence: Evidence[] = [
      { filePath: 'a.ts', lineStart: 1, lineEnd: 10, excerpt: 'x', sourceType: 'code', relevance: 1.0 },
      { filePath: 'b.ts', lineStart: 1, lineEnd: 10, excerpt: 'y', sourceType: 'code', relevance: 1.0 },
    ];
    assert.equal(calculateConfidence(evidence), 'High');
  });

  test('High when both docs and code corroborate', () => {
    const evidence: Evidence[] = [
      { filePath: 'README.md', lineStart: 1, lineEnd: 5, excerpt: 'auth', sourceType: 'documentation', relevance: 1.0 },
      { filePath: 'src/auth.ts', lineStart: 1, lineEnd: 5, excerpt: 'login', sourceType: 'code', relevance: 1.0 },
    ];
    assert.equal(calculateConfidence(evidence), 'High');
  });
});

describe('answer formatting', () => {
  test('insufficient evidence answer is honest', () => {
    const answer = formatAnswer('Where is payment processing?', [], [], []);
    assert.equal(answer.confidence, 'Insufficient');
    assert.equal(answer.insufficientEvidence, true);
    assert.equal(answer.keyFindings.length, 0);
    assert.match(answer.answer, /could not find sufficient evidence/i);
    assert.doesNotMatch(answer.answer, /payment.*implemented/i);
  });

  test('grounded answer includes citations', () => {
    const evidence: Evidence[] = [
      { filePath: 'src/auth.ts', lineStart: 1, lineEnd: 5, excerpt: 'export function login()', sourceType: 'code', relevance: 1.0 },
    ];
    const answer = formatAnswer('How does auth work?', evidence, ['search_code', 'read_file'], []);
    assert.ok(answer.sources.length > 0);
    assert.match(answer.sources[0], /src\/auth\.ts:1-5/);
    assert.ok(answer.keyFindings.length > 0);
    assert.ok(answer.keyFindings[0].citation.includes('src/auth.ts'));
  });

  test('formatCitation handles single line and ranges', () => {
    assert.equal(
      formatCitation({ filePath: 'a.ts', lineStart: 5, lineEnd: 5, excerpt: '', sourceType: 'code' }),
      'a.ts:5',
    );
    assert.equal(
      formatCitation({ filePath: 'a.ts', lineStart: 1, lineEnd: 10, excerpt: '', sourceType: 'code' }),
      'a.ts:1-10',
    );
    assert.equal(
      formatCitation({ filePath: 'a.ts', excerpt: '', sourceType: 'code' }),
      'a.ts',
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Investigation loop
// ---------------------------------------------------------------------------

function buildTools(root: string, budget: ReturnType<typeof createStepBudget>) {
  return async () => {
    const repository = await createRepositoryReader(root);
    return buildToolMap({
      list_files: createListFilesTool(repository, budget, noDebug()),
      read_file: createReadFileTool(repository, budget, noDebug()),
      search_code: createSearchCodeTool(repository, budget, noDebug()),
      search_docs: createSearchDocsTool(repository, budget, noDebug()),
    });
  };
}

describe('investigation loop', () => {
  test('uses documentation and code evidence together', async () => {
    const budget = createStepBudget(8);
    const tools = await (await buildTools(root, budget))();
    const plan: DecisionFn = async (state) => {
      if (state.iteration === 0)
        return { type: 'call', tool: 'search_docs', input: { query: 'authentication', path: '.', caseSensitive: false } };
      if (state.iteration === 1)
        return { type: 'call', tool: 'search_code', input: { query: 'login', path: '.', caseSensitive: false } };
      if (state.iteration === 2) {
        // Read the first docs match
        const docEv = state.evidence.find((e) => e.sourceType === 'documentation');
        if (docEv) return { type: 'call', tool: 'read_file', input: { path: docEv.filePath, startLine: 1 } };
      }
      if (state.iteration === 3) {
        // Read the first code match
        const codeEv = state.evidence.find((e) => e.sourceType === 'code');
        if (codeEv) return { type: 'call', tool: 'read_file', input: { path: codeEv.filePath, startLine: 1 } };
      }
      return { type: 'stop', reason: 'sufficient evidence' };
    };

    const result = await runInvestigation(
      'How does authentication work?',
      tools,
      budget,
      plan,
    );
    assert.ok(result.evidence.some((e) => e.sourceType === 'documentation'));
    assert.ok(result.evidence.some((e) => e.sourceType === 'code'));
    assert.equal(result.stopReason, 'sufficient evidence');
    assert.ok(result.answer.sources.length > 0);
    assert.match(result.answer.confidence, /High|Medium/);
  });

  test('repeated identical tool calls are blocked', async () => {
    const budget = createStepBudget(8);
    const tools = await (await buildTools(root, budget))();
    const plan: DecisionFn = async () => ({
      type: 'call',
      tool: 'search_code',
      input: { query: 'login', path: '.', caseSensitive: false },
    });

    const result = await runInvestigation(
      'Find auth',
      tools,
      budget,
      plan,
      { maxIterations: 5 },
    );
    // First call succeeds, subsequent ones are blocked as duplicates
    assert.ok(result.errors.some((e) => e.includes('Duplicate call blocked')));
    assert.equal(result.iterations, 5); // used all iterations since decider never stops
    assert.equal(budget.used, 1); // only first call consumed budget
  });

  test('loop stops at configured maximum', async () => {
    const budget = createStepBudget(8);
    const tools = await (await buildTools(root, budget))();
    let calls = 0;
    const plan: DecisionFn = async () => {
      calls += 1;
      return {
        type: 'call',
        tool: 'search_code',
        input: { query: `query${calls}`, path: '.', caseSensitive: false },
      };
    };

    const result = await runInvestigation(
      'Test',
      tools,
      budget,
      plan,
      { maxIterations: 3 },
    );
    assert.equal(result.iterations, 3);
    assert.equal(result.stopReason, 'max iterations reached');
  });

  test('stops early when sufficient evidence exists', async () => {
    const budget = createStepBudget(8);
    const tools = await (await buildTools(root, budget))();
    const plan: DecisionFn = async (state) => {
      if (state.iteration === 0)
        return { type: 'call', tool: 'read_file', input: { path: 'src/auth.ts', startLine: 1 } };
      return { type: 'stop', reason: 'sufficient evidence' };
    };

    const result = await runInvestigation(
      'How does auth work?',
      tools,
      budget,
      plan,
    );
    assert.equal(result.iterations, 1);
    assert.equal(result.stopReason, 'sufficient evidence');
    assert.ok(result.evidence.length > 0);
  });

  test('failed tool calls do not crash the loop', async () => {
    const budget = createStepBudget(8);
    const tools = await (await buildTools(root, budget))();
    const plan: DecisionFn = async (state) => {
      if (state.iteration === 0)
        return { type: 'call', tool: 'read_file', input: { path: 'nonexistent.ts', startLine: 1 } };
      if (state.iteration === 1)
        return { type: 'call', tool: 'read_file', input: { path: 'src/auth.ts', startLine: 1 } };
      return { type: 'stop', reason: 'done' };
    };

    const result = await runInvestigation(
      'How does auth work?',
      tools,
      budget,
      plan,
    );
    assert.ok(result.errors.length > 0);
    assert.ok(result.evidence.length > 0); // second call succeeded
    assert.equal(result.stopReason, 'done');
  });

  test('returns insufficient evidence instead of hallucinating', async () => {
    const budget = createStepBudget(8);
    const tools = await (await buildTools(root, budget))();
    const plan: DecisionFn = async (state) => {
      if (state.iteration === 0)
        return { type: 'call', tool: 'search_code', input: { query: 'payment_processing', path: '.', caseSensitive: false } };
      return { type: 'stop', reason: 'no evidence found' };
    };

    const result = await runInvestigation(
      'Where is payment processing implemented?',
      tools,
      budget,
      plan,
    );
    // Search returns 0 matches → no evidence extracted
    assert.equal(result.answer.insufficientEvidence, true);
    assert.equal(result.answer.confidence, 'Insufficient');
    // The answer must not claim payment processing was found or describe it
    assert.equal(result.answer.keyFindings.length, 0);
    assert.equal(result.answer.sources.length, 0);
    assert.match(result.answer.answer, /could not find sufficient evidence/i);
  });

  test('answers contain file citations', async () => {
    const budget = createStepBudget(8);
    const tools = await (await buildTools(root, budget))();
    const plan: DecisionFn = async (state) => {
      if (state.iteration === 0)
        return { type: 'call', tool: 'read_file', input: { path: 'src/config.ts', startLine: 1 } };
      return { type: 'stop', reason: 'done' };
    };

    const result = await runInvestigation(
      'How is the port configured?',
      tools,
      budget,
      plan,
    );
    assert.ok(result.answer.sources.some((s) => s.includes('src/config.ts')));
    assert.ok(result.answer.keyFindings.length > 0);
    assert.ok(
      result.answer.keyFindings.every((f) => f.citation.includes('src/config.ts')),
    );
  });

  test('confidence reflects available evidence', async () => {
    const budget = createStepBudget(8);
    const tools = await (await buildTools(root, budget))();

    // Only search leads, no reads → Low confidence
    const lowPlan: DecisionFn = async (state) => {
      if (state.iteration === 0)
        return { type: 'call', tool: 'search_code', input: { query: 'login', path: '.', caseSensitive: false } };
      return { type: 'stop', reason: 'done' };
    };
    const lowResult = await runInvestigation('auth', tools, budget, lowPlan);
    assert.equal(lowResult.answer.confidence, 'Low');

    // Reset budget for next test
    const budget2 = createStepBudget(8);
    const tools2 = await (await buildTools(root, budget2))();

    // Read from 2 files → High confidence
    const highPlan: DecisionFn = async (state) => {
      if (state.iteration === 0)
        return { type: 'call', tool: 'read_file', input: { path: 'src/auth.ts', startLine: 1 } };
      if (state.iteration === 1)
        return { type: 'call', tool: 'read_file', input: { path: 'src/config.ts', startLine: 1 } };
      return { type: 'stop', reason: 'done' };
    };
    const highResult = await runInvestigation('auth', tools2, budget2, highPlan);
    assert.equal(highResult.answer.confidence, 'High');
  });

  test('unknown tool is handled gracefully', async () => {
    const budget = createStepBudget(8);
    const tools = await (await buildTools(root, budget))();
    const plan: DecisionFn = async (state) => {
      if (state.iteration === 0)
        return { type: 'call', tool: 'nonexistent_tool', input: {} };
      return { type: 'stop', reason: 'done' };
    };

    const result = await runInvestigation('test', tools, budget, plan);
    assert.ok(result.errors.some((e) => e.includes('Unknown or unsupported tool')));
    assert.equal(result.answer.confidence, 'Insufficient');
  });

  test('budget exhaustion stops the loop', async () => {
    const budget = createStepBudget(1);
    const tools = await (await buildTools(root, budget))();
    const plan: DecisionFn = async (state) => {
      if (state.iteration === 0)
        return { type: 'call', tool: 'search_code', input: { query: 'a', path: '.', caseSensitive: false } };
      if (state.iteration === 1)
        return { type: 'call', tool: 'search_code', input: { query: 'b', path: '.', caseSensitive: false } };
      return { type: 'stop', reason: 'done' };
    };

    const result = await runInvestigation('test', tools, budget, plan);
    assert.equal(result.stopReason, 'budget exhausted');
    assert.equal(budget.used, 1);
  });

  test('DEFAULT_MAX_ITERATIONS is 5', () => {
    assert.equal(DEFAULT_MAX_ITERATIONS, 5);
  });
});
