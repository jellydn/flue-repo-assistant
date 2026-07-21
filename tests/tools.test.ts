import assert from 'node:assert/strict';
import { rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

describe('list_files', () => {
  test('lists allowed repository files', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(8);
    const tool = createListFilesTool(repository, budget, noDebug());
    const result = (await tool.run({ input: { path: '.', depth: 3 } })) as ListResult;
    assert.equal(result.inspection.used, 1);
    assert.equal(result.inspection.remaining, 7);
    assert.equal(result.inspection.limit, 8);
    const paths = result.entries.map((e) => e.path);
    assert(paths.includes('src/index.ts'));
    assert(paths.includes('src/auth.ts'));
    assert(paths.includes('src/config.ts'));
    assert(paths.includes('src/services/user-service.ts'));
  });

  test('skips ignored dependency directories', async () => {
    const repository = await createRepositoryReader(root);
    const tool = createListFilesTool(repository, createStepBudget(8), noDebug());
    const result = (await tool.run({ input: { path: '.', depth: 3 } })) as ListResult;
    assert(!result.entries.some((e) => e.path.includes('node_modules')));
  });

  test('skips symlinks', async () => {
    const link = path.join(root, 'src', 'link.ts');
    await symlink(path.join(root, 'src', 'config.ts'), link);
    try {
      const repository = await createRepositoryReader(root);
      const tool = createListFilesTool(repository, createStepBudget(8), noDebug());
      const result = (await tool.run({ input: { path: 'src', depth: 1 } })) as ListResult;
      assert(!result.entries.some((e) => e.path === 'src/link.ts'));
    } finally {
      await rm(link, { force: true });
    }
  });

  test('rejects traversal and absolute paths, consumes one step per call', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(8);
    const tool = createListFilesTool(repository, budget, noDebug());
    await assert.rejects(
      async () => tool.run({ input: { path: '../outside', depth: 1 } }),
      /list_files failed.*escapes/,
    );
    await assert.rejects(
      async () => tool.run({ input: { path: '/etc', depth: 1 } }),
      /list_files failed.*relative/,
    );
    assert.equal(budget.used, 2);
  });
});

describe('read_file', () => {
  test('reads an allowed file with line information', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(8);
    const tool = createReadFileTool(repository, budget, noDebug());
    const result = (await tool.run({ input: { path: 'src/config.ts', startLine: 1 } })) as ReadResult;
    assert.equal(result.inspection.used, 1);
    assert.equal(result.startLine, 1);
    assert.equal(result.totalLines, 5);
    assert.match(result.content, /1: export const PORT/);
    assert.match(result.content, /2: export function start/);
  });

  test('rejects traversal and absolute paths', async () => {
    const repository = await createRepositoryReader(root);
    const tool = createReadFileTool(repository, createStepBudget(8), noDebug());
    await assert.rejects(
      async () => tool.run({ input: { path: '../outside.ts', startLine: 1 } }),
      /read_file failed.*escapes/,
    );
    await assert.rejects(
      async () => tool.run({ input: { path: '/etc/hosts', startLine: 1 } }),
      /read_file failed.*relative/,
    );
  });

  test('rejects files above the size limit', async () => {
    const big = path.join(root, 'big.ts');
    await writeFile(big, Buffer.alloc(1_000_001, 'a'));
    try {
      const repository = await createRepositoryReader(root);
      const tool = createReadFileTool(repository, createStepBudget(8), noDebug());
      await assert.rejects(
        async () => tool.run({ input: { path: 'big.ts', startLine: 1 } }),
        /read_file failed.*read limit/,
      );
    } finally {
      await rm(big, { force: true });
    }
  });

  test('truncates output according to the documented line limit', async () => {
    const longFile = path.join(root, 'long.ts');
    await writeFile(longFile, `${Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')}\n`);
    try {
      const repository = await createRepositoryReader(root);
      const tool = createReadFileTool(repository, createStepBudget(8), noDebug());
      const result = (await tool.run({ input: { path: 'long.ts', startLine: 1 } })) as ReadResult;
      assert.equal(result.endLine - result.startLine + 1, 400);
      assert.equal(result.truncated, true);
      assert.equal(result.totalLines, 501);
    } finally {
      await rm(longFile, { force: true });
    }
  });

  test('consumes exactly one inspection step', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(8);
    const tool = createReadFileTool(repository, budget, noDebug());
    await tool.run({ input: { path: 'src/auth.ts', startLine: 1 } });
    assert.equal(budget.used, 1);
  });
});

