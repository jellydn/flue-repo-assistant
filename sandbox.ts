import { bash, type SandboxFactory, type SessionEnv } from '@flue/runtime';
import { Bash } from 'just-bash';
import type { Workspace, WorkspaceFiles } from './workspace.ts';

/**
 * Create a restricted sandbox factory lazily. Constructing the factory is
 * side-effect free; the Bash execution environment is created only when Flue
 * initializes a session and calls a session-creation entry point.
 */
export function createRestrictedSandboxFactory(): SandboxFactory {
  const isolatedMemorySandbox = bash(() => new Bash());
  return {
    // Keep the complete Flue factory, including newer runtime adapter fields
    // (createSandbox on 2.0.2, createSessionEnv on 2.0.1), while removing its
    // default model-facing filesystem and shell tools. Repository access is
    // available only through this project's five custom, bounded tools.
    ...isolatedMemorySandbox,
    createSessionEnv: isolatedMemorySandbox.createSessionEnv?.bind(isolatedMemorySandbox),
    tools: () => [],
  };
}

/** Existing agent binding retained for callers that need a stable factory. */
export const restrictedSandbox: SandboxFactory = createRestrictedSandboxFactory();

/**
 * Workspace-aware lazy factory. Files are hydrated when the session starts and
 * mutations made through file tools or shell commands are persisted after the
 * operation completes. The returned environment remains in-memory and never
 * exposes the host filesystem.
 */
export function createWorkspaceSandboxFactory(
  workspace: Workspace,
  createSandbox: () => SandboxFactory = createRestrictedSandboxFactory,
): SandboxFactory {
  let sessionPromise: Promise<SessionEnv> | undefined;
  const bootstrap = async (options: { id: string }): Promise<SessionEnv> => {
    sessionPromise ??= (async () => {
      const factory = createSandbox();
      const createSession = factory.createSandbox ?? factory.createSessionEnv;
      const session = await createSession(options);
      const baselineFiles = await readSessionFiles(session, session.cwd);
      const workspacePaths = new Set<string>();
      for (const filePath of workspace.listFiles()) {
        await session.writeFile(filePath, await workspace.readFile(filePath));
        workspacePaths.add(normalizeSessionPath(filePath));
      }
      return wrapWorkspaceSession(session, workspace, baselineFiles, workspacePaths);
    })();
    return sessionPromise;
  };
  return {
    // Expose both the current (createSandbox) and legacy (createSessionEnv)
    // entry points so the factory works across runtime minor versions.
    createSandbox: bootstrap,
    createSessionEnv: bootstrap,
    tools: () => [],
  };
}

function wrapWorkspaceSession(
  session: SessionEnv,
  workspace: Workspace,
  baselineFiles: WorkspaceFiles,
  workspacePaths: Set<string>,
): SessionEnv {
  let persistence = Promise.resolve();
  let failure: unknown;
  const assertHealthy = () => {
    if (failure !== undefined) throw failure;
  };
  const persist = () => {
    if (failure !== undefined) return Promise.reject(failure);
    const run = () => persistSessionFiles(session, workspace, baselineFiles, workspacePaths);
    persistence = persistence.then(run, run).catch((error) => {
      failure = error;
      throw error;
    });
    return persistence;
  };
  return {
    ...session,
    async exec(command, options) {
      assertHealthy();
      let result: Awaited<ReturnType<SessionEnv['exec']>> | undefined;
      let commandError: unknown;
      try {
        result = await session.exec(command, options);
      } catch (error) {
        commandError = error;
      }
      try {
        await persist();
      } catch (error) {
        if (commandError === undefined) throw error;
      }
      if (commandError !== undefined) throw commandError;
      return result as Awaited<ReturnType<SessionEnv['exec']>>;
    },
    async writeFile(filePath, content) {
      assertHealthy();
      await session.writeFile(filePath, content);
      workspacePaths.add(normalizeSessionPath(filePath));
      await persist();
    },
    async rm(filePath, options) {
      assertHealthy();
      await session.rm(filePath, options);
      workspacePaths.delete(normalizeSessionPath(filePath));
      await persist();
    },
  };
}

async function persistSessionFiles(
  session: SessionEnv,
  workspace: Workspace,
  baselineFiles: WorkspaceFiles,
  workspacePaths: Set<string>,
): Promise<void> {
  const currentFiles = await readSessionFiles(session, session.cwd);
  const files: WorkspaceFiles = {};
  for (const [filePath, content] of Object.entries(currentFiles)) {
    if (workspacePaths.has(filePath) || !(filePath in baselineFiles)) {
      files[filePath] = content;
    }
  }
  await workspace.replaceFiles(files, workspace.version);
}

async function readSessionFiles(session: SessionEnv, root: string): Promise<WorkspaceFiles> {
  const files: WorkspaceFiles = {};
  await collectFiles(session, root, root, files);
  return files;
}

async function collectFiles(
  session: SessionEnv,
  root: string,
  current: string,
  files: WorkspaceFiles,
): Promise<void> {
  for (const entry of await session.readdir(current)) {
    const absolutePath = joinPath(current, entry);
    const stat = await session.stat(absolutePath);
    if (stat.isDirectory) {
      await collectFiles(session, root, absolutePath, files);
    } else if (stat.isFile) {
      const relativePath = relativePathFrom(root, absolutePath);
      files[relativePath] = await session.readFile(absolutePath);
    }
  }
}

function normalizeSessionPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\//, '');
}

function relativePathFrom(root: string, filePath: string): string {
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/$/, '') || '/';
  const normalizedFile = filePath.replace(/\\/g, '/');
  const prefix = normalizedRoot === '/' ? '/' : `${normalizedRoot}/`;
  if (!normalizedFile.startsWith(prefix)) {
    throw new Error(`Session path escapes its working directory: ${filePath}`);
  }
  return normalizedFile.slice(prefix.length);
}

function joinPath(parent: string, child: string): string {
  const normalizedParent = parent.replace(/\\/g, '/').replace(/\/$/, '');
  return `${normalizedParent || '/'}/${child}`.replace('//', '/');
}
