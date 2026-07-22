import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import type { DebugLogger, StepBudget } from '../tools/repository.ts';
import { summarizeInput } from '../tools/repository.ts';
import type { PlanStore } from './plan-store.ts';
import type { ExecutionResult, Plan, PlanReflection } from './types.ts';

/**
 * Compute a structured reflection over a completed plan and its results.
 *
 * `couldSimplify` and `simplificationNote` are model-provided judgments—this
 * function does not decide whether simplification is possible, it records the
 * outcome and counts the steps.
 */
export function reflectOnPlan(
  plan: Plan,
  results: ExecutionResult[],
  couldSimplify: boolean,
  simplificationNote = '',
): PlanReflection {
  return {
    totalSteps: plan.steps.length,
    executedSteps: results.length,
    successfulSteps: results.filter((r) => r.status === 'success').length,
    emptyResults: results.filter((r) => r.status === 'empty').length,
    failedSteps: results.filter((r) => r.status === 'error').length,
    skippedSteps: results.filter((r) => r.status === 'skipped').length,
    couldSimplify,
    simplificationNote,
  };
}

/** Render a reflection as a one-line summary for logs and debug output. */
export function formatReflection(reflection: PlanReflection): string {
  const parts = [
    `${reflection.executedSteps}/${reflection.totalSteps} executed`,
    `${reflection.successfulSteps} success`,
  ];
  if (reflection.emptyResults > 0) parts.push(`${reflection.emptyResults} empty`);
  if (reflection.failedSteps > 0) parts.push(`${reflection.failedSteps} failed`);
  if (reflection.skippedSteps > 0) parts.push(`${reflection.skippedSteps} skipped`);
  if (reflection.couldSimplify) parts.push('could-simplify');
  return parts.join(', ');
}

// ---------------------------------------------------------------------------
// Model-facing reflect_plan tool
// ---------------------------------------------------------------------------

export function createReflectPlanTool(
  store: PlanStore,
  budget: StepBudget,
  debug: DebugLogger,
) {
  return defineTool({
    name: 'reflect_plan',
    description:
      'Reflect on the completed plan. State whether any steps could be simplified or merged. Call this after all execution steps are done, before the final answer. Does not consume the inspection budget.',
    input: v.object({
      couldSimplify: v.boolean(),
      simplificationNote: v.optional(
        v.pipe(v.string(), v.maxLength(300)),
      ),
    }),
    run({ input }) {
      const plan = store.plan;
      const results = store.results;
      const inspection = budget.snapshot();

      if (!plan) {
        const inputSummary = summarizeInput({ couldSimplify: input.couldSimplify });
        debug.log({
          tool: 'reflect_plan',
          status: 'error',
          inputSummary,
          inspection,
        });
        return {
          error: 'No plan recorded. Call create_plan first.',
          reflection: null,
          summary: '',
          inspection,
        };
      }

      const reflection = reflectOnPlan(
        plan,
        results,
        input.couldSimplify,
        input.simplificationNote,
      );
      store.setReflection(reflection);
      const inputSummary = summarizeInput({
        couldSimplify: input.couldSimplify,
        steps: results.length,
      });
      debug.log({
        tool: 'reflect_plan',
        status: 'success',
        inputSummary,
        count: results.length,
        inspection,
      });
      return {
        error: null,
        reflection,
        summary: formatReflection(reflection),
        inspection,
      };
    },
  });
}
