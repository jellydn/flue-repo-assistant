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
import { createPlanStore } from '../planner/plan-store.ts';
import { createPlan, createPlanTool, normalizePlan } from '../planner/planner.ts';
import {
  createReplanTool,
  executePlan,
  isEmptyResult,
  replan,
  shouldReplan,
} from '../planner/executor.ts';
import {
  createReflectPlanTool,
  formatReflection,
  reflectOnPlan,
} from '../planner/reflection.ts';
import type { ExecutionResult, Plan, PlanReflection, PlanStep } from '../planner/types.ts';
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
// Programmatic planner
// ---------------------------------------------------------------------------

describe('createPlan (programmatic)', () => {
  test('conceptual question produces a single answer step', () => {
    const plan = createPlan('What is the difference between listing and searching?');
    assert.equal(plan.steps.length, 1);
    assert.equal(plan.steps[0].tool, 'answer');
  });

  test('specific file path produces a read then answer plan', () => {
    const plan = createPlan('Read src/config.ts and explain the port.');
    assert.equal(plan.steps.length, 2);
    assert.equal(plan.steps[0].tool, 'read_file');
    assert.equal(plan.steps[0].input?.path, 'src/config.ts');
    assert.equal(plan.steps[1].tool, 'answer');
  });

  test('overview question produces list → read → answer', () => {
    const plan = createPlan('Give me a high-level overview of this repository.');
    assert.equal(plan.steps.length, 3);
    assert.equal(plan.steps[0].tool, 'list_files');
    assert.equal(plan.steps[1].tool, 'read_file');
    assert.equal(plan.steps[2].tool, 'answer');
  });

  test('default question produces search → read → read → answer', () => {
    const plan = createPlan('Find where user authentication is implemented.');
    assert.ok(plan.steps.length >= 3);
    assert.equal(plan.steps[0].tool, 'search_code');
    assert.equal(plan.steps[plan.steps.length - 1].tool, 'answer');
  });

  test('all steps have sequential ids', () => {
    const plan = createPlan('Find where auth is implemented.');
    const ids = plan.steps.map((s) => s.id);
    assert.deepEqual(ids, ids.map((_, i) => i + 1));
  });
});

describe('normalizePlan', () => {
  test('assigns sequential ids and preserves step data', () => {
    const plan = normalizePlan('test question', [
      { description: 'step one', tool: 'search_code', input: { query: 'auth' } },
      { description: 'step two', tool: 'answer' },
    ]);
    assert.equal(plan.question, 'test question');
    assert.equal(plan.steps[0].id, 1);
    assert.equal(plan.steps[1].id, 2);
    assert.equal(plan.steps[0].description, 'step one');
    assert.equal(plan.steps[1].tool, 'answer');
  });
});

// ---------------------------------------------------------------------------
// Programmatic executor
// ---------------------------------------------------------------------------

describe('executePlan', () => {
  test('executes a search → read plan against the fixture repo', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(8);
    const debug = noDebug();
    const tools: Partial<Record<string, ToolDefinition>> = {
      search_code: createSearchCodeTool(repository, budget, debug),
      read_file: createReadFileTool(repository, budget, debug),
    };
    const plan = normalizePlan('Find auth', [
      { description: 'Search for auth', tool: 'search_code', input: { query: 'login', path: '.', caseSensitive: false } },
      { description: 'Read auth file', tool: 'read_file', input: { path: 'src/auth.ts', startLine: 1 } },
      { description: 'Answer', tool: 'answer' },
    ]);
    const results = await executePlan(plan, tools, budget, debug);
    assert.equal(results.length, 3);
    assert.equal(results[0].status, 'success');
    assert.match(results[0].summary, /matches/);
    assert.equal(results[1].status, 'success');
    assert.match(results[1].summary, /lines read/);
    assert.equal(results[2].status, 'success');
    assert.equal(results[2].tool, 'answer');
    assert.equal(budget.used, 2);
  });

  test('skips steps without concrete input', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(8);
    const tools: Partial<Record<string, ToolDefinition>> = {
      read_file: createReadFileTool(repository, budget, noDebug()),
    };
    const plan = normalizePlan('Read a file', [
      { description: 'Read some file', tool: 'read_file' },
      { description: 'Answer', tool: 'answer' },
    ]);
    const results = await executePlan(plan, tools, budget, noDebug());
    assert.equal(results[0].status, 'skipped');
    assert.equal(results[1].status, 'success');
    assert.equal(budget.used, 0);
  });

  test('marks empty search results as empty', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(8);
    const tools: Partial<Record<string, ToolDefinition>> = {
      search_code: createSearchCodeTool(repository, budget, noDebug()),
    };
    const plan = normalizePlan('Find nonexistent', [
      { description: 'Search for nothing', tool: 'search_code', input: { query: 'doesnotexistxyz', path: '.', caseSensitive: false } },
      { description: 'Answer', tool: 'answer' },
    ]);
    const results = await executePlan(plan, tools, budget, noDebug());
    assert.equal(results[0].status, 'empty');
    assert.match(results[0].summary, /0 matches/);
  });

  test('answer step terminates execution and produces no tool call', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(8);
    const tools: Partial<Record<string, ToolDefinition>> = {
      search_code: createSearchCodeTool(repository, budget, noDebug()),
    };
    const plan = normalizePlan('conceptual', [
      { description: 'Answer directly', tool: 'answer' },
      { description: 'This should not run', tool: 'search_code', input: { query: 'x', path: '.', caseSensitive: false } },
    ]);
    const results = await executePlan(plan, tools, budget, noDebug());
    assert.equal(results.length, 1);
    assert.equal(results[0].tool, 'answer');
    assert.equal(budget.used, 0);
  });
});

