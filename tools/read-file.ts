import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import type { RepositoryReader, StepBudget } from './repository.ts';

const MAX_RETURNED_LINES = 400;

export function createReadFileTool(
  repository: RepositoryReader,
  budget: StepBudget,
) {
  return defineTool({
    name: 'read_file',
    description:
      'Read a bounded line range from one text file inside the configured repository. Returns numbered lines suitable for citations.',
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
      const inspection = budget.consume('read_file');
      const content = await repository.readText(input.path);
      const lines = content.split(/\r?\n/);
      const requestedEnd = input.endLine ?? input.startLine + MAX_RETURNED_LINES - 1;
      if (requestedEnd < input.startLine) {
        throw new Error('endLine must be greater than or equal to startLine.');
      }
      const endLine = Math.min(
        requestedEnd,
        input.startLine + MAX_RETURNED_LINES - 1,
        lines.length,
      );
      const selected = lines
        .slice(input.startLine - 1, endLine)
        .map((line, index) => `${input.startLine + index}: ${line}`)
        .join('\n');

      return {
        path: input.path,
        startLine: input.startLine,
        endLine,
        totalLines: lines.length,
        content: selected,
        truncated: requestedEnd > endLine,
        inspection,
      };
    },
  });
}
