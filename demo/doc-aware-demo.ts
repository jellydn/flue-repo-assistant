/**
 * Day 21 demo: doc-aware repository agent.
 *
 * Runs the bounded investigation loop against the bundled fixture repository
 * with deterministic decision functions (no LLM required). Shows how the agent
 * combines search_docs, search_code, and read_file to produce grounded answers
 * with citations and confidence.
 *
 * Run with:
 *   npx tsx demo/doc-aware-demo.ts
 *   npx tsx demo/doc-aware-demo.ts auth    # only the auth scenario
 *   npx tsx demo/doc-aware-demo.ts payment # only the negative search
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDebugLogger,
  createRepositoryReader,
  createStepBudget,
} from '../tools/repository.ts';
import { createListFilesTool } from '../tools/list-files.ts';
import { createReadFileTool } from '../tools/read-file.ts';
import { createSearchCodeTool } from '../tools/search-code.ts';
import { createSearchDocsTool } from '../tools/search-docs.ts';
import { buildToolMap, runInvestigation } from '../investigation/loop.ts';
import type { DecisionFn, InvestigationResult } from '../investigation/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(__dirname, '..', 'eval', 'fixtures', 'sample-repo');

type Scenario = {
  name: string;
  question: string;
  decide: DecisionFn;
};

const scenarios: Scenario[] = [
  {
    name: 'Authentication flow (docs + code)',
    question: 'How does authentication work in this repository?',
    decide: async (state) => {
      if (state.iteration === 0)
        return { type: 'call', tool: 'search_docs', input: { query: 'authentication', path: '.', caseSensitive: false } };
      if (state.iteration === 1)
        return { type: 'call', tool: 'search_code', input: { query: 'login', path: '.', caseSensitive: false } };
      if (state.iteration === 2) {
        const docEv = state.evidence.find((e) => e.sourceType === 'documentation');
        if (docEv) return { type: 'call', tool: 'read_file', input: { path: docEv.filePath, startLine: 1 } };
      }
      if (state.iteration === 3) {
        const codeEv = state.evidence.find((e) => e.sourceType === 'code' && e.filePath.endsWith('.ts'));
        if (codeEv) return { type: 'call', tool: 'read_file', input: { path: codeEv.filePath, startLine: 1 } };
      }
      return { type: 'stop', reason: 'sufficient evidence collected' };
    },
  },
  {
    name: 'Database initialization (negative search)',
    question: 'Where is the database initialized?',
    decide: async (state) => {
      if (state.iteration === 0)
        return { type: 'call', tool: 'search_docs', input: { query: 'database', path: '.', caseSensitive: false } };
      if (state.iteration === 1)
        return { type: 'call', tool: 'search_code', input: { query: 'database', path: '.', caseSensitive: false } };
      return { type: 'stop', reason: 'no evidence found' };
    },
  },
  {
    name: 'Environment variables (docs search)',
    question: 'Which environment variables are required?',
    decide: async (state) => {
      if (state.iteration === 0)
        return { type: 'call', tool: 'search_docs', input: { query: 'environment variable', path: '.', caseSensitive: false } };
      if (state.iteration === 1)
        return { type: 'call', tool: 'search_code', input: { query: 'process.env', path: '.', caseSensitive: true } };
      if (state.iteration === 2) {
        const docEv = state.evidence.find((e) => e.sourceType === 'documentation');
        if (docEv) return { type: 'call', tool: 'read_file', input: { path: docEv.filePath, startLine: 1 } };
      }
      if (state.iteration === 3) {
        const codeEv = state.evidence.find((e) => e.sourceType === 'code');
        if (codeEv) return { type: 'call', tool: 'read_file', input: { path: codeEv.filePath, startLine: 1 } };
      }
      return { type: 'stop', reason: 'sufficient evidence' };
    },
  },
  {
    name: 'Repository architecture overview',
    question: 'Summarize the repository architecture.',
    decide: async (state) => {
      if (state.iteration === 0)
        return { type: 'call', tool: 'search_docs', input: { query: 'architecture', path: '.', caseSensitive: false } };
      if (state.iteration === 1)
        return { type: 'call', tool: 'list_files', input: { path: '.', depth: 3 } };
      if (state.iteration === 2) {
        const docEv = state.evidence.find((e) => e.filePath === 'docs/architecture.md');
        if (docEv) return { type: 'call', tool: 'read_file', input: { path: 'docs/architecture.md', startLine: 1 } };
      }
      return { type: 'stop', reason: 'sufficient evidence' };
    },
  },
  {
    name: 'Payment processing (negative — do not hallucinate)',
    question: 'Where is payment processing implemented?',
    decide: async (state) => {
      if (state.iteration === 0)
        return { type: 'call', tool: 'search_code', input: { query: 'payment', path: '.', caseSensitive: false } };
      if (state.iteration === 1) {
        // Check if any source code matched (not just misleading notes)
        const codeMatches = state.evidence.filter(
          (e) => e.sourceType === 'code' && !e.filePath.endsWith('.md'),
        );
        if (codeMatches.length === 0) return { type: 'stop', reason: 'no payment implementation found' };
      }
      return { type: 'stop', reason: 'investigated' };
    },
  },
];

function printResult(question: string, result: InvestigationResult): void {
  console.log('  Question:    ', question);
  console.log('  Tools used:  ', result.toolsUsed.join(' → '));
  console.log('  Iterations:  ', `${result.iterations}/${DEFAULT_MAX_ITERATIONS}`);
  console.log('  Stop reason: ', result.stopReason);
  console.log('  Cited files: ', result.answer.sources.length > 0
    ? result.answer.sources.join(', ')
    : '(none)');
  console.log('  Confidence:  ', result.answer.confidence);
  console.log('  Success:     ', !result.answer.insufficientEvidence);
  if (result.errors.length > 0) {
    console.log('  Errors:      ', result.errors.length, 'error(s)');
  }
  console.log('  Answer:');
  console.log('    ', result.answer.answer.split('\n').join('\n     '));
  console.log();
}

const DEFAULT_MAX_ITERATIONS = 5;
const filter = process.argv[2];

async function main() {
  const repository = await createRepositoryReader(fixture);
  const debug = createDebugLogger(false);

  for (const scenario of scenarios) {
    if (filter && !scenario.name.toLowerCase().includes(filter.toLowerCase())) continue;

    const budget = createStepBudget(8);
    const tools = buildToolMap({
      list_files: createListFilesTool(repository, budget, debug),
      read_file: createReadFileTool(repository, budget, debug),
      search_code: createSearchCodeTool(repository, budget, debug),
      search_docs: createSearchDocsTool(repository, budget, debug),
    });

    console.log('============================================================');
    console.log(`Scenario: ${scenario.name}`);
    console.log('------------------------------------------------------------');

    const result = await runInvestigation(
      scenario.question,
      tools,
      budget,
      scenario.decide,
    );
    printResult(scenario.question, result);
  }

  console.log('============================================================');
  console.log('Demo complete. All scenarios used deterministic decision functions');
  console.log('(no LLM required). Run with REPO_ASSISTANT_DEBUG=true for tool logs.');
}

main().catch((err) => {
  console.error('Demo failed:', err);
  process.exit(1);
});
