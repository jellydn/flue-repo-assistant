import { InvalidToolResponseError } from './errors.ts';

/**
 * Validate tool outputs before returning them to the agent. Catches missing
 * required fields, malformed shapes, oversized content, and empty results
 * (returned as controlled results, not thrown, for empty cases).
 */

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: InvalidToolResponseError };

/**
 * Check that an object has all required string/number/array fields.
 * Returns a {@link ValidationResult} so the caller can decide whether to
 * throw or return a controlled result.
 */
export function validateShape(
  output: unknown,
  requiredFields: Record<string, 'string' | 'number' | 'boolean' | 'array' | 'object'>,
): ValidationResult<typeof output> {
  if (output === null || output === undefined) {
    return {
      ok: false,
      error: new InvalidToolResponseError('Tool output is null or undefined'),
    };
  }

  if (typeof output !== 'object' || Array.isArray(output)) {
    return {
      ok: false,
      error: new InvalidToolResponseError(
        `Tool output must be an object, got ${Array.isArray(output) ? 'array' : typeof output}`,
      ),
    };
  }

  const obj = output as Record<string, unknown>;
  for (const [field, expectedType] of Object.entries(requiredFields)) {
    if (!(field in obj)) {
      return {
        ok: false,
        error: new InvalidToolResponseError(
          `Tool output missing required field "${field}"`,
        ),
      };
    }
    const actual = obj[field];
    if (expectedType === 'array') {
      if (!Array.isArray(actual)) {
        return {
          ok: false,
          error: new InvalidToolResponseError(
            `Tool output field "${field}" must be an array, got ${typeof actual}`,
          ),
        };
      }
    } else if (typeof actual !== expectedType) {
      return {
        ok: false,
        error: new InvalidToolResponseError(
          `Tool output field "${field}" must be ${expectedType}, got ${typeof actual}`,
        ),
      };
    }
  }

  return { ok: true, value: output };
}

/** Maximum allowed content length in a validated tool output (chars). */
export const MAX_OUTPUT_CONTENT_CHARS = 200_000;

/**
 * Validate that a string field in the output is not oversized. Returns a
 * controlled error if the content exceeds the limit.
 */
export function validateContentSize(
  content: string,
  maxChars = MAX_OUTPUT_CONTENT_CHARS,
): ValidationResult<string> {
  if (content.length > maxChars) {
    return {
      ok: false,
      error: new InvalidToolResponseError(
        `Tool output content exceeds ${maxChars} characters (got ${content.length})`,
      ),
    };
  }
  return { ok: true, value: content };
}

/**
 * Validate a search_code result shape: must have `matches` (array),
 * `filesSearched` (number), `inspection` (object), and `query` (string).
 * Also checks content size of each match excerpt.
 */
export function validateSearchResult(output: unknown): ValidationResult<{
  matches: Array<{ path: string; line: number; excerpt: string }>;
  filesSearched: number;
  query: string;
  path: string;
  truncated: boolean;
  inspection: unknown;
}> {
  const shape = validateShape(output, {
    matches: 'array',
    filesSearched: 'number',
    query: 'string',
    path: 'string',
    truncated: 'boolean',
    inspection: 'object',
  });
  if (!shape.ok) return shape;

  const obj = shape.value as {
    matches: Array<{ path: string; line: number; excerpt: string }>;
  };
  for (const match of obj.matches) {
    if (
      typeof match?.path !== 'string' ||
      typeof match?.line !== 'number' ||
      typeof match?.excerpt !== 'string'
    ) {
      return {
        ok: false,
        error: new InvalidToolResponseError(
          'Search result match has missing or invalid path/line/excerpt',
        ),
      };
    }
    const size = validateContentSize(match.excerpt, 1_000);
    if (!size.ok) return size;
  }

  return { ok: true, value: shape.value as never };
}

/**
 * Validate a read_file result shape: must have `content` (string),
 * `startLine`/`endLine`/`totalLines` (numbers), `path` (string),
 * `truncated` (boolean), and `inspection` (object).
 */
export function validateReadResult(output: unknown): ValidationResult<{
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  content: string;
  truncated: boolean;
  inspection: unknown;
}> {
  const shape = validateShape(output, {
    content: 'string',
    startLine: 'number',
    endLine: 'number',
    totalLines: 'number',
    path: 'string',
    truncated: 'boolean',
    inspection: 'object',
  });
  if (!shape.ok) return shape;

  const obj = shape.value as { content: string };
  const size = validateContentSize(obj.content);
  if (!size.ok) return size;

  return { ok: true, value: shape.value as never };
}

/**
 * Validate a list_files result shape: must have `entries` (array),
 * `path` (string), `truncated` (boolean), and `inspection` (object).
 */
export function validateListResult(output: unknown): ValidationResult<{
  path: string;
  entries: Array<{ path: string; type: 'file' | 'directory'; size?: number }>;
  truncated: boolean;
  inspection: unknown;
}> {
  const shape = validateShape(output, {
    entries: 'array',
    path: 'string',
    truncated: 'boolean',
    inspection: 'object',
  });
  if (!shape.ok) return shape;

  const obj = shape.value as {
    entries: Array<{ path: string; type: 'file' | 'directory' }>;
  };
  for (const entry of obj.entries) {
    if (typeof entry?.path !== 'string' || typeof entry?.type !== 'string') {
      return {
        ok: false,
        error: new InvalidToolResponseError(
          'List result entry has missing or invalid path/type',
        ),
      };
    }
  }

  return { ok: true, value: shape.value as never };
}
