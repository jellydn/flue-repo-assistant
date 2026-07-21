import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import type {
  DebugLogger,
  InspectionMetadata,
  RepositoryReader,
  StepBudget,
} from './repository.ts';
import { summarizeInput, wrapWithBudget } from './repository.ts';

const MAX_RETURNED_LINES = 400;

export function createReadFileTool(
  repository: RepositoryReader,
  budget: StepBudget,
  debug: DebugLogger,
) {
  return defineTool({
    name: 'read_file',
    description:
      'Read a bounded line range from one text file inside the configured repository. Use when an exact file path is already known and surrounding context is needed. Returns numbered lines, total line count, and an inspection budget snapshot. At most 400 lines are returned per call.',
    input: v.object({
      path: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
      startLine: v.optional(
        v.pipe(v.number(), v.integer(), v.minValue(1)),
        1,
      ),
      endLine: v.optional(
        v.pipe(v.number(), v.integer(), v.minValue(1)),
      ),
    }),
    async run({ input, signal }) {
      signal?.throwIfAborted();
      if (input.endLine !== undefined && input.endLine < input.startLine) {
        throw new Error('endLine must be greater than or equal to startLine.');
      }
      const inspection: InspectionMetadata = budget.consume('read_file');
      const inputSummary = summarizeInput({
        path: input.path,
        startLine: input.startLine,
        endLine: input.endLine,
      });
      try {
        const content = await repository.readText(input.path);
        const lines = content.split(/\r?\n/);
        const requestedEnd =
          input.endLine ?? input.startLine + MAX_RETURNED_LINES - 1;
        const endLine = Math.min(
          requestedEnd,
          input.startLine + MAX_RETURNED_LINES - 1,
          lines.length,
        );
        const selected = lines
          .slice(input.startLine - 1, endLine)
          .map((line, index) => `${input.startLine + index}: ${line}`)
          .join('\n');

        const result = {
          path: input.path,
          startLine: input.startLine,
          endLine,
          totalLines: lines.length,
          content: selected,
          truncated: requestedEnd > endLine || endLine < lines.length,
          inspection,
        };
        debug.log({
          tool: 'read_file',
          status: 'success',
          inputSummary,
          count: endLine - input.startLine + 1,
          inspection,
        });
        return result;
      } catch (error) {
        debug.log({
          tool: 'read_file',
          status: 'error',
          inputSummary,
          inspection,
        });
        throw wrapWithBudget(error, 'read_file', inspection);
      }
    },
  });
}