// ---------------------------------------------------------------------------
// Replanning
// ---------------------------------------------------------------------------

describe('replanning', () => {
  test('shouldReplan returns true when a search step is empty', () => {
    const results: ExecutionResult[] = [
      { stepId: 1, status: 'empty', tool: 'search_code', summary: '0 matches' },
    ];
    assert.equal(shouldReplan(results), true);
  });

  test('shouldReplan returns false when all steps succeed', () => {
    const results: ExecutionResult[] = [
      { stepId: 1, status: 'success', tool: 'search_code', summary: '3 matches' },
    ];
    assert.equal(shouldReplan(results), false);
  });

  test('replan replaces empty search with list_files', () => {
    const original = normalizePlan('Find X', [
      { description: 'Search for X', tool: 'search_code', input: { query: 'X', path: '.', caseSensitive: false } },
      { description: 'Read result', tool: 'read_file' },
      { description: 'Answer', tool: 'answer' },
    ]);
    const results: ExecutionResult[] = [
      { stepId: 1, status: 'empty', tool: 'search_code', summary: '0 matches' },
    ];
    const revised = replan(original, results);
    assert.equal(revised.steps[0].tool, 'list_files');
    assert.equal(revised.steps[revised.steps.length - 1].tool, 'answer');
    // Original read_file step is preserved
    assert.ok(revised.steps.some((s) => s.tool === 'read_file'));
  });

  test('replanned plan can execute successfully', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(8);
    const debug = noDebug();
    const tools: Partial<Record<string, ToolDefinition>> = {
      search_code: createSearchCodeTool(repository, budget, debug),
      list_files: createListFilesTool(repository, budget, debug),
      read_file: createReadFileTool(repository, budget, debug),
    };
    const original = normalizePlan('Find nonexistent', [
      { description: 'Search for nothing', tool: 'search_code', input: { query: 'doesnotexistxyz', path: '.', caseSensitive: false } },
      { description: 'Answer', tool: 'answer' },
    ]);
    const firstResults = await executePlan(original, tools, budget, debug);
    assert.equal(shouldReplan(firstResults), true);
    const revised = replan(original, firstResults);
    const revisedResults = await executePlan(revised, tools, budget, debug);
    assert.ok(revisedResults.some((r) => r.status === 'success'));
  });
});

// ---------------------------------------------------------------------------
// Reflection
// ---------------------------------------------------------------------------

describe('reflection', () => {
  test('reflectOnPlan counts statuses correctly', () => {
    const plan = normalizePlan('test', [
      { description: 'a', tool: 'search_code' },
      { description: 'b', tool: 'read_file' },
      { description: 'c', tool: 'answer' },
    ]);
    const results: ExecutionResult[] = [
      { stepId: 1, status: 'success', tool: 'search_code', summary: '3 matches' },
      { stepId: 2, status: 'empty', tool: 'read_file', summary: 'no file' },
    ];
    const reflection = reflectOnPlan(plan, results, true, 'Steps 1 and 2 could be merged');
    assert.equal(reflection.totalSteps, 3);
    assert.equal(reflection.executedSteps, 2);
    assert.equal(reflection.successfulSteps, 1);
    assert.equal(reflection.emptyResults, 1);
    assert.equal(reflection.couldSimplify, true);
    assert.equal(reflection.simplificationNote, 'Steps 1 and 2 could be merged');
  });

  test('formatReflection produces a readable summary', () => {
    const reflection = reflectOnPlan(
      normalizePlan('t', [{ description: 'a', tool: 'answer' }]),
      [{ stepId: 1, status: 'success', tool: 'search_code', summary: 'ok' }],
      false,
    );
    const text = formatReflection(reflection);
    assert.match(text, /1\/1 executed/);
    assert.match(text, /1 success/);
  });
});

