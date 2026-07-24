import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import type {
  DebugLogger,
  InspectionMetadata,
  RepositoryReader,
  StepBudget,
} from './repository.ts';
import { summarizeInput, wrapWithBudget } from './repository.ts';

const MAX_MATCHES = 50;

/**
 * search_docs — search documentation files (Markdown, text, README, AGENTS,
 * SOUL, CHANGELOG, docs/**) for a literal string. Use when looking for
 * documented architecture, configuration guides, or design explanations whose
 * path is unknown. Excludes dependencies, build output, and generated
 * directories. Returns matching repository-relative paths, line numbers, and
 * line excerpts, plus an inspection budget snapshot. Results are leads, not
 * proof—read the matching docs before drawing conclusions.
 */
export function createSearchDocsTool(
  repository: RepositoryReader,
  budget: StepBudget,
  debug: DebugLogger,
) {
  return defineTool({
    name: 'search_docs',
    description:
      'Search documentation files (Markdown, text, README, AGENTS, CHANGELOG, docs/**) for a literal string. Use when looking for documented architecture, configuration, or design explanations whose path is unknown. Returns matching repository-relative paths, line numbers, and line excerpts, plus an inspection budget snapshot. Excludes dependencies and generated build output. Results are leads—read the matching documentation before drawing conclusions.',
    input: v.object({
      query: v.pipe(v.string(), v.minLength(2), v.maxLength(200)),
      path: v.optional(v.pipe(v.string(), v.maxLength(500)), '.'),
      caseSensitive: v.optional(v.boolean(), false),
    }),
    async run({ input, signal }) {
      signal?.throwIfAborted();
      const inspection: InspectionMetadata = budget.consume('search_docs');
      const inputSummary = summarizeInput({
        query: input.query,
        path: input.path,
        caseSensitive: input.caseSensitive,
      });
      try {
        const files = await repository.documentationFiles(input.path);
        const needle = input.caseSensitive
          ? input.query
          : input.query.toLowerCase();
        const matches: Array<{ path: string; line: number; excerpt: string }> =
          [];

        for (const file of files) {
          signal?.throwIfAborted();
          let content: string;
          try {
            content = await repository.readText(file);
          } catch {
            continue;
          }
          const lines = content.split(/\r?\n/);
          for (let index = 0; index < lines.length; index += 1) {
            const haystack = input.caseSensitive
              ? lines[index]
              : lines[index].toLowerCase();
            if (haystack.includes(needle)) {
              matches.push({
                path: file,
                line: index + 1,
                excerpt: lines[index].trim().slice(0, 300),
              });
              if (matches.length >= MAX_MATCHES) break;
            }
          }
          if (matches.length >= MAX_MATCHES) break;
        }

        const result = {
          query: input.query,
          path: input.path,
          matches,
          filesSearched: files.length,
          truncated: matches.length >= MAX_MATCHES,
          inspection,
        };
        debug.log({
          tool: 'search_docs',
          status: 'success',
          inputSummary,
          count: result.matches.length,
          inspection,
        });
        return result;
      } catch (error) {
        debug.log({
          tool: 'search_docs',
          status: 'error',
          inputSummary,
          inspection,
        });
        throw wrapWithBudget(error, 'search_docs', inspection);
      }
    },
  });
}
