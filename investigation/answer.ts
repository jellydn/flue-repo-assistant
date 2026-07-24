import type { Confidence, Evidence, GroundedAnswer } from './types.ts';

/** Format a single evidence item as a file:line-range citation. */
export function formatCitation(e: Evidence): string {
  if (
    e.lineStart !== undefined &&
    e.lineEnd !== undefined &&
    e.lineStart !== e.lineEnd
  ) {
    return `${e.filePath}:${e.lineStart}-${e.lineEnd}`;
  }
  if (e.lineStart !== undefined) {
    return `${e.filePath}:${e.lineStart}`;
  }
  return e.filePath;
}

/**
 * Calculate confidence from the collected evidence.
 *
 * - Insufficient: no evidence at all.
 * - Low: only search matches (leads) without supporting file reads.
 * - Medium: at least one read providing context, but from a single file.
 * - High: reads from 2+ files, or both documentation and code corroboration.
 */
export function calculateConfidence(evidence: Evidence[]): Confidence {
  if (evidence.length === 0) return 'Insufficient';

  const hasDocs = evidence.some((e) => e.sourceType === 'documentation');
  const hasCode = evidence.some((e) => e.sourceType === 'code');
  const files = new Set(evidence.map((e) => e.filePath));
  const hasReadEvidence = evidence.some(
    (e) => e.relevance !== undefined && e.relevance >= 1.0,
  );

  if (!hasReadEvidence) return 'Low';
  if (files.size >= 2) return 'High';
  return 'Medium';
}

/**
 * Build a grounded answer from collected evidence.
 *
 * Every key finding includes a citation. When evidence is insufficient, the
 * answer explicitly says so rather than fabricating information.
 */
export function formatAnswer(
  question: string,
  evidence: Evidence[],
  toolsUsed: string[],
  errors: string[],
): GroundedAnswer {
  const confidence = calculateConfidence(evidence);
  const sorted = [...evidence].sort(
    (a, b) => (b.relevance ?? 0) - (a.relevance ?? 0),
  );

  if (confidence === 'Insufficient') {
    const searched = toolsUsed.length > 0
      ? ` I used ${toolsUsed.join(', ')} but found no relevant evidence.`
      : '';
    const errorNote = errors.length > 0
      ? ` ${errors.length} tool call(s) failed during the investigation.`
      : '';
    return {
      answer: `I could not find sufficient evidence to answer: "${question}".${searched}${errorNote} I will not speculate about repository details that I have not verified.`,
      keyFindings: [],
      sources: [],
      confidence: 'Insufficient',
      toolsUsed,
      insufficientEvidence: true,
    };
  }

  const keyFindings = sorted.slice(0, 5).map((e) => ({
    finding: e.excerpt.split('\n')[0].slice(0, 120),
    citation: formatCitation(e),
  }));
  const sources = sorted.map((e) => formatCitation(e));
  const sourceTypes = [
    ...new Set(evidence.map((e) => e.sourceType)),
  ];

  const confidenceNote =
    confidence !== 'High'
      ? `\n\nConfidence is ${confidence} because the evidence is incomplete${
          confidence === 'Low'
            ? ' (only search leads, no file reads to confirm)'
            : ' (evidence from a single source)'
        }.`
      : '';

  const answer = `Based on evidence from ${sources.length} source(s) across ${sourceTypes.join(' and ')}, here is what I found regarding: "${question}".
${keyFindings.map((f) => `- ${f.finding} (${f.citation})`).join('\n')}${confidenceNote}`;

  return {
    answer,
    keyFindings,
    sources,
    confidence,
    toolsUsed,
    insufficientEvidence: false,
  };
}
