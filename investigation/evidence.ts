import type { Evidence, EvidenceSourceType } from './types.ts';
import path from 'node:path';

const MAX_EVIDENCE_ITEMS = 30;
const MAX_EXCERPT_LENGTH = 500;

const DOC_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);

/** Determine whether a file path is a documentation file by extension. */
export function isDocumentationFile(filePath: string): boolean {
  return DOC_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/**
 * Deduplication key for evidence: file path + line range.
 * Two items with the same file and line range are considered duplicates.
 */
function dedupKey(e: Evidence): string {
  return `${e.filePath}:${e.lineStart ?? 0}-${e.lineEnd ?? 0}`;
}

/**
 * Bounded, deduplicating evidence collector.
 *
 * - Deduplicates by file path + line range.
 * - Caps total items at {@link MAX_EVIDENCE_ITEMS}.
 * - Truncates excerpts to {@link MAX_EXCERPT_LENGTH} characters.
 * - Items are retrievable sorted by descending relevance.
 */
export type EvidenceCollector = {
  add(evidence: Evidence): boolean;
  readonly items: Evidence[];
  readonly count: number;
  hasDocumentation: boolean;
  hasCode: boolean;
  files: Set<string>;
};

export function createEvidenceCollector(): EvidenceCollector {
  const items: Evidence[] = [];
  const seen = new Set<string>();

  return {
    add(evidence) {
      const key = dedupKey(evidence);
      if (seen.has(key)) return false;
      if (items.length >= MAX_EVIDENCE_ITEMS) return false;
      seen.add(key);
      items.push({
        ...evidence,
        excerpt: evidence.excerpt.slice(0, MAX_EXCERPT_LENGTH),
      });
      return true;
    },
    get items() {
      return [...items].sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0));
    },
    get count() {
      return items.length;
    },
    get hasDocumentation() {
      return items.some((e) => e.sourceType === 'documentation');
    },
    get hasCode() {
      return items.some((e) => e.sourceType === 'code');
    },
    get files() {
      return new Set(items.map((e) => e.filePath));
    },
  };
}

/**
 * Extract evidence from a tool result and add it to the collector.
 *
 * - search_code / search_docs: each match becomes a low-relevance lead.
 * - read_file: the returned content becomes a high-relevance evidence item.
 * - list_files: no evidence extracted (structure only).
 */
export function extractEvidence(
  tool: string,
  output: unknown,
  collector: EvidenceCollector,
): void {
  if (tool === 'search_code' || tool === 'search_docs') {
    const result = output as {
      matches?: Array<{ path: string; line: number; excerpt: string }>;
    };
    const sourceType: EvidenceSourceType =
      tool === 'search_docs' ? 'documentation' : 'code';
    for (const match of result.matches ?? []) {
      collector.add({
        filePath: match.path,
        lineStart: match.line,
        lineEnd: match.line,
        excerpt: match.excerpt,
        sourceType,
        relevance: 0.5,
      });
    }
  } else if (tool === 'read_file') {
    const result = output as {
      path: string;
      startLine: number;
      endLine: number;
      content: string;
    };
    collector.add({
      filePath: result.path,
      lineStart: result.startLine,
      lineEnd: result.endLine,
      excerpt: result.content,
      sourceType: isDocumentationFile(result.path) ? 'documentation' : 'code',
      relevance: 1.0,
    });
  }
}