describe('search_code', () => {
  test('finds literal matches across allowed text files', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(8);
    const tool = createSearchCodeTool(repository, budget, noDebug());
    const result = (await tool.run({
      input: { query: 'login', path: '.', caseSensitive: false },
    })) as SearchResult;
    assert.equal(result.inspection.used, 1);
    assert.ok(result.matches.some((m) => m.path === 'src/auth.ts' && m.line === 2));
    assert.ok(result.matches.some((m) => m.path === 'src/index.ts' && m.line === 2));
    for (const match of result.matches) {
      assert.match(match.excerpt, /login/i);
    }
  });

  test('returns file paths and line numbers', async () => {
    const repository = await createRepositoryReader(root);
    const tool = createSearchCodeTool(repository, createStepBudget(8), noDebug());
    const result = (await tool.run({
      input: { query: 'issueToken', path: '.', caseSensitive: true },
    })) as SearchResult;
    const hit = result.matches.find((m) => m.path === 'src/services/user-service.ts');
    assert.ok(hit);
    assert.equal(hit.line, 1);
  });

  test('respects the result limit', async () => {
    const many = path.join(root, 'many.ts');
    await writeFile(many, `${Array.from({ length: 60 }, () => 'uniquemarker').join('\n')}\n`);
    try {
      const repository = await createRepositoryReader(root);
      const tool = createSearchCodeTool(repository, createStepBudget(8), noDebug());
      const result = (await tool.run({
        input: { query: 'uniquemarker', path: '.', caseSensitive: false },
      })) as SearchResult;
      assert.equal(result.matches.length, 50);
      assert.equal(result.truncated, true);
      assert.ok(result.matches.every((m) => m.path === 'many.ts'));
    } finally {
      await rm(many, { force: true });
    }
  });

  test('ignores excluded directories and oversized files', async () => {
    const big = path.join(root, 'big-search.ts');
    await writeFile(big, Buffer.alloc(1_000_001, 'a'));
    try {
      const repository = await createRepositoryReader(root);
      const tool = createSearchCodeTool(repository, createStepBudget(8), noDebug());
      const result = (await tool.run({
        input: { query: 'noise', path: '.', caseSensitive: false },
      })) as SearchResult;
      assert(!result.matches.some((m) => m.path.includes('node_modules')));
      assert(!result.matches.some((m) => m.path === 'big-search.ts'));
    } finally {
      await rm(big, { force: true });
    }
  });

  test('handles zero matches clearly', async () => {
    const repository = await createRepositoryReader(root);
    const tool = createSearchCodeTool(repository, createStepBudget(8), noDebug());
    const result = (await tool.run({
      input: { query: 'doesnotexistxyz', path: '.', caseSensitive: false },
    })) as SearchResult;
    assert.deepEqual(result.matches, []);
    assert.equal(result.truncated, false);
    assert.ok(result.filesSearched > 0);
  });

  test('consumes exactly one inspection step', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(8);
    const tool = createSearchCodeTool(repository, budget, noDebug());
    await tool.run({ input: { query: 'PORT', path: '.', caseSensitive: true } });
    assert.equal(budget.used, 1);
  });
});

describe('shared budget', () => {
  test('all three tools consume the same budget', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(3);
    const list = createListFilesTool(repository, budget, noDebug());
    const read = createReadFileTool(repository, budget, noDebug());
    const search = createSearchCodeTool(repository, budget, noDebug());
    await list.run({ input: { path: '.', depth: 2 } });
    await read.run({ input: { path: 'src/config.ts', startLine: 1 } });
    await search.run({ input: { query: 'login', path: '.', caseSensitive: false } });
    assert.equal(budget.used, 3);
    assert.equal(budget.remaining, 0);
  });

  test('once exhausted, every inspection tool rejects further calls', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(1);
    const list = createListFilesTool(repository, budget, noDebug());
    const read = createReadFileTool(repository, budget, noDebug());
    const search = createSearchCodeTool(repository, budget, noDebug());
    await list.run({ input: { path: '.', depth: 1 } });
    await assert.rejects(
      async () => read.run({ input: { path: 'src/config.ts', startLine: 1 } }),
      /budget exhausted/,
    );
    await assert.rejects(
      async () => search.run({ input: { query: 'login', path: '.', caseSensitive: false } }),
      /budget exhausted/,
    );
  });

  test('a rejected post-exhaustion call does not make the budget negative', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(1);
    const list = createListFilesTool(repository, budget, noDebug());
    await list.run({ input: { path: '.', depth: 1 } });
    assert.equal(budget.used, 1);
    await assert.rejects(
      async () => list.run({ input: { path: '.', depth: 1 } }),
      /budget exhausted/,
    );
    assert.equal(budget.used, 1);
    assert.equal(budget.remaining, 0);
  });
});

describe('debug logging', () => {
  test('logs safe information and no absolute paths when enabled', async () => {
    const repository = await createRepositoryReader(root);
    const budget = createStepBudget(8);
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.join(' '));
    };
    try {
      const read = createReadFileTool(repository, budget, createDebugLogger(true));
      await read.run({ input: { path: 'src/config.ts', startLine: 1 } });
    } finally {
      console.error = original;
    }
    assert.ok(lines.length >= 1);
    const line = lines.join('\n');
    assert.match(line, /read_file success/);
    assert.match(line, /used=1 remaining=7\/8/);
    assert.match(line, /src\/config.ts/);
    // No absolute host path should leak into the safe log line.
    assert.doesNotMatch(line, new RegExp(tmpdir().replace(/[/\\]/g, '\\$&')));
  });
});
