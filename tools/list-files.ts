import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import type {
  DebugLogger,
  InspectionMetadata,
  RepositoryReader,
  StepBudget,
} from './repository.ts';
import { summarizeInput, wrapWithBudget } from './repository.ts';

const MAX_RETURNED_ENTRIES = 500;

export function createListFilesTool(
  repository: RepositoryReader,
  budget: StepBudget,
  debug: DebugLogger,
) {
  return defineTool({
    name: 'list_files',
    description:
      'List files and directories below one repository-relative directory. Use when the repository structure or a file path is unknown. Ignored build, dependency, VCS, and symlink entries are omitted. Returns repository-relative paths plus an inspection budget snapshot.',
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
      const inspection: InspectionMetadata = budget.consume('list_files');
      const inputSummary = summarizeInput({
        path: input.path,
        depth: input.depth,
      });
      try {
        const entries = await repository.list(input.path, input.depth);
        const result = {
          path: input.path,
          entries: entries.slice(0, MAX_RETURNED_ENTRIES),
          truncated: entries.length > MAX_RETURNED_ENTRIES,
          inspection,
        };
        debug.log({
          tool: 'list_files',
          status: 'success',
          inputSummary,
          count: result.entries.length,
          inspection,
        });
        return result;
      } catch (error) {
        debug.log({
          tool: 'list_files',
          status: 'error',
          inputSummary,
          inspection,
        });
        throw wrapWithBudget(error, 'list_files', inspection);
      }
    },
  });
}
