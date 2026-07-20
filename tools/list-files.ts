import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import type { RepositoryReader, StepBudget } from './repository.ts';

export function createListFilesTool(
  repository: RepositoryReader,
  budget: StepBudget,
) {
  return defineTool({
    name: 'list_files',
    description:
      'List files and directories below one repository-relative directory. Use this to discover project structure. Ignored build, dependency, VCS, and symlink entries are omitted.',
    input: v.object({
      path: v.optional(
        v.pipe(v.string(), v.maxLength(500)),
        '.',
      ),
      depth: v.optional(
        v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(5)),
        2,
      ),
    }),
    async run({ input, signal }) {
      signal?.throwIfAborted();
      const inspection = budget.consume('list_files');
      const entries = await repository.list(input.path, input.depth);
      return {
        path: input.path,
        entries: entries.slice(0, 500),
        truncated: entries.length > 500,
        inspection,
      };
    },
  });
}
