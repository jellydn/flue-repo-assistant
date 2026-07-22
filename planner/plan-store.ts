import type { ExecutionResult, Plan, PlanReflection } from './types.ts';

/**
 * Mutable store holding the current plan, execution results, and reflection.
 * One instance is created per agent run and shared across the create_plan,
 * replan, and reflect_plan tools.
 */
export type PlanStore = {
  readonly plan: Plan | undefined;
  readonly results: ExecutionResult[];
  readonly reflection: PlanReflection | undefined;
  setPlan(plan: Plan): void;
  addResult(result: ExecutionResult): void;
  setReflection(reflection: PlanReflection): void;
  clear(): void;
};

export function createPlanStore(): PlanStore {
  let plan: Plan | undefined;
  let results: ExecutionResult[] = [];
  let reflection: PlanReflection | undefined;

  return {
    get plan() {
      return plan;
    },
    get results() {
      return results;
    },
    get reflection() {
      return reflection;
    },
    setPlan(next) {
      plan = next;
      results = [];
      reflection = undefined;
    },
    addResult(result) {
      results = [...results, result];
    },
    setReflection(next) {
      reflection = next;
    },
    clear() {
      plan = undefined;
      results = [];
      reflection = undefined;
    },
  };
}
