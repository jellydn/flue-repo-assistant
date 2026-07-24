import { open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_MAX_STEPS = 8;
const MAX_FILE_BYTES = 1_000_000;
const MAX_WALK_FILES = 10_000;

const ignoredNames = new Set([
  '.git',
  '.cache',
  '.terraform',
  '.venv',
  'artifacts',
  'cargo-cache',
  'coverage',
  'dist',
  'downloads',
  'node_modules',
  'sccache-cache',
  'target',
  'third_party',
]);

const searchableExtensions = new Set([
  '',
  '.bazel',
  '.c',
  '.cc',
  '.cpp',
  '.css',
  '.go',
  '.h',
  '.hpp',
  '.html',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.kt',
  '.kts',
  '.md',
  '.nix',
  '.proto',
  '.py',
  '.rs',
  '.sh',
  '.sql',
  '.toml',
  '.ts',
  '.tsx',
  '.yaml',
  '.yml',
]);

/** Extensions treated as documentation by search_docs. */
const documentationExtensions = new Set(['.md', '.markdown', '.txt']);

/** Basenames (without extension) treated as documentation even without a known doc extension. */
const documentationBasenames = new Set([
  'readme',
  'agents',
  'soul',
  'changelog',
  'license',
  'contributing',
]);

export type InspectionMetadata = {
  used: number;
  remaining: number;
  limit: number;
};

/**
 * Shared inspection budget consumed by every list_files, read_file, and
 * search_code call. The snapshot returned by `consume` is attached to each
 * tool result so the model can see whether it may continue.
 */
export type StepBudget = {
  limit: number;
  used: number;
  remaining: number;
  consume(toolName: string): InspectionMetadata;
  /** Read the current budget state without consuming a step. */
  snapshot(): InspectionMetadata;
};

export type DebugEvent = {
  tool: string;
  status: 'success' | 'error';
  inputSummary: string;
  count?: number;
  inspection: InspectionMetadata;
};

export type DebugLogger = {
  log(event: DebugEvent): void;
};

/**
 * Safe debug logger controlled by REPO_ASSISTANT_DEBUG. Logs only the tool
 * name, a sanitized input summary, success/failure, a result count, and the
 * budget snapshot. Never logs file contents, absolute paths, keys, or model
 * reasoning.
 */
export function createDebugLogger(enabled: boolean): DebugLogger {
  return {
    log(event) {
      if (!enabled) return;
      const count =
        event.count === undefined ? '' : ` count=${event.count}`;
      console.error(
        `[repo-assistant] ${event.tool} ${event.status} input=${event.inputSummary}${count} used=${event.inspection.used} remaining=${event.inspection.remaining}/${event.inspection.limit}`,
      );
    },
  };
}

/**
 * Render a tool input as a short, safe JSON summary for debug logs. Inputs are
 * repository-relative, so no absolute host path should appear; the length cap
 * keeps log lines bounded regardless.
 */
export function summarizeInput(value: unknown): string {
  const text = JSON.stringify(value) ?? '';
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

/**
 * Wrap a tool failure with the post-consumption budget snapshot so the model
 * can see whether any inspection budget remains after the error.
 */
export function wrapWithBudget(
  error: unknown,
  tool: string,
  inspection: InspectionMetadata,
): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(
    `${tool} failed: ${message} (inspection: used=${inspection.used}, remaining=${inspection.remaining}, limit=${inspection.limit})`,
    { cause: error instanceof Error ? error : undefined },
  );
}

export type RepositoryEntry = {
  path: string;
  type: 'file' | 'directory';
  size?: number;
};

export function parseMaxSteps(value: string | undefined): number {
  if (value === undefined || value === '') return DEFAULT_MAX_STEPS;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
    throw new Error('REPO_ASSISTANT_MAX_STEPS must be an integer from 1 to 20.');
  }
  return parsed;
}

export function createStepBudget(max: number): StepBudget {
  let used = 0;
  return {
    limit: max,
    get used() {
      return used;
    },
    get remaining() {
      return max - used;
    },
    consume(toolName) {
      if (used >= max) {
        throw new Error(
          `Inspection budget exhausted before ${toolName}; answer with the evidence already collected. (used=${used}, remaining=0, limit=${max})`,
        );
      }
      used += 1;
      return { limit: max, used, remaining: max - used };
    },
    snapshot() {
      return { limit: max, used, remaining: max - used };
    },
  };
}

/**
 * Create a pass-through budget that returns snapshots without incrementing
 * the counter. Used when wrapping tools with the reliability layer: the
 * wrapper consumes the real budget once per logical call, while the inner
 * raw tool uses this pass-through so retries don't multiply consumption.
 */
