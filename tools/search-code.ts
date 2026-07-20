import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import type { RepositoryReader, StepBudget } from './repository.ts';

const MAX_MATCHES = 50;

export function createSearchCodeTool(
  repository: RepositoryReader,
  budget: StepBudget,
) {
  return defineTool({
    name: 'search_code',
    description:
      'Search first-party text and source files for a literal string. Returns matching repository-relative paths, line numbers, and line excerpts. The search is read-only and excludes dependencies and generated build output.',
    input: v.object({
      query: v.pipe(v.string(), v.minLength(2), v.maxLength(200)),
      path: v.optional(v.pipe(v.string(), v.maxLength(500)), '.'),
      caseSensitive: v.optional(v.boolean(), false),
    }),
    async run({ input, signal }) {
      signal?.throwIfAborted();
      const inspection = budget.consume('search_code');
      const files = await repository.sourceFiles(input.path);
      const needle = input.caseSensitive ? input.query : input.query.toLowerCase();
      const matches: Array<{ path: string; line: number; excerpt: string }> = [];

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
          const haystack = input.caseSensitive ? lines[index] : lines[index].toLowerCase();
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

      return {
        query: input.query,
        path: input.path,
        matches,
        filesSearched: files.length,
        truncated: matches.length >= MAX_MATCHES,
        inspection,
      };
    },
  });
}
