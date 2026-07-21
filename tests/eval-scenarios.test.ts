import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { InspectionMetadata } from '../tools/repository.ts';
import {
  createDebugLogger,
  createRepositoryReader,
  createStepBudget,
} from '../tools/repository.ts';
import { createListFilesTool } from '../tools/list-files.ts';
import { createReadFileTool } from '../tools/read-file.ts';
import { createSearchCodeTool } from '../tools/search-code.ts';
import { createSampleRepo, removeRepo } from './helpers.ts';

/**
 * These tests deterministically simulate the tool sequence each evaluation
 * scenario is expected to drive. They do not call an LLM; Flue's model calls
 * cannot be inspected deterministically without a live provider key. Instead
 * they prove that the expected observe → act → reflect tool pattern is
 * supported by the tool contracts, that structured results feed back into the
 * next step, and that the shared budget bounds the sequence.
 *
 * The live model-driven sequence can be observed with `eval/run-eval.sh` and
 * REPO_ASSISTANT_DEBUG=true, which logs one line per tool call.
 */

type Entry = { path: string; type: 'file' | 'directory'; size?: number };
type ListResult = {
  path: string;
  entries: Entry[];
  truncated: boolean;
  inspection: InspectionMetadata;
};
type ReadResult = {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  content: string;
  truncated: boolean;
  inspection: InspectionMetadata;
};
type SearchMatch = { path: string; line: number; excerpt: string };
type SearchResult = {
  query: string;
  path: string;
  matches: SearchMatch[];
  filesSearched: number;
  truncated: boolean;
  inspection: InspectionMetadata;
};

const noDebug = () => createDebugLogger(false);
let root: string;

before(async () => {
  root = await createSampleRepo();
});

after(async () => {
  await removeRepo(root);
});

describe('Scenario A: direct read (read_file)', () => {
  test('reads a known config file in a single tool call', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(8);
    const read = createReadFileTool(repository, budget, noDebug());
    const result = (await read.run({
      input: { path: 'src/config.ts', startLine: 1 },
    })) as ReadResult;
    assert.equal(budget.used, 1);
    assert.match(result.content, /PORT/);
    assert.match(result.content, /process\.env\.PORT \?\? 3000/);
    // The agent can answer "how is the port configured" from this single result.
    assert.ok(result.inspection.remaining > 0);
  });
});

describe('Scenario B: search then read (search_code -> read_file)', () => {
  test('search locates auth, read confirms the flow', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(8);
    const search = createSearchCodeTool(repository, budget, noDebug());
    const read = createReadFileTool(repository, budget, noDebug());

    const searchResult = (await search.run({
      input: { query: 'login', path: '.', caseSensitive: false },
    })) as SearchResult;
    assert.equal(budget.used, 1);
    const authHit = searchResult.matches.find((m) => m.path === 'src/auth.ts');
    assert.ok(authHit, 'search should surface src/auth.ts as a lead');

    const readResult = (await read.run({
      input: { path: 'src/auth.ts', startLine: 1 },
    })) as ReadResult;
    assert.equal(budget.used, 2);
    assert.match(readResult.content, /issueToken/);
    // Tracing the flow one level deeper is allowed when budget permits.
    const followRead = (await read.run({
      input: { path: 'src/services/user-service.ts', startLine: 1 },
    })) as ReadResult;
    assert.equal(budget.used, 3);
    assert.match(followRead.content, /export function issueToken/);
  });
});

describe('Scenario C: structure discovery (list_files -> read_file)', () => {
  test('list then selected reads build an overview', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(8);
    const list = createListFilesTool(repository, budget, noDebug());
    const read = createReadFileTool(repository, budget, noDebug());

    const listResult = (await list.run({ input: { path: '.', depth: 3 } })) as ListResult;
    assert.equal(budget.used, 1);
    const paths = listResult.entries.map((e) => e.path);
    assert(paths.includes('src/index.ts'));

    const entry = (await read.run({
      input: { path: 'src/index.ts', startLine: 1 },
    })) as ReadResult;
    assert.equal(budget.used, 2);
    assert.match(entry.content, /import.*config/);
    assert.match(entry.content, /import.*auth/);
  });
});

describe('Scenario D: negative search (no fabricated feature)', () => {
  test('payment search hits only misleading notes; read confirms no implementation', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(8);
    const search = createSearchCodeTool(repository, budget, noDebug());
    const read = createReadFileTool(repository, budget, noDebug());

    const searchResult = (await search.run({
      input: { query: 'payment', path: '.', caseSensitive: false },
    })) as SearchResult;
    assert.equal(budget.used, 1);
    // The only lead is the unrelated notes file with misleading keywords.
    assert.ok(searchResult.matches.every((m) => m.path === 'src/utils/notes.md'));
    assert.ok(searchResult.matches.length > 0);

    const note = (await read.run({
      input: { path: 'src/utils/notes.md', startLine: 1 },
    })) as ReadResult;
    assert.equal(budget.used, 2);
    assert.match(note.content, /misleading keywords, no implementation/);
    // No source file implements payment processing; the agent reports the miss
    // rather than inventing a subsystem.
  });
});

describe('Scenario E: no unnecessary tool (conceptual answer)', () => {
  test('conceptual question needs zero inspection calls', () => {
    const budget = createStepBudget(8);
    // A conceptual question ("difference between list_files and search_code")
    // can be answered from instructions alone. No tool call means the budget
    // stays untouched and the agent answers immediately.
    assert.equal(budget.used, 0);
    assert.equal(budget.remaining, 8);
  });
});
