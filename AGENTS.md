# AGENTS.md

Read-only repository-analysis agent built on [Flue](https://flueframework.com/) (1.0 beta). The agent observes a single configured repo via three custom read-only tools, then answers with file/line citations.

## Commands

- `npm start -- --input '{"message":"<question>"}'` — run the agent (wraps `flue run repo-assistant`).
- `npx flue run repo-assistant --input '{"message":"..."}'` — invoke Flue directly.
- `npm run check` — runs `typecheck && test && build` in that exact order. CI runs only this.
- `npm test` — `tsx --test tests/*.test.ts` (Node's built-in test runner, not a separate framework).
- `npm run build` — `flue build` (emits `dist/`, already gitignored).

## Setup & runtime quirks

- Requires **Node.js >= 22.19.0** (CI pins `22.19.0`). Older Node fails.
- Needs an LLM key: `cp .env.example .env` and set `OPENROUTER_API_KEY` (default model is `openrouter/qwen/qwen3-coder`). `REPO_ASSISTANT_MODEL` accepts any specifier from Flue's models.json.
- `REPOSITORY_PATH` defaults to `../oak` and is resolved to an absolute, realpath'd directory. The inspected repo must be a sibling checkout (README's `parent/{flue-repo-assistant,oak}` layout). Override with an absolute path when targeting another repo.

## Architecture (not obvious from filenames)

- `agents/repo-assistant.ts` is the only agent and the entrypoint. It builds the tools, sandbox, skill, and instructions at runtime from env vars.
- The three tools in `tools/` (`list-files`, `read-file`, `search-code`) are created by factory functions in `tools/repository.ts`, which holds the real `RepositoryReader` (path confinement + budgets) and the shared `StepBudget`.
- `sandbox.ts` replaces Flue's default filesystem/shell tools with an empty toolset — repository access exists ONLY through the three custom tools. The agent cannot write, run shell, or touch Git/network.
- `skills/analyzing-repositories/SKILL.md` is loaded via `import ... with { type: 'skill' }` — keep it as a `.md` import; don't convert it to a plain module.

## Constraints worth knowing

- Flue 1.0 beta has no public `maxSteps`/`maxTurns` agent option. This project bounds **tool inspection calls** (1–20, via `REPO_ASSISTANT_MAX_STEPS`, default 8), NOT model turns. Don't look for a nonexistent maxTurns setting.
- `createRepositoryReader` throws at startup if `REPOSITORY_PATH` isn't a directory; the budget throws "Inspection budget exhausted" after the limit. Both are expected guardrails, not bugs.
- Read tools reject files >1 MB, return ≤400 lines on read, ≤50 matches on search, and skip symlinks / VCS / deps / build output (see `ignoredNames` in `tools/repository.ts`).
- The agent instructions forbid delegation (`task`/subagents) — there are no declared subagent profiles. Don't add them.
- `dist/`, `.flue-vite/`, and `.env` are build/runtime artifacts (gitignored). The `.amp/` dir is unrelated tooling state.
