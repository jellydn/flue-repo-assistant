import type { InspectionMetadata } from '../tools/repository.ts';

/**
 * Structured evidence collected during a bounded investigation.
 * Each item is traceable to a specific file and line range, classified as
 * documentation or code, and optionally scored for relevance.
 */
export type EvidenceSourceType = 'documentation' | 'code';

export type Evidence = {
  filePath: string;
  lineStart?: number;
  lineEnd?: number;
  excerpt: string;
  sourceType: EvidenceSourceType;
  /** Higher is more relevant. Search matches default to 0.5, reads to 1.0. */
  relevance?: number;
};

/** A recorded tool call with its canonical input. */
export type ToolCall = {
  tool: string;
  input: Record<string, unknown>;
  timestamp: number;
};

/** Immutable snapshot of the investigation state passed to the decider. */
export type InvestigationState = {
  question: string;
  iteration: number;
  maxIterations: number;
  evidence: Evidence[];
  budget: InspectionMetadata;
  errors: string[];
  callHistory: ToolCall[];
};

/** The next action the loop should take, decided by the model or a mock. */
export type InvestigationAction =
  | { type: 'call'; tool: string; input: Record<string, unknown> }
  | { type: 'stop'; reason: string };

/**
 * Decision function: given the current state, choose the next tool call or
 * stop the investigation. In production this is the LLM; in tests it is a
 * deterministic mock.
 */
export type DecisionFn = (
  state: InvestigationState,
) => InvestigationAction | Promise<InvestigationAction>;

export type Confidence = 'High' | 'Medium' | 'Low' | 'Insufficient';

/** Grounded answer with citations and confidence level. */
export type GroundedAnswer = {
  answer: string;
  keyFindings: Array<{ finding: string; citation: string }>;
  sources: string[];
  confidence: Confidence;
  toolsUsed: string[];
  insufficientEvidence: boolean;
};

/** Result of a complete investigation run. */
export type InvestigationResult = {
  answer: GroundedAnswer;
  iterations: number;
  evidence: Evidence[];
  errors: string[];
  toolsUsed: string[];
  stopReason: string;
  callHistory: ToolCall[];
};
