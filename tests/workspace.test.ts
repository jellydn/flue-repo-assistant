import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { createRestrictedSandboxFactory, createWorkspaceSandboxFactory } from '../sandbox.ts';
import type { SandboxFactory } from '@flue/runtime';
import {
  FileWorkspaceStore,
  MemoryWorkspaceStore,
  Workspace,
  WorkspaceConflictError,
  WorkspaceNotFoundError,
  type WorkspaceStore,
} from '../workspace.ts';

async function workspace() {
  return Workspace.open('shared', new MemoryWorkspaceStore());
}

// The runtime's SandboxFactory shape changed across minor versions
// (createSessionEnv in 2.0.1, createSandbox in 2.0.2), so callers narrow
// through whichever entry point the installed runtime provides.
async function createBaseSession(baseFactory: SandboxFactory, options: { id: string }) {
  const create = baseFactory.createSandbox ?? baseFactory.createSessionEnv;
  return create(options);
}

describe('persistent workspace', () => {
  test('persists files and reopens them from a shared store', async () => {
    const store = new MemoryWorkspaceStore();
    const first = await Workspace.open('shared', store);
    assert.equal(await first.writeFile('src/index.ts', 'export const ok = true;'), 1);
    const second = await Workspace.open('shared', store);
    assert.equal(second.version, 1);
    assert.equal(await second.readFile('src/index.ts'), 'export const ok = true;');
    assert.deepEqual(second.listFiles(), ['src/index.ts']);
  });

  test('round-trips through the file store', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'flowly-workspace-'));
    try {
      const store = new FileWorkspaceStore(directory);
      const current = await Workspace.open('file-backed', store);
      await current.writeFile('src/index.ts', 'export const ok = true;');
      const reopened = await Workspace.open('file-backed', store);
      assert.equal(await reopened.readFile('src/index.ts'), 'export const ok = true;');
      assert.equal(reopened.version, 1);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test('rejects malformed file snapshots', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'flowly-workspace-invalid-'));
    try {
      await writeFile(
        path.join(directory, 'broken.json'),
        JSON.stringify({
          workspaceId: 'broken',
          version: 1,
          files: { 'src/index.ts': 42 },
        }),
      );
      await assert.rejects(() => new FileWorkspaceStore(directory).load('broken'), /not text/);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test('creates and restores immutable snapshots', async () => {
    const current = await workspace();
    await current.writeFile('a.txt', 'one');
    const snapshot = current.snapshot();
    await current.writeFile('a.txt', 'two');
    await current.writeFile('b.txt', 'extra');
    assert.equal(await current.restore(snapshot), 4);
    assert.equal(await current.readFile('a.txt'), 'one');
    await assert.rejects(() => current.readFile('b.txt'), WorkspaceNotFoundError);
  });

  test('rejects stale collaborators with a store-level version conflict', async () => {
    const store = new MemoryWorkspaceStore();
    const first = await Workspace.open('shared', store);
    const second = await Workspace.open('shared', store);
    await first.writeFile('a.txt', 'first');
    await assert.rejects(
      () => second.writeFile('b.txt', 'stale'),
      (error: unknown) => {
        assert.ok(error instanceof WorkspaceConflictError);
        assert.equal(error.actualVersion, 1);
        return true;
      },
    );
  });

  test('rejects absolute and traversal paths', async () => {
    const current = await workspace();
    await assert.rejects(() => current.writeFile('../escape.txt', 'bad'), /escapes/);
    await assert.rejects(() => current.writeFile('/absolute.txt', 'bad'), /relative/);
  });

  test('initializes the execution sandbox lazily and only once', async () => {
    let created = 0;
    const baseFactory = createRestrictedSandboxFactory();
    const current = await workspace();
    const factory = createWorkspaceSandboxFactory(current, () => ({
      createSandbox: async (options) => {
        created += 1;
        return createBaseSession(baseFactory, options);
      },
      createSessionEnv: async (options) => {
        created += 1;
        return createBaseSession(baseFactory, options);
      },
      tools: () => [],
    }));
    assert.equal(created, 0);
    await factory.createSessionEnv!({ id: 'agent-1' });
    await factory.createSessionEnv!({ id: 'agent-2' });
    assert.equal(created, 1);
  });

  test('hydrates and persists files through the session environment', async () => {
    const current = await workspace();
    await current.writeFile('src/index.ts', 'export const before = true;');
    const factory = createWorkspaceSandboxFactory(current);
    const session = await factory.createSessionEnv!({ id: 'agent-1' });
    assert.equal(await session.readFile('src/index.ts'), 'export const before = true;');
    await session.writeFile('src/index.ts', 'export const after = true;');
    assert.equal(await current.readFile('src/index.ts'), 'export const after = true;');
    await session.exec('mkdir -p src && printf updated > src/status.txt');
    assert.equal(await current.readFile('src/status.txt'), 'updated');
    await session.rm('src/index.ts');
    await assert.rejects(() => current.readFile('src/index.ts'), WorkspaceNotFoundError);
  });

  test('fails closed after persistence fails', async () => {
    let calls = 0;
    let underlyingWrites = 0;
    const baseFactory = createRestrictedSandboxFactory();
    const failingStore: WorkspaceStore = {
      load: async () => null,
      save: async () => {
        calls += 1;
        throw new Error('persistence unavailable');
      },
    };
    const failingWorkspace = await Workspace.open('shared', failingStore);
    const wrap = async (options: { id: string }) => {
      const session = await createBaseSession(baseFactory, options);
      return {
        ...session,
        writeFile: async (filePath: string, content: string) => {
          underlyingWrites += 1;
          await session.writeFile(filePath, content);
        },
      };
    };
    const factory = createWorkspaceSandboxFactory(failingWorkspace, () => ({
      createSandbox: wrap,
      createSessionEnv: wrap,
      tools: () => [],
    }));
    const session = await factory.createSessionEnv!({ id: 'agent-1' });
    await assert.rejects(
      () => session.exec('printf changed > changed.txt'),
      /persistence unavailable/,
    );
    await assert.rejects(
      () => session.writeFile('later.txt', 'blocked'),
      /persistence unavailable/,
    );
    assert.equal(calls, 1);
    assert.equal(underlyingWrites, 0);
  });
});
