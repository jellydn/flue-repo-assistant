import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import {
  createRepositoryReader,
  createStepBudget,
  parseMaxSteps,
} from '../tools/repository.ts';

let fixture: string;

before(async () => {
  fixture = await mkdtemp(path.join(tmpdir(), 'flue-repo-assistant-'));
  await mkdir(path.join(fixture, 'src'));
  await writeFile(
    path.join(fixture, 'src', 'main.ts'),
    'import { login } from "./auth.ts";\nlogin();\n',
  );
  await writeFile(
    path.join(fixture, 'src', 'auth.ts'),
    'export function login() { return "token"; }\n',
  );
  await mkdir(path.join(fixture, 'node_modules'));
  await writeFile(path.join(fixture, 'node_modules', 'ignored.js'), 'login');
});

after(async () => {
  await rm(fixture, { force: true, recursive: true });
});

test('lists source files while ignoring dependency directories', async () => {
  const repository = await createRepositoryReader(fixture);
  const entries = await repository.list('.', 2);
  assert(entries.some((entry) => entry.path === 'src/main.ts'));
  assert(!entries.some((entry) => entry.path.includes('node_modules')));
});

test('reads files and rejects paths outside the repository', async () => {
  const repository = await createRepositoryReader(fixture);
  assert.match(await repository.readText('src/auth.ts'), /function login/);
  await assert.rejects(repository.readText('../outside.ts'), /escapes/);
});

test('rejects symlinks that leave the repository', async () => {
  const repository = await createRepositoryReader(fixture);
  const link = path.join(fixture, 'outside-link');
  await symlink(tmpdir(), link);
  await assert.rejects(repository.resolve('outside-link'), /Symbolic link escapes/);
  await rm(link);
});

test('bounds inspection steps', () => {
  const budget = createStepBudget(2);
  assert.equal(budget.consume('list_files').remaining, 1);
  assert.equal(budget.consume('read_file').remaining, 0);
  assert.throws(() => budget.consume('search_code'), /budget exhausted/);
});

test('validates configured maximum steps', () => {
  assert.equal(parseMaxSteps(undefined), 8);
  assert.equal(parseMaxSteps('3'), 3);
  assert.throws(() => parseMaxSteps('0'), /integer from 1 to 20/);
  assert.throws(() => parseMaxSteps('2.5'), /integer from 1 to 20/);
});
