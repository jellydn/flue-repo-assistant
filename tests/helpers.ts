import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Build a small, deterministic fixture repository in a temporary directory.
 * Used by tool and evaluation tests instead of the real Oak checkout.
 *
 * Layout:
 *   README.md                       project overview (mentions auth, config)
 *   AGENTS.md                       coding conventions
 *   docs/architecture.md            architecture documentation
 *   src/index.ts                    application entry point (calls start + login)
 *   src/config.ts                   configuration module (PORT)
 *   src/auth.ts                     authentication module (calls user-service)
 *   src/services/user-service.ts    service calling another module
 *   src/utils/notes.md              unrelated file with misleading keywords
 *   node_modules/ignored.js         dependency noise that must be skipped
 */
export async function createSampleRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'flue-repo-assistant-'));
  await mkdir(path.join(root, 'src', 'services'), { recursive: true });
  await mkdir(path.join(root, 'src', 'utils'), { recursive: true });
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await writeFile(
    path.join(root, 'README.md'),
    [
      '# Sample Repository',
      '',
      'A small demo application with authentication and configuration.',
      '',
      '## Features',
      '',
      '- Application entry point in `src/index.ts`',
      '- Authentication via `src/auth.ts` using token-based login',
      '- Configuration via `src/config.ts` with environment variable PORT',
      '- User service in `src/services/user-service.ts` issues tokens',
      '',
      '## Quick start',
      '',
      'Set the PORT environment variable and run `src/index.ts`.',
      '',
      '## Architecture',
      '',
      'See [docs/architecture.md](docs/architecture.md) for details.',
      '',
    ].join('\n'),
  );
  await writeFile(
    path.join(root, 'AGENTS.md'),
    [
      '# Agent Guidelines',
      '',
      '- Use TypeScript with explicit types.',
      '- Authentication is token-based; see src/auth.ts.',
      '- Configuration uses environment variables; see src/config.ts.',
      '- The PORT environment variable defaults to 3000.',
      '',
    ].join('\n'),
  );
  await writeFile(
    path.join(root, 'docs', 'architecture.md'),
    [
      '# Architecture',
      '',
      'The application follows a simple layered design:',
      '',
      '1. **Entry point** (`src/index.ts`): starts the server and triggers login.',
      '2. **Configuration** (`src/config.ts`): reads PORT from environment.',
      '3. **Authentication** (`src/auth.ts`): implements login using the user service.',
      '4. **User service** (`src/services/user-service.ts`): issues authentication tokens.',
      '',
      'The authentication flow: index.ts calls login() in auth.ts, which calls',
      'issueToken() in user-service.ts to generate a token.',
      '',
    ].join('\n'),
  );
  await writeFile(
    path.join(root, 'src', 'index.ts'),
    [
      'import { start } from "./config.ts";',
      'import { login } from "./auth.ts";',
      'start();',
      'login();',
      '',
    ].join('\n'),
  );
  await writeFile(
    path.join(root, 'src', 'config.ts'),
    [
      'export const PORT = Number(process.env.PORT ?? 3000);',
      'export function start() {',
      '  console.log("listening on", PORT);',
      '}',
      '',
    ].join('\n'),
  );
  await writeFile(
    path.join(root, 'src', 'auth.ts'),
    [
      'import { issueToken } from "./services/user-service.ts";',
      'export function login() {',
      '  const token = issueToken("user");',
      '  return token;',
      '}',
      '',
    ].join('\n'),
  );
  await writeFile(
    path.join(root, 'src', 'services', 'user-service.ts'),
    [
      'export function issueToken(user: string) {',
      '  return `${user}:token`;',
      '}',
      '',
    ].join('\n'),
  );
  await writeFile(
    path.join(root, 'src', 'utils', 'notes.md'),
    [
      '# Notes',
      '',
      'Ideas: payment, billing, checkout. (misleading keywords, no implementation)',
      '',
    ].join('\n'),
  );
  await mkdir(path.join(root, 'node_modules'));
  await writeFile(
    path.join(root, 'node_modules', 'ignored.js'),
    'export const login = "noise";\n',
  );
  return root;
}

export async function removeRepo(root: string): Promise<void> {
  await rm(root, { force: true, recursive: true });
}
