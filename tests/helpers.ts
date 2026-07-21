import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Build a small, deterministic fixture repository in a temporary directory.
 * Used by tool and evaluation tests instead of the real Oak checkout.
 *
 * Layout:
 *   src/index.ts              application entry point (calls start + login)
 *   src/config.ts             configuration module (PORT)
 *   src/auth.ts               authentication module (calls user-service)
 *   src/services/user-service.ts  service calling another module
 *   src/utils/notes.md        unrelated file with misleading keywords
 *   node_modules/ignored.js   dependency noise that must be skipped
 */
export async function createSampleRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'flue-repo-assistant-'));
  await mkdir(path.join(root, 'src', 'services'), { recursive: true });
  await mkdir(path.join(root, 'src', 'utils'), { recursive: true });
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