// ---------------------------------------------------------------------------
// Plan store
// ---------------------------------------------------------------------------

describe('PlanStore', () => {
  test('setPlan resets results and reflection', () => {
    const store = createPlanStore();
    const plan1 = normalizePlan('q1', [{ description: 'a', tool: 'answer' }]);
    store.setPlan(plan1);
    store.addResult({ stepId: 1, status: 'success', tool: 'answer', summary: 'ok' });
    store.setReflection(reflectOnPlan(plan1, store.results, false));
    assert.equal(store.results.length, 1);
    assert.ok(store.reflection);

    const plan2 = normalizePlan('q2', [{ description: 'b', tool: 'answer' }]);
    store.setPlan(plan2);
    assert.equal(store.results.length, 0);
    assert.equal(store.reflection, undefined);
    assert.equal(store.plan?.question, 'q2');
  });
});

// ---------------------------------------------------------------------------
// Model-facing tools
// ---------------------------------------------------------------------------

describe('create_plan tool', () => {
  test('stores the plan and returns confirmation', async () => {
    const store = createPlanStore();
    const budget = createStepBudget(8);
    const tool = createPlanTool(store, budget, noDebug());
    const result = await tool.run({
      input: {
        question: 'How does auth work?',
        steps: [
          { description: 'Search for auth', tool: 'search_code', input: { query: 'auth' } },
          { description: 'Read the auth file', tool: 'read_file' },
          { description: 'Answer', tool: 'answer' },
        ],
      },
    }) as { plan: Plan; message: string; inspection: InspectionMetadata };
    assert.ok(store.plan);
    assert.equal(store.plan.question, 'How does auth work?');
    assert.equal(store.plan.steps.length, 3);
    assert.equal(result.plan.steps.length, 3);
    assert.match(result.message, /3 steps/);
    // Does not consume inspection budget
    assert.equal(budget.used, 0);
  });
});

describe('replan tool', () => {
  test('replaces the plan and preserves previous result count', async () => {
    const store = createPlanStore();
    const budget = createStepBudget(8);
    const planTool = createPlanTool(store, budget, noDebug());
    const replanTool = createReplanTool(store, budget, noDebug());

    await planTool.run({
      input: {
        question: 'Find X',
        steps: [
          { description: 'Search for X', tool: 'search_code', input: { query: 'X' } },
          { description: 'Answer', tool: 'answer' },
        ],
      },
    });
    store.addResult({ stepId: 1, status: 'empty', tool: 'search_code', summary: '0 matches' });

    const result = await replanTool.run({
      input: {
        reason: 'Search returned no results',
        steps: [
          { description: 'List files', tool: 'list_files', input: { path: '.' } },
          { description: 'Answer', tool: 'answer' },
        ],
      },
    }) as { plan: Plan; previousResultCount: number; message: string; inspection: InspectionMetadata };
    assert.equal(result.plan.steps.length, 2);
    assert.equal(result.plan.steps[0].tool, 'list_files');
    assert.equal(result.previousResultCount, 1);
    assert.equal(budget.used, 0);
  });
});

describe('reflect_plan tool', () => {
  test('records reflection when a plan exists', async () => {
    const store = createPlanStore();
    const budget = createStepBudget(8);
    const planTool = createPlanTool(store, budget, noDebug());
    const reflectTool = createReflectPlanTool(store, budget, noDebug());

    await planTool.run({
      input: {
        question: 'Test',
        steps: [
          { description: 'Search', tool: 'search_code', input: { query: 'x' } },
          { description: 'Answer', tool: 'answer' },
        ],
      },
    });
    store.addResult({ stepId: 1, status: 'success', tool: 'search_code', summary: '2 matches' });

    const result = await reflectTool.run({
      input: { couldSimplify: true, simplificationNote: 'Could merge steps' },
    }) as { error: string | null; reflection: PlanReflection | null; summary: string; inspection: InspectionMetadata };
    assert.equal(result.error, null);
    assert.ok(result.reflection);
    assert.equal(result.reflection.totalSteps, 2);
    assert.equal(result.reflection.executedSteps, 1);
    assert.equal(result.reflection.couldSimplify, true);
    assert.ok(store.reflection);
    assert.equal(budget.used, 0);
  });

  test('returns error when no plan exists', async () => {
    const store = createPlanStore();
    const budget = createStepBudget(8);
    const reflectTool = createReflectPlanTool(store, budget, noDebug());
    const result = await reflectTool.run({
      input: { couldSimplify: false, simplificationNote: '' },
    }) as { error: string | null; reflection: null; summary: string; inspection: InspectionMetadata };
    assert.ok(result.error);
    assert.equal(result.reflection, null);
  });
});

