import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type WorkspaceFiles = Record<string, string>;

export type WorkspaceSnapshot = {
  workspaceId: string;
  version: number;
  files: WorkspaceFiles;
  savedAt: number;
};

export type WorkspaceStore = {
  load(workspaceId: string): Promise<WorkspaceSnapshot | null>;
  save(snapshot: WorkspaceSnapshot, expectedVersion: number): Promise<void>;
};

export class WorkspaceConflictError extends Error {
  constructor(
    readonly workspaceId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(
      `Workspace \"${workspaceId}\" changed concurrently (expected version ${expectedVersion}, found ${actualVersion}).`,
    );
    this.name = 'WorkspaceConflictError';
  }
}

export class WorkspaceNotFoundError extends Error {
  constructor(
    readonly workspaceId: string,
    readonly filePath: string,
  ) {
    super(`Workspace \"${workspaceId}\" does not contain \"${filePath}\".`);
    this.name = 'WorkspaceNotFoundError';
  }
}

/** In-memory store used by tests and short-lived orchestration. */
export class MemoryWorkspaceStore implements WorkspaceStore {
  private readonly snapshots = new Map<string, WorkspaceSnapshot>();

  async load(workspaceId: string): Promise<WorkspaceSnapshot | null> {
    const snapshot = this.snapshots.get(workspaceId);
    return snapshot ? cloneSnapshot(snapshot) : null;
  }

  async save(snapshot: WorkspaceSnapshot, expectedVersion: number): Promise<void> {
    const current = this.snapshots.get(snapshot.workspaceId);
    const actualVersion = current?.version ?? 0;
    assertStoreVersion(snapshot, expectedVersion, actualVersion);
    this.snapshots.set(snapshot.workspaceId, cloneSnapshot(snapshot));
  }
}

/** JSON-file store for persistence across agent process restarts. */
export class FileWorkspaceStore implements WorkspaceStore {
  constructor(private readonly directory: string) {}

  async load(workspaceId: string): Promise<WorkspaceSnapshot | null> {
    const filePath = this.filePath(workspaceId);
    try {
      const raw = await readFile(filePath, 'utf8');
      return parseSnapshot(JSON.parse(raw), workspaceId);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async save(snapshot: WorkspaceSnapshot, expectedVersion: number): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const filePath = this.filePath(snapshot.workspaceId);
    const lockPath = `${filePath}.lock`;
    let locked = false;
    let temporaryPath: string | undefined;
    try {
      await acquireLock(lockPath);
      locked = true;
      const current = await this.load(snapshot.workspaceId);
      const actualVersion = current?.version ?? 0;
      assertStoreVersion(snapshot, expectedVersion, actualVersion);
      temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, JSON.stringify(snapshot), 'utf8');
      await rename(temporaryPath, filePath);
      temporaryPath = undefined;
    } finally {
      if (temporaryPath) await rm(temporaryPath, { force: true });
      if (locked) await rm(lockPath, { force: true });
    }
  }

  private filePath(workspaceId: string): string {
    const safeId = encodeURIComponent(workspaceId);
    return path.join(this.directory, `${safeId}.json`);
  }
}

/**
 * Mutable workspace state independent from any execution engine. Every write
 * persists an immutable snapshot and increments the version, allowing several
 * agents to collaborate through optimistic version checks.
 */
export class Workspace {
  private constructor(
    readonly id: string,
    private readonly store: WorkspaceStore,
    private files: WorkspaceFiles,
    private currentVersion: number,
  ) {}

  static async open(id: string, store: WorkspaceStore): Promise<Workspace> {
    const snapshot = await store.load(id);
    if (!snapshot) return new Workspace(id, store, {}, 0);
    return new Workspace(id, store, normalizeFiles(snapshot.files), snapshot.version);
  }

  get version(): number {
    return this.currentVersion;
  }

  async readFile(filePath: string): Promise<string> {
    const safePath = normalizeWorkspacePath(filePath);
    const content = this.files[safePath];
    if (content === undefined) throw new WorkspaceNotFoundError(this.id, safePath);
    return content;
  }

  listFiles(): string[] {
    return Object.keys(this.files).sort();
  }

  async writeFile(
    filePath: string,
    content: string,
    expectedVersion = this.currentVersion,
  ): Promise<number> {
    this.assertVersion(expectedVersion);
    const safePath = normalizeWorkspacePath(filePath);
    const nextFiles = { ...this.files, [safePath]: content };
    return this.persist(nextFiles);
  }

  async deleteFile(filePath: string, expectedVersion = this.currentVersion): Promise<number> {
    this.assertVersion(expectedVersion);
    const safePath = normalizeWorkspacePath(filePath);
    if (!(safePath in this.files)) throw new WorkspaceNotFoundError(this.id, safePath);
    const nextFiles = { ...this.files };
    delete nextFiles[safePath];
    return this.persist(nextFiles);
  }

