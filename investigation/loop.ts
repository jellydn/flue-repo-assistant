import type { ToolDefinition } from '@flue/runtime';
import type { StepBudget } from '../tools/repository.ts';
import type {
  DecisionFn,
  InvestigationAction,
  InvestigationResult,
  InvestigationState,
} from './types.ts';
import { createCallTracker } from './call-tracker.ts';
import {
  createEvidenceCollector,
  extractEvidence,
  type EvidenceCollector,
} from './evidence.ts';
import { formatAnswer } from './answer.ts';

export const DEFAULT_MAX_ITERATIONS = 5;

export type InvestigationOptions = {
  maxIterations?: number;
};

/**
 * Run a bounded investigation loop.
 *
 * 1. Ask the {@link DecisionFn} for the next action (call a tool or stop).
 * 2. Block duplicate tool+input calls.
 * 3. Execute the tool, extract evidence, and record errors.
 * 4. Repeat until the decider says stop, the budget is exhausted, or
 *    {@link maxIterations} is reached.
 *
 * The loop is deterministic and testable: pass a mock {@link DecisionFn} to
 * simulate any tool sequence without an LLM. Failed tool calls become error
 * entries— they never crash the loop.
 */
export async function runInvestigation(
  question: string,
  tools: Map<string, ToolDefinition>,
  budget: StepBudget,
  decide: DecisionFn,
  options: InvestigationOptions = {},
): Promise<InvestigationResult> {
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const collector = createEvidenceCollector();
  const tracker = createCallTracker();
  const errors: string[] = [];
  const toolsUsed: string[] = [];
  let iteration = 0;
  let stopReason = '';

  while (iteration < maxIterations) {
    const state: InvestigationState = {
      question,
      iteration,
      maxIterations,
      evidence: collector.items,
      budget: budget.snapshot(),
      errors: [...errors],
      callHistory: tracker.history,
    };

    let action: InvestigationAction;
    try {
      action = await decide(state);
    } catch (error) {
      errors.push(
        `Decision function failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      stopReason = 'decision error';
      break;
    }

    if (action.type === 'stop') {
      stopReason = action.reason;
      break;
    }

    // Block duplicate calls
    if (tracker.has(action.tool, action.input)) {
      errors.push(
        `Duplicate call blocked: ${action.tool} with identical arguments`,
      );
      iteration += 1;
      continue;
    }

    // Check tool exists
    const tool = tools.get(action.tool);
    if (!tool) {
      errors.push(`Unknown or unsupported tool: ${action.tool}`);
      iteration += 1;
      continue;
    }

    // Check budget
    if (budget.remaining <= 0) {
      errors.push('Inspection budget exhausted');
      stopReason = 'budget exhausted';
      break;
    }

    // Record the call
    tracker.record({
      tool: action.tool,
      input: action.input,
      timestamp: Date.now(),
    });
    if (!toolsUsed.includes(action.tool)) toolsUsed.push(action.tool);

    // Execute and collect evidence
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await tool.run({ input: action.input as any });
      extractEvidence(action.tool, result, collector);
    } catch (error) {
      errors.push(
        `${action.tool} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    iteration += 1;
  }

  if (!stopReason) {
    stopReason =
      iteration >= maxIterations ? 'max iterations reached' : 'completed';
  }

  const answer = formatAnswer(question, collector.items, toolsUsed, errors);

  return {
    answer,
    iterations: iteration,
    evidence: collector.items,
    errors,
    toolsUsed,
    stopReason,
    callHistory: tracker.history,
  };
}

/** Convenience: build a tools map from a record of tool definitions. */
export function buildToolMap(
  ...toolLists: Array<Record<string, ToolDefinition>>
): Map<string, ToolDefinition> {
  const map = new Map<string, ToolDefinition>();
  for (const list of toolLists) {
    for (const [name, tool] of Object.entries(list)) {
      map.set(name, tool);
    }
  }
  return map;
}

/** Export collector type for external use. */
export type { EvidenceCollector };
