import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import type { DebugLogger, StepBudget } from '../tools/repository.ts';
import { summarizeInput } from '../tools/repository.ts';
import type { PlanStore } from './plan-store.ts';
import type { Plan, PlanInput, PlanStep, PlanStepInput, PlanTool } from './types.ts';

/**
 * Normalize model-provided step inputs into a {@link Plan} with sequential ids.
 */
export function normalizePlan(
  question: string,
  stepInputs: PlanStepInput[],
): Plan {
  const steps: PlanStep[] = stepInputs.map((step, index) => ({
    id: index + 1,
    description: step.description,
    tool: step.tool,
    input: step.input,
  }));
  return { question, steps, createdAt: Date.now() };
}

/**
 * Deterministic, rule-based planner for testing and demonstration.
 *
 * Maps common question patterns to 3–5 step plans. This is NOT a substitute
 * for LLM planning—it shows the contract the model-facing create_plan tool
 * expects and lets tests run without a provider key.
 */
export function createPlan(question: string): Plan {
  const lower = question.toLowerCase();

  if (isConceptual(lower)) {
    return normalizePlan(question, [
      {
        description: 'Answer the conceptual question directly from instructions',
        tool: 'answer',
      },
    ]);
  }

  const filePath = extractFilePath(question);
  if (filePath) {
    return normalizePlan(question, [
      {
        description: `Read ${filePath}`,
        tool: 'read_file',
        input: { path: filePath, startLine: 1 },
      },
      { description: 'Summarize the findings', tool: 'answer' },
    ]);
  }

  if (asksForOverview(lower)) {
    return normalizePlan(question, [
      {
        description: 'Search documentation for architecture and overview',
        tool: 'search_docs',
        input: { query: 'architecture', path: '.', caseSensitive: false },
      },
      {
        description: 'List repository structure to identify key files',
        tool: 'list_files',
        input: { path: '.', depth: 2 },
      },
      {
        description: 'Read the entry point file',
        tool: 'read_file',
      },
      { description: 'Summarize the architecture', tool: 'answer' },
    ]);
  }

  // Documentation-leaning questions: how/what/why about configuration,
  // deployment, environment, etc.
  if (asksAboutDocs(lower)) {
    const query = extractSearchQuery(question);
    return normalizePlan(question, [
      {
        description: `Search documentation for "${query}"`,
        tool: 'search_docs',
        input: { query, path: '.', caseSensitive: false },
      },
      {
        description: `Search source code for "${query}"`,
        tool: 'search_code',
        input: { query, path: '.', caseSensitive: false },
      },
      {
        description: 'Read the most relevant documentation file',
        tool: 'read_file',
      },
      {
        description: 'Read the most relevant source file',
        tool: 'read_file',
      },
      { description: 'Summarize the findings with citations', tool: 'answer' },
    ]);
  }

  // Default: search then read (the most common pattern).
  const query = extractSearchQuery(question);
  return normalizePlan(question, [
    {
      description: `Search for "${query}" to locate relevant files`,
      tool: 'search_code',
      input: { query, path: '.', caseSensitive: false },
    },
    {
      description: 'Read the most relevant matching file',
      tool: 'read_file',
    },
    {
      description: 'Trace related imports or callers if needed',
      tool: 'read_file',
    },
    { description: 'Summarize the findings and answer', tool: 'answer' },
  ]);
}

const CONCEPTUAL_MARKERS = [
  'difference between',
  'what is',
  'how does',
  'explain the concept',
  'vs',
  'versus',
];

function isConceptual(lower: string): boolean {
  return CONCEPTUAL_MARKERS.some((marker) => lower.includes(marker));
}

function extractFilePath(question: string): string | undefined {
  // Match paths like src/config.ts or ./src/foo.ts or package.json
  const match = question.match(/(?:^|\s)(\.?\/?[\w-]+(?:\/[\w.-]+)+)/);
  return match?.[1];
}

function asksForOverview(lower: string): boolean {
  return (
    lower.includes('overview') ||
    lower.includes('architecture') ||
    lower.includes('high-level') ||
    lower.includes('structure of')
  );
}

const DOC_QUESTION_MARKERS = [
  'how is',
  'how does',
  'how are',
  'what is',
  'which environment',
  'environment variable',
  'deployment',
  'configured',
  'configuration',
  'documented',
  'documentation',
  'external service',
  'api endpoint',
  'background job',
];

function asksAboutDocs(lower: string): boolean {
  return DOC_QUESTION_MARKERS.some((marker) => lower.includes(marker));
}

function extractSearchQuery(question: string): string {
  // Strip common question words and use the remainder as the query.
  const cleaned = question
    .replace(/^(how|where|what|which|find|explain|show|tell me)\b/i, '')
    .replace(/\b(is|are|the|in|implemented|works?|done|used)\b/gi, '')
    .replace(/\?/g, '')
    .trim();
  const words = cleaned.split(/\s+/).filter((w) => w.length > 1);
  return words.slice(0, 3).join(' ') || 'main';
}

// ---------------------------------------------------------------------------
// Model-facing create_plan tool
// ---------------------------------------------------------------------------

const planStepSchema = v.object({
  description: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  tool: v.picklist(['list_files', 'read_file', 'search_code', 'search_docs', 'answer']),
  input: v.optional(v.record(v.string(), v.union([v.string(), v.number(), v.boolean(), v.null()]))),
});

export function createPlanTool(
  store: PlanStore,
  budget: StepBudget,
  debug: DebugLogger,
) {
  return defineTool({
    name: 'create_plan',
    description:
      'Declare a 3–5 step execution plan before calling any inspection tool. Each step names a tool (list_files, read_file, search_code, or answer) and describes its goal. Call this first, then execute each step with the corresponding tool. Does not consume the inspection budget.',
    input: v.object({
      question: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
      steps: v.pipe(
        v.array(planStepSchema),
        v.minLength(1),
        v.maxLength(10),
      ),
    }),
    run({ input }) {
      const plan = normalizePlan(input.question, input.steps);
      store.setPlan(plan);
      const inspection = budget.snapshot();
      const inputSummary = summarizeInput({
        question: input.question,
        stepCount: input.steps.length,
      });
      debug.log({
        tool: 'create_plan',
        status: 'success',
        inputSummary,
        count: plan.steps.length,
        inspection,
      });
      return {
        plan,
        message: `Plan with ${plan.steps.length} steps recorded. Execute each step using the corresponding tool, then call reflect_plan.`,
        inspection,
      };
    },
  });
}
