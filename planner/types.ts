/**
 * Types for the planning-vs-execution layer.
 *
 * The planner produces a structured {@link Plan} of 3–5 {@link PlanStep}s
 * before any inspection tool is called. The executor runs each step against
 * the existing read-only tools, collects {@link ExecutionResult}s, and
 * optionally triggers replanning when a step yields no evidence.
 */

/** Tools a plan step can target. `answer` is a no-op terminal step. */
export type PlanTool = 'list_files' | 'read_file' | 'search_code' | 'answer';

/** JSON-compatible tool input fields. */
export type PlanInput = Record<string, string | number | boolean | null>;

export type PlanStep = {
  id: number;
  description: string;
  tool: PlanTool;
  /** Tool input fields, filled when known at planning time. */
  input?: PlanInput;
};

export type Plan = {
  question: string;
  steps: PlanStep[];
  createdAt: number;
};

export type ExecutionStatus = 'success' | 'error' | 'skipped' | 'empty';

export type ExecutionResult = {
  stepId: number;
  status: ExecutionStatus;
  tool: PlanTool;
  /** One-line human-readable summary for logging and reflection. */
  summary: string;
  /** Raw tool output (success only, omitted for skipped/empty/error). */
  output?: unknown;
};

export type PlanReflection = {
  totalSteps: number;
  executedSteps: number;
  successfulSteps: number;
  emptyResults: number;
  failedSteps: number;
  skippedSteps: number;
  couldSimplify: boolean;
  simplificationNote: string;
};

/** Input shape for the model-facing create_plan / replan tools. */
export type PlanStepInput = {
  description: string;
  tool: PlanTool;
  input?: PlanInput;
};
