import type { ToolCall } from './types.ts';

/**
 * Tracks tool calls by canonicalized tool name + sorted JSON input.
 * Used to block repeated identical calls during an investigation.
 */
export type CallTracker = {
  has(tool: string, input: Record<string, unknown>): boolean;
  record(call: ToolCall): boolean;
  readonly count: number;
  readonly history: ToolCall[];
};

function canonicalize(tool: string, input: Record<string, unknown>): string {
  const sortedKeys = Object.keys(input).sort();
  const sortedInput = sortedKeys.map((k) => [k, input[k]]);
  return `${tool}:${JSON.stringify(sortedInput)}`;
}

export function createCallTracker(): CallTracker {
  const calls = new Map<string, ToolCall>();

  return {
    has(tool, input) {
      return calls.has(canonicalize(tool, input));
    },
    record(call) {
      const key = canonicalize(call.tool, call.input);
      if (calls.has(key)) return false;
      calls.set(key, call);
      return true;
    },
    get count() {
      return calls.size;
    },
    get history() {
      return Array.from(calls.values());
    },
  };
}
