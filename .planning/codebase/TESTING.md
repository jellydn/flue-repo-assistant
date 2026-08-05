# Testing Patterns

**Analysis Date:** 2026-08-04

## Test Framework

**Runner:**

- Node's built-in test runner (node:test) executed via tsx
- Config: none (globs `tests/*.test.ts` from `package.json`)

**Assertion Library:**

- `node:assert/strict`

**Run Commands:**

```bash
npm test                        # all tests (tsx --test tests/*.test.ts)
npm run check                   # typecheck + test + build (CI runs this)
npx tsx --test tests/<file>.test.ts   # single file
```

## Test File Organization

**Location:**

- Separate `tests/` directory — tests are never co-located with source

**Naming:**

- `<module-or-area>.test.ts` (e.g. `repository.test.ts`, `event-router.test.ts`, `bench-runner.test.ts`, `flue-eval-cli.test.ts`)

**Structure:**

```
tests/
├── helpers.ts                  # fixture builder + tool invocation
├── *.test.ts                   # 29 test files
```

## Test Structure

**Suite Organization:**

```typescript
import assert from 'node:assert/strict';
import test from 'node:test';
import { thing } from '../path/to/module.ts';

test('describe behavior', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'prefix-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // ... arrange, act, assert with assert.equal / assert.ok / assert.rejects
});
```

**Patterns:**

- Setup: fixtures built in `tests/helpers.ts` (`createSampleRepo()` writes a deterministic repo to a temp dir)
- Teardown: `t.after()` removes temp dirs
- Assertion: `assert.equal/ok/deepEqual/rejects`; positive + negative cases per behavior (e.g. citation present AND absent)

## Mocking

**Framework:** None (no sinon/jest) — mocking is done with plain objects and spy closures

**Patterns:**

```typescript
let calls = 0;
const modelCall = async () => {
  calls += 1;
  return 'reply';
};
// ... assert.equal(calls, 1, 'modelCall must be invoked once per scenario')
```

**What to Mock:**

- Model calls (`modelCall`), decision functions (`DecisionFn` mocks drive the deterministic loop), provider clients (e.g. `createStaticModelCall`), GitHub REST responses in adapter tests

**What NOT to Mock:**

- The real investigation loop, real tools against `createSampleRepo()` fixtures, real file stores against temp dirs — integration-style coverage without a live LLM

## Fixtures and Factories

**Test Data:**

```typescript
export async function createSampleRepo(): Promise<string> {
  // writes README.md, AGENTS.md, docs/architecture.md, src/{index,config,auth}.ts,
  // src/services/user-service.ts, src/utils/notes.md, node_modules/ignored.js
}
```

**Location:**

- `tests/helpers.ts` (programmatic fixture); `eval/fixtures/sample-repo/` (bundled on-disk fixture used by eval/demo)

## Coverage

**Requirements:** None enforced (no coverage gate in CI)

**View Coverage:**

```bash
# not configured; no c8/v8 coverage script
```

## Test Types

**Unit Tests:**

- Scope: individual modules — tools, contracts, planner, reliability, review schema/filters/limits/diff, event-router config/dedupe, bench schema/metrics/store/judge/providers
- Approach: direct imports, real fixtures, no live network

**Integration Tests:**

- Scope: tool pipelines against the sample fixture (`tools.test.ts`, `eval-scenarios.test.ts`, `doc-aware.test.ts`, `repository-search.test.ts`), full event-router flow (`event-router.test.ts`), benchmark runner end-to-end (`bench-runner.test.ts`, `flue-eval-cli.test.ts` — the latter spawns the actual CLI via `spawnSync`), GitHub adapter (mock fetch)
- Approach: deterministic deciders and static model calls keep them key-free and reproducible

**E2E Tests:**

- Not used; live model runs are opt-in scripts/demos (`eval/run-eval.sh`, `demo/*.sh`, `npm run eval -- run --live`), not CI tests

## Common Patterns

**Async Testing:**

```typescript
test('loadSuiteFromFile loads and validates JSON', async (t) => {
  const dir = await mkdtemp(...);
  t.after(() => rm(...));
  await writeFile(file, JSON.stringify(sampleSuite));
  const loaded = await loadSuiteFromFile(file);
  assert.ok(loaded.ok);
});
```

**Error Testing:**

```typescript
await assert.rejects(
  () => runBenchmark(suite, model, { mode: 'deterministic', deciders: {} }),
  /No decision function for scenario "cap-1"/,
);
```

**CLI smoke test:**

```typescript
const result = spawnSync('npx', ['tsx', 'scripts/flue-eval.ts', 'run', configPath, '--json'], {
  cwd,
  env,
  timeout,
});
assert.equal(result.status, 0, result.stderr);
const output = JSON.parse(result.stdout);
```

---

_Testing analysis: 2026-08-04_