  /** Replace the complete file set, preserving the optimistic version guard. */
  async replaceFiles(
    files: WorkspaceFiles,
    expectedVersion = this.currentVersion,
  ): Promise<number> {
    this.assertVersion(expectedVersion);
    const normalizedFiles = normalizeFiles(files);
    if (sameFiles(this.files, normalizedFiles)) return this.currentVersion;
    return this.persist(normalizedFiles);
  }

  snapshot(): WorkspaceSnapshot {
    return {
      workspaceId: this.id,
      version: this.currentVersion,
      files: { ...this.files },
      savedAt: Date.now(),
    };
  }

  async restore(
    snapshot: WorkspaceSnapshot,
    expectedVersion = this.currentVersion,
  ): Promise<number> {
    this.assertVersion(expectedVersion);
    if (snapshot.workspaceId !== this.id) {
      throw new Error(
        `Snapshot belongs to workspace \"${snapshot.workspaceId}\", not \"${this.id}\".`,
      );
    }
    return this.replaceFiles(snapshot.files, expectedVersion);
  }

  private assertVersion(expectedVersion: number): void {
    if (expectedVersion !== this.currentVersion) {
      throw new WorkspaceConflictError(this.id, expectedVersion, this.currentVersion);
    }
  }

  private async persist(files: WorkspaceFiles): Promise<number> {
    const nextVersion = this.currentVersion + 1;
    const snapshot: WorkspaceSnapshot = {
      workspaceId: this.id,
      version: nextVersion,
      files: { ...files },
      savedAt: Date.now(),
    };
    await this.store.save(snapshot, this.currentVersion);
    this.files = { ...files };
    this.currentVersion = nextVersion;
    return nextVersion;
  }
}

function normalizeWorkspacePath(filePath: string): string {
  if (
    !filePath ||
    path.isAbsolute(filePath) ||
    path.win32.isAbsolute(filePath) ||
    /^[a-zA-Z]:/.test(filePath)
  ) {
    throw new Error('Workspace paths must be relative.');
  }
  const normalized = path.posix.normalize(filePath.replaceAll('\\', '/'));
  if (
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('\0')
  ) {
    throw new Error('Workspace path escapes the workspace.');
  }
  return normalized.replace(/^\.\//, '');
}

function normalizeFiles(files: WorkspaceFiles): WorkspaceFiles {
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    throw new Error('Workspace files must be an object.');
  }
  const normalized: WorkspaceFiles = {};
  for (const [filePath, content] of Object.entries(files)) {
    if (typeof content !== 'string') throw new Error(`Workspace file \"${filePath}\" is not text.`);
    normalized[normalizeWorkspacePath(filePath)] = content;
  }
  return normalized;
}

function parseSnapshot(value: unknown, workspaceId: string): WorkspaceSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid snapshot for workspace \"${workspaceId}\".`);
  }
  const snapshot = value as Partial<WorkspaceSnapshot>;
  const version = snapshot.version;
  const files = snapshot.files;
  if (
    snapshot.workspaceId !== workspaceId ||
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    version < 0 ||
    !files ||
    typeof files !== 'object' ||
    Array.isArray(files)
  ) {
    throw new Error(`Invalid snapshot for workspace \"${workspaceId}\".`);
  }
  return {
    workspaceId,
    version,
    files: normalizeFiles(files as WorkspaceFiles),
    savedAt:
      typeof snapshot.savedAt === 'number' && Number.isFinite(snapshot.savedAt)
        ? snapshot.savedAt
        : 0,
  };
}

function cloneSnapshot(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
  return { ...snapshot, files: { ...snapshot.files } };
}

function assertStoreVersion(
  snapshot: WorkspaceSnapshot,
  expectedVersion: number,
  actualVersion: number,
): void {
  if (actualVersion !== expectedVersion) {
    throw new WorkspaceConflictError(snapshot.workspaceId, expectedVersion, actualVersion);
  }
  if (snapshot.version !== expectedVersion + 1) {
    throw new Error(
      `Workspace \"${snapshot.workspaceId}\" must advance from version ${expectedVersion} to ${expectedVersion + 1}.`,
    );
  }
}

async function acquireLock(lockPath: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await writeFile(lockPath, JSON.stringify({ pid: process.pid }), {
        encoding: 'utf8',
        flag: 'wx',
      });
      return;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      try {
        const owner = JSON.parse(await readFile(lockPath, 'utf8')) as { pid?: unknown };
        if (typeof owner.pid === 'number' && !isProcessAlive(owner.pid)) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch (lockError) {
        if (isNotFound(lockError)) continue;
        if (lockError instanceof SyntaxError) {
          throw new Error(
            `Workspace lock \"${lockPath}\" is malformed and must be removed safely.`,
          );
        }
        throw lockError;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out acquiring workspace lock \"${lockPath}\".`);
}

function sameFiles(left: WorkspaceFiles, right: WorkspaceFiles): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => left[key] === right[key]);
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST');
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EPERM');
  }
}