export function createPassThroughBudget(budget: StepBudget): StepBudget {
  return {
    limit: budget.limit,
    get used() {
      return budget.used;
    },
    get remaining() {
      return budget.remaining;
    },
    consume: () => budget.snapshot(),
    snapshot: () => budget.snapshot(),
  };
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function shouldIgnore(name: string): boolean {
  return ignoredNames.has(name) || name.startsWith('bazel-');
}

export class RepositoryReader {
  constructor(readonly root: string) {}

  async resolve(relativePath = '.'): Promise<string> {
    if (relativePath.includes('\0') || path.isAbsolute(relativePath)) {
      throw new Error('Path must be relative to the configured repository.');
    }

    const candidate = path.resolve(this.root, relativePath);
    if (!isInside(this.root, candidate)) {
      throw new Error('Path escapes the configured repository.');
    }

    const canonical = await realpath(candidate);
    if (!isInside(this.root, canonical)) {
      throw new Error('Symbolic link escapes the configured repository.');
    }
    return canonical;
  }

  relative(absolutePath: string): string {
    const value = path.relative(this.root, absolutePath);
    return value === '' ? '.' : value.split(path.sep).join('/');
  }

  async list(relativePath: string, maxDepth: number): Promise<RepositoryEntry[]> {
    const start = await this.resolve(relativePath);
    const startStat = await stat(start);
    if (!startStat.isDirectory()) throw new Error('Requested path is not a directory.');

    const entries: RepositoryEntry[] = [];
    const walk = async (directory: string, depth: number): Promise<void> => {
      const children = await readdir(directory, { withFileTypes: true });
      children.sort((a, b) => a.name.localeCompare(b.name));

      for (const child of children) {
        if (shouldIgnore(child.name) || child.isSymbolicLink()) continue;
        const absolute = path.join(directory, child.name);
        if (child.isDirectory()) {
          entries.push({ path: this.relative(absolute), type: 'directory' });
          if (depth < maxDepth) await walk(absolute, depth + 1);
        } else if (child.isFile()) {
          const metadata = await stat(absolute);
          entries.push({
            path: this.relative(absolute),
            type: 'file',
            size: metadata.size,
          });
        }
        if (entries.length >= MAX_WALK_FILES) return;
      }
    };

    await walk(start, 0);
    return entries;
  }

  async readText(relativePath: string): Promise<string> {
    const absolute = await this.resolve(relativePath);
    const metadata = await stat(absolute);
    if (!metadata.isFile()) throw new Error('Requested path is not a file.');
    if (metadata.size > MAX_FILE_BYTES) {
      throw new Error(`File exceeds the ${MAX_FILE_BYTES}-byte read limit.`);
    }

    const handle = await open(absolute, 'r');
    try {
      const content = await handle.readFile();
      if (content.includes(0)) throw new Error('Binary files cannot be read.');
      return content.toString('utf8');
    } finally {
      await handle.close();
    }
  }

  async sourceFiles(relativePath = '.'): Promise<string[]> {
    const entries = await this.list(relativePath, 100);
    return entries
      .filter(
        (entry) =>
          entry.type === 'file' &&
          entry.size !== undefined &&
          entry.size <= MAX_FILE_BYTES &&
          searchableExtensions.has(path.extname(entry.path).toLowerCase()),
      )
      .slice(0, MAX_WALK_FILES)
      .map((entry) => entry.path);
  }

  /**
   * Return documentation files (Markdown, text, README/AGENTS/SOUL/CHANGELOG)
   * under the given path. Excludes the same ignored directories as
   * {@link sourceFiles}. Used by the `search_docs` tool.
   */
  async documentationFiles(relativePath = '.'): Promise<string[]> {
    const entries = await this.list(relativePath, 100);
    return entries
      .filter((entry) => {
        if (entry.type !== 'file' || entry.size === undefined || entry.size > MAX_FILE_BYTES) {
          return false;
        }
        const ext = path.extname(entry.path).toLowerCase();
        if (documentationExtensions.has(ext)) return true;
        const basename = path.basename(entry.path, ext).toLowerCase();
        return documentationBasenames.has(basename);
      })
      .slice(0, MAX_WALK_FILES)
      .map((entry) => entry.path);
  }
}

export async function createRepositoryReader(
  configuredPath: string,
): Promise<RepositoryReader> {
  const root = await realpath(path.resolve(configuredPath));
  const metadata = await stat(root);
  if (!metadata.isDirectory()) {
    throw new Error('REPOSITORY_PATH must point to a directory.');
  }
  return new RepositoryReader(root);
}