// ---------------------------------------------------------------------------
// Integration: plan → execute → reflect
// ---------------------------------------------------------------------------

describe('full plan-execute-reflect cycle', () => {
  test('search → read → reflect against fixture repo', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(8);
    const debug = noDebug();
    const store = createPlanStore();

    // Tools for execution
    const tools: Partial<Record<string, ToolDefinition>> = {
      search_code: createSearchCodeTool(repository, budget, debug),
      read_file: createReadFileTool(repository, budget, debug),
    };

    // Plan
    const planTool = createPlanTool(store, budget, debug);
    await planTool.run({
      input: {
        question: 'Find where user authentication is implemented and explain the flow.',
        steps: [
          { description: 'Search for auth code', tool: 'search_code', input: { query: 'login', path: '.', caseSensitive: false } },
          { description: 'Read the auth file', tool: 'read_file', input: { path: 'src/auth.ts', startLine: 1 } },
          { description: 'Answer', tool: 'answer' },
        ],
      },
    });
    assert.ok(store.plan);

    // Execute
    const results = await executePlan(store.plan, tools, budget, debug);
    for (const r of results) store.addResult(r);
    assert.equal(budget.used, 2);
    assert.ok(results.some((r) => r.status === 'success'));

    // Reflect
    const reflectTool = createReflectPlanTool(store, budget, debug);
    const reflectResult = await reflectTool.run({
      input: { couldSimplify: false, simplificationNote: '' },
    }) as { error: string | null; reflection: PlanReflection | null; summary: string; inspection: InspectionMetadata };
    assert.equal(reflectResult.error, null);
    assert.equal(reflectResult.reflection?.executedSteps, 3);
    assert.equal(reflectResult.reflection?.successfulSteps, 3);
    assert.equal(reflectResult.reflection?.emptyResults, 0);
  });

  test('empty search triggers replan, then succeeds', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(8);
    const debug = noDebug();
    const store = createPlanStore();

    const tools: Partial<Record<string, ToolDefinition>> = {
      search_code: createSearchCodeTool(repository, budget, debug),
      list_files: createListFilesTool(repository, budget, debug),
      read_file: createReadFileTool(repository, budget, debug),
    };

    // Plan with a query that won't match
    const planTool = createPlanTool(store, budget, debug);
    await planTool.run({
      input: {
        question: 'Find payment processing.',
        steps: [
          { description: 'Search for payment', tool: 'search_code', input: { query: 'payment_processor', path: '.', caseSensitive: false } },
          { description: 'Answer', tool: 'answer' },
        ],
      },
    });

    // Execute
    const firstResults = await executePlan(store.plan!, tools, budget, debug);
    for (const r of firstResults) store.addResult(r);
    assert.equal(shouldReplan(firstResults), true);

    // Replan
    const replanTool = createReplanTool(store, budget, debug);
    await replanTool.run({
      input: {
        reason: 'No payment_processor matches; trying broader search',
        steps: [
          { description: 'Search for payment', tool: 'search_code', input: { query: 'payment', path: '.', caseSensitive: false } },
          { description: 'Read the matching file', tool: 'read_file', input: { path: 'src/utils/notes.md', startLine: 1 } },
          { description: 'Answer: no payment implementation found', tool: 'answer' },
        ],
      },
    });

    // Execute revised plan
    const revisedResults = await executePlan(store.plan!, tools, budget, debug);
    assert.ok(revisedResults.some((r) => r.status === 'success'));
    assert.ok(budget.used > 0);
  });
});

// ---------------------------------------------------------------------------
// Debug logging for plan tools
// ---------------------------------------------------------------------------

describe('plan tool debug logging', () => {
  test('create_plan logs plan metadata without consuming budget', async () => {
    const store = createPlanStore();
    const budget = createStepBudget(8);
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => lines.push(args.join(' '));
    try {
      const tool = createPlanTool(store, budget, createDebugLogger(true));
      await tool.run({
        input: {
          question: 'Test',
          steps: [{ description: 'Answer', tool: 'answer' }],
        },
      });
    } finally {
      console.error = original;
    }
    const line = lines.join('\n');
    assert.match(line, /create_plan success/);
    assert.match(line, /used=0 remaining=8\/8/);
    // No absolute paths
    assert.doesNotMatch(line, /\/tmp\//);
  });
});
