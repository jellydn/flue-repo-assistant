# Flowly

> AI-native engineering assistant for modern development.

[![CI](https://github.com/jellydn/flowly/actions/workflows/ci.yml/badge.svg)](https://github.com/jellydn/flowly/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

**Flowly** is an AI-native engineering assistant built with [Flue](https://flueframework.com/) that helps you understand codebases, review pull requests, and automate development workflows. It features bounded, read-only repository analysis through an intelligent **observe → act → reflect** loop.

The default target is [jellydn/oak](https://github.com/jellydn/oak), a large
Rust-focused monorepo for privacy-preserving distributed systems.

## Features

- One Flue agent
- Five typed, read-only tools (`list_files`, `read_file`, `search_code`,
  `search_docs`, `retrieve` — semantic TF-IDF retrieval)
- A PR review agent (`agents/pr-reviewer.ts`) with review-specific tools and a
  trusted GitHub adapter — never auto-approves
- A GitHub event router (`github/events/`) that maps repository events to
  configured agents with declarative routes and filters
- Bounded investigation loop with evidence collection and deduplication
- Grounded answers with file citations and confidence levels
- One reusable Agent Skill
- Repository-relative path and symlink confinement
- Evidence-only answers with file and line citations
- A shared, configurable inspection budget
- No declared subagent profiles, persistence, deployment, or web UI

## How it works

```text
Question
   │
   ▼
┌──────────────┐       ┌────────────────────────────┐
│ Flue harness │──────▶│ list_files / read_file /  │
│ + LLM        │◀──────│ search_code / search_docs │
│              │       │ retrieve (semantic)       │
│              │       │ (read-only)               │
└──────┬───────┘       └─────────────┬──────────────┘
       │                             │
       │ reflect                     ▼
       │                    ┌───────────────────┐
       └───────────────────▶│ configured repo   │
                            │ (oak by default)  │
                            └───────────────────┘
```

## Prerequisites

- Node.js 22.19 or newer
- An LLM provider API key
- A local checkout of the repository to inspect

The default model is `openrouter/qwen/qwen3-coder`, which requires an
`OPENROUTER_API_KEY`. Set `REPO_ASSISTANT_MODEL` to any model listed in
[Flue's model catalog](https://flueframework.com/models.json) to use another
provider.

## Quick start

```bash
git clone https://github.com/jellydn/flowly.git
git clone --depth 1 https://github.com/jellydn/oak.git
cd flowly
npm install
cp .env.example .env
```

Add your provider key to `.env`. The example configuration already points to
`../oak`, so the two repositories should be siblings:

```text
parent/
├── flowly/
└── oak/
```

Run one question:

```bash
npm start -- --input '{"message":"What is the architecture of oak?"}'
```

Or invoke Flue directly:

```bash
npx flue run agents/repo-assistant.ts -m "Find the main application entry point for the Oak Containers hello-world host."
```

## Three test questions

These prompts exercise progressively richer tool use:

1. **Structure:** `What is the high-level architecture of oak?`
2. **Entry point:** `Find the main application entry point for the Oak Containers hello-world host.`
3. **Cross-file flow:** `Explain how an Oak Session binds attestation to its encrypted channel.`

Useful negative tests are `Where is authentication implemented?` and `Which
files contain database access?`. The agent should report what it searched and
avoid pretending that a conventional web-app authentication or database layer
exists.

## Configuration

| Variable                          | Default                       | Purpose                                                            |
| --------------------------------- | ----------------------------- | ------------------------------------------------------------------ |
| `REPOSITORY_PATH`                 | `../oak`                      | Only repository the tools may inspect                              |
| `REPO_ASSISTANT_MODEL`            | `openrouter/qwen/qwen3-coder` | Flue model specifier                                               |
| `REPO_ASSISTANT_MAX_STEPS`        | `8`                           | Shared inspection-call budget (1–20)                               |
| `REPO_ASSISTANT_DEBUG`            | `false`                       | Log one safe line per tool call                                    |
| `REPO_ASSISTANT_SEARCH_FALLBACK`  | `false`                       | Search tools fall back to `read_file` on transient failure         |
| `GITHUB_TOKEN`                    | _unset_                       | GitHub token for PR review automation                              |
| `GITHUB_REPOSITORY`               | _unset_                       | `owner/repo` for PR review automation                              |
| `PR_NUMBER`                       | _unset_                       | Pull request number to review                                      |
| `BASE_SHA`                        | _unset_                       | Base commit SHA for PR diff                                        |
| `HEAD_SHA`                        | _unset_                       | Head commit SHA for PR diff                                        |
| `PR_REVIEW_MAX_FILES`             | `30`                          | Max changed files reviewed                                         |
| `PR_REVIEW_MAX_DIFF_LINES`        | `4000`                        | Max unified-diff lines returned                                    |
| `PR_REVIEW_MAX_CONTEXT_READS`     | `20`                          | Max `read_file`/`search_code` calls                                |
| `PR_REVIEW_MAX_FINDINGS`          | `10`                          | Max findings submitted in review                                   |
| `PR_REVIEW_SPECIALISTS`           | all four roles                | Comma-separated correctness, security, testing, architecture roles |
| `PR_REVIEW_SPECIALIST_TIMEOUT_MS` | `30000`                       | Per-specialist timeout in milliseconds                             |

To inspect another checkout:

```bash
REPOSITORY_PATH=/absolute/path/to/repo \
  npm start -- --input '{"message":"Explain this project's architecture."}'
```

## PR Review configuration

The PR reviewer uses file-aware limits instead of the shared inspection budget.
Defaults: 30 files, 4000 diff lines, 20 context reads, and 10 findings.
The specialist-review seam supports correctness, security, testing, and
architecture roles. Enabled roles run concurrently, each result is validated
and attributed to its role, failures are isolated, and overlapping findings are
adjudicated deterministically before publication. Set `PR_REVIEW_SPECIALISTS`
to a comma-separated subset and `PR_REVIEW_SPECIALIST_TIMEOUT_MS` to bound each
runner. The seam is provider-agnostic because Flue currently declares one model
per agent render; a model-backed runner can be supplied without changing the
validation or adjudication layer.

In GitHub Actions, `.github/workflows/pr-review.yml` supplies the required
environment variables automatically. Locally:

```bash
GITHUB_TOKEN=… GITHUB_REPOSITORY=owner/repo PR_NUMBER=42 \
  BASE_SHA=… HEAD_SHA=… REPOSITORY_PATH=. OPENROUTER_API_KEY=… \
  npm run review-pr
```

Set `PR_REVIEW_MAX_FILES`, `PR_REVIEW_MAX_DIFF_LINES`,
`PR_REVIEW_MAX_CONTEXT_READS`, or `PR_REVIEW_MAX_FINDINGS` to override the
defaults. Findings are validated against the PR diff before posting; findings use the canonical P0-P3 severity scale, while older critical/high/medium/low values are normalized for compatibility. Findings without a changed-line citation are retained in the review body but are not posted inline. The review never auto-approves.

## How the bound works

Every `list_files`, `read_file`, `search_code`, `search_docs`, or `retrieve`
call consumes one shared inspection step. Tool results include `used` and
`remaining`; after that limit, all five inspection tools reject further calls
and the instructions
require the agent to answer from collected evidence. Each tool result carries an
`inspection` object of the shape `{ used, remaining, limit }` so the model can see whether
it may continue; errors are wrapped with the same snapshot. The agent also
configures a 120-second
submission deadline and allows only the initial execution attempt. Flue checks
the deadline cooperatively at turn boundaries; it does not preempt an in-flight
model request or custom tool, so elapsed runtime can exceed two minutes.

Flue 2.0 does **not** currently expose a public `maxSteps` or `maxTurns`
agent option. This project therefore bounds repository inspection calls—not
internal model turns—and documents that distinction rather than relying on a
nonexistent setting.

## Read-only guarantees

The agent's only application-data capabilities are five custom inspection
tools. They use Node's read-only filesystem APIs and expose no shell, write,
Git, or network operation. A restricted in-memory sandbox removes Flue's default
model-facing filesystem and shell tools.

Flue still appends its framework-owned `activate_skill` and `task` tools. This
project has no declared subagent profiles and explicitly instructs the agent not
to delegate. An implicit task would inherit the same five inspection tool
instances and shared budget; it cannot reset the inspection limit or access the
host checkout through the sandbox.

The repository boundary is application-controlled, not model-controlled:

- tool inputs accept only repository-relative paths;
- `..` traversal and absolute paths are rejected;
- canonical paths are checked after resolving symlinks;
- directory walks skip symlinks, VCS data, dependencies, generated build
  output, and caches;
- reads reject files over 1 MB and return at most 400 lines, while searches
  exclude files over 1 MB;
- searches return at most 50 literal matches.

Path checks assume the inspected checkout is stable while a tool call runs. Do
not use this educational agent against a repository tree being concurrently
modified by an untrusted process.

## PR Review agent

A second agent, `agents/pr-reviewer.ts`, reviews pull requests. It reuses the
read-only inspection tools (`read_file`, `search_code`) for surrounding context
and adds review-specific tools backed by a trusted GitHub/git boundary:

- `get_pr_metadata` — PR number, title, body, author, and the changed-file list
  (with skip flags for lockfiles, generated, vendored, and binary files).
- `get_pr_diff` — the unified diff, truncated to a configurable line limit.
- `list_changed_files` — per-file additions/deletions, status, and skip flags.
- `read_changed_file` — a bounded line range from the post-PR version of a file.
- `get_diff_hunks` — diff hunk line ranges for validating inline findings.
- `get_previous_review_state` — loads the previous review's SHA and findings
  from a hidden PR comment, or reports this is the first review.
- `get_incremental_diff` — the diff since the last reviewed SHA
  (`git diff prevSha...headSha`), or an empty result on first review.
- `get_review_context` — reads repository-specific documentation files
  (`AGENTS.md`, `CONTRIBUTING.md`, `.github/pull_request_template.md`,
  `.flue/review-instructions.md`, `.flue/repository-learnings.md`) to
  understand conventions, test commands, and past learnings.
- `submit_review` — posts one structured GitHub review with inline comments.

### Analysis vs. mutation separation

The model never holds the GitHub token or a generic shell. It emits a structured
`ReviewResult` through `submit_review`; a trusted adapter
(`github/adapter.ts`) re-validates the schema, confirms each finding's path is
in the PR diff, clamps line numbers to valid diff hunks, caps the finding count,
and posts exactly one review (`COMMENT` or `REQUEST_CHANGES`, never `APPROVE`)
through a thin `fetch`-based GitHub client (`github/client.ts`). PR data is
fetched by `git diff`/`git show` in trusted code (`review/pr-data.ts`), never
from the sandbox.

### Incremental review (Phase 2)

After each review, the trusted publisher persists a hidden state comment on the
PR containing the reviewed head SHA, the findings, and a timestamp:

```html
<!-- flue-review-state
{"reviewedHeadSha":"abc123","findings":[...],"reviewedAt":1700000000}
-->
```

On `synchronize` (new commits pushed), the reviewer loads this state and
computes an incremental diff (`git diff prevSha...headSha`) so it can focus on
what changed. The agent classifies each previous finding as `resolved`,
`still-present`, `obsolete`, or `uncertain`, and the publisher renders those
classifications in the review body with status icons (✅ ⚠️ 🗑️ ❓).

State comments are filtered to the expected bot account (`github-actions[bot]` by default, configurable via `REVIEW_BOT_LOGIN`) to prevent untrusted PR
participants from spoofing review state. State persistence is best-effort: if
saving state fails after a review was posted, the error is reported in
`validationIssues` but the run succeeds — the next run falls back to a full
review.

### Repository-specific memory (Phase 3)

The reviewer reads repository-specific documentation via `get_review_context`
at the start of each review. It looks for these files in the checked-out repo:

| File                               | Purpose                                                |
| ---------------------------------- | ------------------------------------------------------ |
| `AGENTS.md`                        | Project conventions, build/test commands, architecture |
| `CONTRIBUTING.md`                  | Contribution guidelines                                |
| `.github/pull_request_template.md` | PR template (what the author should provide)           |
| `.flue/review-instructions.md`     | Review-specific priorities and rules                   |
| `.flue/repository-learnings.md`    | Durable learnings accumulated from past reviews        |

Only files that exist are returned; each is capped at 200 lines. The content is
treated as **data** — it informs the review but never overrides the agent's
review duties or safety rules.

When the agent discovers a convention, test command, architectural pattern, or
common issue that would help future reviews, it includes `proposedLearnings` in
the `submit_review` output. The trusted publisher renders these in the review
body under a "Proposed repository learnings" section:

```markdown
### Proposed repository learnings

_Suggestions for `.flue/repository-learnings.md`. Review and apply manually —
the agent cannot modify files._

- **[convention]** Always use parameterized queries for SQL
  — _SQL injection found in 2 PRs_
```

The agent **never writes to `.flue/` directly**. A human reviews the proposed
learnings and manually adds approved ones to `.flue/repository-learnings.md`.
This keeps the learning loop transparent and human-controlled.

### File-aware limits

Instead of the shared 8-call inspection budget, the reviewer uses configurable
limits (`PR_REVIEW_MAX_FILES=30`, `PR_REVIEW_MAX_DIFF_LINES=4000`,
`PR_REVIEW_MAX_CONTEXT_READS=20`, `PR_REVIEW_MAX_FINDINGS=10`). Generated files,
lockfiles, snapshots, and vendored code are detected and skipped.

### Running it

A GitHub Actions workflow (`.github/workflows/pr-review.yml`) runs the reviewer
on `opened`, `reopened`, `synchronize`, and `ready_for_review` events. Locally:

```bash
GITHUB_TOKEN=… GITHUB_REPOSITORY=owner/repo PR_NUMBER=42 \
  BASE_SHA=… HEAD_SHA=… REPOSITORY_PATH=. OPENROUTER_API_KEY=… \
  npm run review-pr
```

The reviewer supports full reviews (opened / reopened / ready_for_review),
incremental reviews (synchronize), and repository-specific memory (Phase 3).
It never modifies code, pushes commits, or auto-approves.

## GitHub event router

`github/events/` is a dependency-light router that maps GitHub events to
configured agent IDs — the foundation for event-driven agent workflows (PR
review, CI repair, issue planning, implementation). It normalizes webhook /
GitHub Actions payloads into a stable internal event model, applies filters,
and decides which agent should handle each delivery. **Agent execution is out
of scope** — the router only decides; a workflow wires the actual dispatch.

### Configuration

A JSON config file maps routes to agents. Two shapes are accepted. The
shorthand map matches the issue's declarative design:

```json
{
  "routes": {
    "pull_request.opened": "review",
    "pull_request_review.submitted": "address-review",
    "issues.opened": "planner",
    "issues.labeled.implement": "implementation",
    "workflow_run.completed.failure": "ci-fix"
  }
}
```

Route keys are `event`, `event.action`, or `event.action.detail` (a label for
issue/PR events, a conclusion for `workflow_run`). The array form supports the
same keys plus explicit filters:

```json
{
  "routes": [
    {
      "event": "issues",
      "action": "labeled",
      "agent": "implementation",
      "filter": { "label": ["implement"], "actor": ["bot"] }
    }
  ]
}
```

Filters (`action`, `branch`, `label`, `actor`, `repository`, `conclusion`)
are AND-ed within a route; all must match. Invalid routes fail validation with
actionable errors naming the route key and the offending field, so a
misconfigured file is caught before any event is routed.

### Supported events

`pull_request`, `issues`, `issue_comment`, `pull_request_review`,
`pull_request_review_comment`, and `workflow_run`. Unsupported or malformed
events are ignored safely (exit 0 with a structured log line) rather than
crashing the workflow.

### Duplicate deliveries

Webhooks can be redelivered. The router remembers each dispatched event's
fingerprint — in memory by default, or persisted to a JSON file via
`EVENT_ROUTER_STORE` so a rerun of the same workflow doesn't double-dispatch.

### Running it

A GitHub Actions step runs `npm run route-event` with `GITHUB_EVENT_NAME` and
`GITHUB_EVENT_PATH` (both set automatically by Actions):

```bash
GITHUB_EVENT_NAME=${{ github.event_name }} \
GITHUB_EVENT_PATH=${{ github.event_path }} \
EVENT_ROUTER_CONFIG=event-router.config.json \
npm run route-event
```

The command prints the JSON decision to stdout and writes `agent=<id>` to
`$GITHUB_OUTPUT` on dispatch, so downstream steps can branch on the result
(see `.github/workflows/event-router.example` — copy it to a `.yml` file to
activate).

## Model evaluation benchmark

`eval/bench/` is a built-in evaluation framework inspired by
[OpenRouter ORI Eval](https://openrouter.ai/ori/eval): it compares models on
real repository-assistant workloads. A named suite of scenarios runs against
one or more models and produces reports with a quality score, latency, token
usage, cost, tool-call success rate, and patch applicability.

### Commands

```bash
npm run eval -- run              # run the bundled suite (deterministic, no LLM key)
npm run eval -- run --live --json  # provider-backed run
npm run eval -- run --judge-model openrouter/qwen/qwen3-coder  # score with an LLM judge
npm run eval -- compare <config.json>
npm run eval -- leaderboard
npm run eval -- report <runId>
npm run eval -- review <runId> --accept cap-1,cap-2 --reject cap-3
```

Deterministic mode reuses the capstone decision functions, so it is fully
reproducible without a provider key — safe for CI. `--live` calls a real model
through an OpenAI-compatible client; each model in the config resolves its own
provider, key env, and base URL (fields `provider`, `apiKeyEnv`, `baseUrl`)
with per-provider defaults in `eval/bench/providers.ts`. In live mode the
model drives the real investigation loop — each tool result is fed back to the
provider, which replies with the next action until it decides to answer —
rather than a single scripted retrieval. Results persist as JSON under
`eval/results/` (override with `FLUE_EVAL_RESULTS_DIR`).

The `review` subcommand records human accept/reject verdicts on a saved
report (ORI-Eval-style human-in-the-loop scoring) and recomputes the
acceptance rate; use `report` to see each scenario's reviewed status.

### Benchmark suites

A suite is a JSON file with a `suite` (scenarios + expected sources/keywords)
and `models` list. The bundled `eval/benchmarks/sample.json` runs the seven
capstone scenarios. Each `models[]` entry names its own `provider` (and
optionally `apiKeyEnv`/`baseUrl`), so one config can benchmark openrouter,
anthropic, and deepseek models against their own endpoints and keys. Custom
suites define their own prompts and expectations; scenario ids must map to
decision functions in deterministic mode (see `eval/bench/runner.ts` and the
bundled capstone deciders).

### Scoring

Each scenario is scored on four dimensions: tool success, citation accuracy,
retrieval relevance, and answer completeness. A judge (keyword-based by
default, or an LLM judge via `--judge-model <spec>`, built through the same
provider registry as the evaluated models) turns the dimensions into a 0..1
quality score. Reports record the judge used (`keyword` or the judge model id)
and each scenario's judge rationale. Token usage and cost prefer values reported by the
provider in `--live` mode (reported `prompt_tokens`/`completion_tokens` and
billed `total_cost`); they fall back to estimates from the pricing table in
`eval/bench/providers.ts` when a provider reports no usage. Each report
records `usageSource: provider | estimated` so you can tell which applied.
See `.github/workflows/eval.example` for a CI integration example.

## Day 16: Tools for agents

This section documents the Day 16 learning focus: **file tools, search tools,
API/tool contracts, correct tool selection, and feeding tool results back into
the agent loop.**

### When to select each tool

| Tool          | Select when                                                                                   |
| ------------- | --------------------------------------------------------------------------------------------- |
| `list_files`  | The repository structure or a file path is unknown.                                           |
| `search_docs` | You are looking for documented architecture, configuration, or design context.                |
| `search_code` | You are looking for a symbol, phrase, configuration, or implementation whose path is unknown. |
| `read_file`   | An exact file path is already known and surrounding context is needed.                        |
| `retrieve`    | You need conceptual retrieval over indexed source and docs, not a literal match.              |

Selection rules baked into the agent instructions and the
`analyzing-repositories` skill:

- Do not call `list_files` before every task.
- Do not read a file merely because its filename looks relevant.
- Search results are leads, not proof; read the relevant files before making
  architectural claims.
- Stop using tools once sufficient evidence has been collected.
- Answer directly when the question is conceptual and needs no repository
  evidence.

### How structured output feeds back into the loop

Every tool returns a structured JSON result plus an `inspection` budget
snapshot:

```json
{
  "path": "src/config.ts",
  "startLine": 1,
  "endLine": 4,
  "totalLines": 5,
  "content": "1: export const PORT = ...\n2: ...",
  "truncated": false,
  "inspection": { "used": 1, "remaining": 7, "limit": 8 }
}
```

The model observes the result, reflects on whether it has enough evidence, and
either calls the next tool or answers. `search_docs` and `search_code` results
name candidate files and line numbers; the model then calls `read_file` on the
strongest candidate. `inspection.remaining` tells the model whether it can keep
inspecting. When the budget is exhausted, every tool rejects further calls with
an error that repeats the snapshot, and the agent answers from collected
evidence.

### Evaluation scenarios

A tiny fixture repository and runner live in [`eval/`](./eval/README.md). The
five scenarios:

| Scenario               | Prompt                                                              | Expected tool pattern                                          |
| ---------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------- |
| A: direct read         | Read `src/config.ts` and explain how the port is configured.        | `read_file`                                                    |
| B: search then read    | Find where user authentication is implemented and explain the flow. | `search_code` → `read_file`                                    |
| C: structure discovery | Give me a high-level overview of this repository.                   | `list_files` → selected `read_file` calls                      |
| D: negative search     | Where is payment processing implemented?                            | `search_code` → `read_file`; report no evidence, do not invent |
| E: no unnecessary tool | What is the difference between listing files and searching code?    | Answer directly, no tool call                                  |

The expected tool sequences are simulated deterministically in
`tests/eval-scenarios.test.ts`. Run the live model-driven version with:

```bash
./eval/run-eval.sh   # requires a provider key; logs the observed tool sequence
```

### Safe debug logs

Enable with `REPO_ASSISTANT_DEBUG=true`. Each tool call logs one line to
stderr:

```
[repo-assistant] read_file success input={"path":"src/config.ts","startLine":1} count=4 used=1 remaining=7/8
```

Debug logs contain only the tool name, a sanitized input summary, success or
failure, a result count, and the budget snapshot. They never log provider API
keys, file contents, absolute repository paths, or model reasoning.

### Learning notes

1. Tool names and descriptions form an API for the model; precise contracts
   improve tool selection.
2. Search results are evidence candidates, while file reads provide the context
   needed for grounded conclusions.
3. Agent safety depends on controls outside the model, including path
   confinement, output bounds, timeouts, and a shared tool budget.

## Day 17: Planning vs Execution

This section documents the Day 17 learning focus: **separating reasoning from
execution**. Before calling any inspection tool, the agent declares a short
3–5 step plan, executes each step, then reflects on whether the plan was
optimal.

### Architecture

```text
User question
   │
   ▼
create_plan  ──▶  Plan stored (3–5 steps)
   │
   ▼
Execute each step
   ├── Step 1 → search_code
   ├── Step 2 → read_file
   ├── Step 3 → read_file
   └── Step 4 → answer (no tool call)
   │
   ▼
reflect_plan  ──▶  "Could Step 2 and 3 be merged?"
   │
   ▼
Final answer
```

If a step returns no results, `replan` generates a revised plan before
continuing—the stretch-goal dynamic replanning loop.

### Planning tools

| Tool           | Consumes budget? | Purpose                                           |
| -------------- | ---------------- | ------------------------------------------------- |
| `create_plan`  | No               | Declare 3–5 steps before executing                |
| `replan`       | No               | Revise the plan when a step returns no results    |
| `reflect_plan` | No               | State whether steps could be simplified or merged |

The five inspection tools (`list_files`, `read_file`, `search_code`,
`search_docs`, `retrieve`) still consume the shared budget as before. Planning
tools are
meta-tools that structure the agent's reasoning without inspecting the
repository.

### Programmatic planner and executor

The `planner/` module also provides deterministic functions for testing:

- `createPlan(question)` — rule-based plan generation (maps question patterns
  to tool sequences)
- `executePlan(plan, tools, signal?)` — runs each step against the matching
  tool and propagates cancellation
- `shouldReplan(results)` / `replan(plan, results)` — detects empty results
  and produces a revised plan
- `reflectOnPlan(plan, results, couldSimplify, note)` — counts statuses and
  records the reflection

These let tests run without a provider key while proving the same contracts
the model uses.

### Evaluation scenarios

The Day 16 evaluation scenarios still apply, now with a planning step first:

| Scenario               | Plan                                             | Execution                                                      |
| ---------------------- | ------------------------------------------------ | -------------------------------------------------------------- |
| A: direct read         | `create_plan` → [read_file, answer]              | `read_file`                                                    |
| B: search then read    | `create_plan` → [search_code, read_file, answer] | `search_code` → `read_file`                                    |
| C: structure discovery | `create_plan` → [list_files, read_file, answer]  | `list_files` → `read_file`                                     |
| D: negative search     | `create_plan` → [search_code, answer] → `replan` | `search_code` (empty) → `replan` → `search_code` → `read_file` |
| E: conceptual          | `create_plan` → [answer]                         | no tool call                                                   |

Run with debug to see the plan-execute-reflect cycle:

```bash
REPOSITORY_PATH=./eval/fixtures/sample-repo REPO_ASSISTANT_DEBUG=true \
  npm start -- --input '{"message":"Find where user authentication is implemented."}'
```

### Learning notes

1. Planning before tool execution reduced unnecessary tool calls and made the
   agent's behavior more predictable.
2. Separating the planner from the executor simplified debugging because each
   execution step could be inspected independently.
3. The initial 3–5 step plan was usually sufficient, but adding a simple
   replanning mechanism made the agent more robust when a search returned no
   useful results.

## Day 18: Production reliability

This section documents the Day 18 learning focus: **retries, timeouts, and
fallbacks**. The agent hardens one complete tool workflow (user question →
tool call → context → answer) so it fails safely and informs the user clearly.

### Reliability policy

| Aspect                | Value                        | Configurable via                  |
| --------------------- | ---------------------------- | --------------------------------- |
| Max attempts          | 3                            | `REPO_ASSISTANT_MAX_ATTEMPTS`     |
| Initial backoff       | 500 ms                       | `REPO_ASSISTANT_INITIAL_DELAY_MS` |
| Max backoff           | 5 s                          | `REPO_ASSISTANT_MAX_DELAY_MS`     |
| Per-operation timeout | 15 s                         | `REPO_ASSISTANT_TIMEOUT_MS`       |
| Backoff strategy      | Exponential with full jitter | —                                 |

#### Retried (transient) failures

- HTTP 408 (request timeout)
- HTTP 429 (rate limit)
- HTTP 500, 502, 503, 504
- Connection resets (`ECONNRESET`, `ECONNREFUSED`)
- Operation timeouts (`ETIMEDOUT`, `ECONNABORTED`)

#### Not retried (permanent) failures

- Authentication failures (HTTP 401)
- Permission errors (HTTP 403, `EACCES`, `EPERM`)
- File not found (HTTP 404, `ENOENT`)
- Invalid tool responses (malformed, missing fields, oversized)
- Schema validation failures

### Error classification

| Error type                 | Category              | Retryable | User message                                |
| -------------------------- | --------------------- | --------- | ------------------------------------------- |
| `TimeoutError`             | timeout               | yes       | "The repository service timed out."         |
| `RateLimitError`           | rate_limit            | yes       | "Rate limited. Please retry shortly."       |
| `AuthenticationError`      | authentication        | no        | "Check that the API key is valid."          |
| `PermissionError`          | permission            | no        | "Permission denied."                        |
| `NotFoundError`            | not_found             | no        | "File does not exist or is not accessible." |
| `InvalidToolResponseError` | invalid_tool_response | no        | "Unexpected response, result discarded."    |
| `ExternalServiceError`     | external_service      | yes       | "Service temporarily unavailable."          |

### Tool-output validation

Every tool result is validated before returning to the agent:

- **Missing required fields** → `InvalidToolResponseError`
- **Malformed shapes** → `InvalidToolResponseError`
- **Oversized content** (> 200k chars) → `InvalidToolResponseError`
- **Empty search results** → returned as a controlled result (not an error)

### Fallback behaviour

1. Attempt `search_code` (primary).
2. If search fails with a transient error and a known path is available,
   attempt `read_file` (fallback).
3. If both fail, return a clear partial-response message: "Repository search
   is temporarily unavailable and the fallback file read also failed."
4. Permanent errors (auth, permission, not-found) do **not** trigger fallback.
5. The agent never fabricates repository information.

The fallback seam lives in `reliability/fallback-tool.ts` (composition) and
`reliability/fallback.ts` (execution). The live agent enables it with
`REPO_ASSISTANT_SEARCH_FALLBACK=true`; the registry (`tools/inspection-
registry.ts`) composes `search_code`/`search_docs` with a `read_file` fallback
when the flag is set. Results carry `fallbackUsed: true` when the fallback
read supplied the content, and a `partialMessage` when it never ran or also
failed.

### User-facing errors

Errors returned to the model (and ultimately the user) are safe:

- No stack traces, provider internals, API keys, or raw error objects.
- Concise messages with retry guidance and partial-answer indicators.
- Examples: "The repository service timed out after three attempts."
  "I could not access that file because it does not exist."
  "Repository search is temporarily unavailable. I could not verify the answer."

### Observability

When `REPO_ASSISTANT_DEBUG=true`, each retry attempt logs a structured JSON
event to stderr:

```json
{
  "operation": "search_code",
  "attempt": 1,
  "maxAttempts": 3,
  "durationMs": 42,
  "errorCategory": "external_service",
  "retried": false,
  "fallbackUsed": false,
  "outcome": "error"
}
```

Logged fields: operation name, attempt number, max attempts, duration, error
category, whether retried, whether fallback was used, and final outcome. Never
logs secrets, tokens, file contents, or sensitive prompts.

### Failure-injection demo

```bash
./demo/reliability-demo.sh        # run all scenarios
./demo/reliability-demo.sh 1      # recover from transient failure
./demo/reliability-demo.sh 2      # timeout simulation
./demo/reliability-demo.sh 3      # malformed response
./demo/reliability-demo.sh 4      # baseline (no failures)
```

Environment variables for failure injection:

| Variable                           | Effect                                     |
| ---------------------------------- | ------------------------------------------ |
| `FAIL_FIRST_N_REQUESTS=2`          | First N calls fail with a simulated 503    |
| `SIMULATE_TOOL_TIMEOUT=true`       | Operations hang until the timeout fires    |
| `SIMULATE_MALFORMED_RESPONSE=true` | Return garbled output instead of real data |
| `FAIL_OPERATION=search_code`       | Restrict failure to one operation          |

### Budget interaction

Retries do **not** consume additional inspection budget. The reliability
wrapper consumes one budget slot per logical call; retry attempts use a
pass-through budget internally. This prevents retries from accidentally
multiplying budget consumption.

### Learning notes

1. Retrying only transient failures with exponential backoff and jitter
   prevented cascading failures while keeping latency bounded.
2. Typed, structured errors with user-safe messages kept provider internals
   and stack traces out of user-facing responses.
3. A search→read fallback preserved usefulness when the primary tool failed,
   while permanent errors failed fast instead of hiding configuration problems.

## Day 21: Doc-aware repository agent

This section documents the Day 21 learning focus: **combining documentation
search, source-code search, and file-reading into a bounded investigation loop
that produces grounded answers with citations.**

### What the doc-aware agent does

A user asks a repository question (e.g., "How does authentication work?"). The
agent:

1. Creates a short investigation plan.
2. Searches documentation files (README, AGENTS, CHANGELOG, docs/**, Markdown).
3. Searches the source code.
4. Reads the most relevant files.
5. Stops when it has enough evidence.
6. Returns a concise answer with exact file references.
7. Clearly states when the evidence is insufficient.

### Architecture

```text
User question
     │
     ▼
Planner / Agent loop (max 5 iterations)
     │
     ├──▶ search_docs   (documentation files: README, AGENTS, docs/**)
     │
     ├──▶ search_code   (source files: .ts, .js, .py, etc.)
     │
     ├──▶ read_file     (specific file with line range)
     │
     └──▶ list_files    (structure discovery)
     │
     ▼
Evidence collector (deduplicated, size-limited)
     │
     ▼
Grounded answer with citations + confidence
```

### Available tools

| Tool           | Consumes budget? | Purpose                                         |
| -------------- | ---------------- | ----------------------------------------------- |
| `search_docs`  | Yes              | Search documentation files for a literal string |
| `search_code`  | Yes              | Search source files for a literal string        |
| `read_file`    | Yes              | Read a bounded line range from a known file     |
| `list_files`   | Yes              | List files and directories under a path         |
| `retrieve`     | Yes              | Semantic retrieval over the repository index    |
| `create_plan`  | No               | Declare a 3–5 step plan before executing        |
| `replan`       | No               | Revise the plan when a step returns no results  |
| `reflect_plan` | No               | Reflect on whether steps could be simplified    |

`search_docs` searches files with documentation extensions (`.md`, `.markdown`,
`.txt`) and documentation basenames (README, AGENTS, SOUL, CHANGELOG,
CONTRIBUTING, LICENSE). It excludes the same ignored directories as
`search_code` (node_modules, dist, .git, etc.).

### Planning-loop limits

- Maximum **5 investigation iterations** (tool calls).
- No repeated identical tool + arguments calls (blocked by the call tracker).
- Evidence is deduplicated by file path + line range.
- The loop stops early when the decider determines sufficient evidence exists.
- Failed tool calls become error entries — they never crash the loop.
- Budget exhaustion stops the loop immediately.

### How citations work

Every key finding in the final answer includes a citation in the format
`path/to/file.ts:startLine-endLine`. The agent only cites files whose content
was actually retrieved by a tool in the current run — it never fabricates
citations.

Confidence levels:

| Level        | When                                                                    |
| ------------ | ----------------------------------------------------------------------- |
| High         | Read evidence from 2+ files, or both documentation and code corroborate |
| Medium       | Read evidence from a single file                                        |
| Low          | Only search leads (no confirming file reads)                            |
| Insufficient | No relevant evidence found                                              |

When confidence is not High, the answer explains what evidence is missing.
When evidence is insufficient, the agent explicitly says so rather than
hallucinating.

### How to run the demo

```bash
./demo/doc-aware-demo.sh              # all scenarios
./demo/doc-aware-demo.sh auth         # only auth-related scenarios
./demo/doc-aware-demo.sh payment      # only the negative-search scenario
```

The demo uses deterministic decision functions (no LLM required) and the
bundled fixture repository. Each scenario displays the question, tools used,
cited files, answer, confidence, and whether the run completed successfully.

Sample output:

```
Scenario: Authentication flow (docs + code)
  Tools used:   search_docs → search_code → read_file
  Cited files:  AGENTS.md:1-7, src/auth.ts:1-7, docs/architecture.md:7
  Confidence:   High
  Success:      true
```

### How to run tests

```bash
npm test                              # all tests
npx tsx --test tests/doc-aware.test.ts  # only Day 21 tests
```

The Day 21 test suite covers:

1. Documentation search finds relevant Markdown files.
2. Documentation search excludes irrelevant directories.
3. The agent uses documentation and code evidence together.
4. Repeated identical tool calls are blocked.
5. The loop stops at the configured maximum.
6. The agent stops early when sufficient evidence exists.
7. Failed tool calls do not crash the loop.
8. Answers contain file citations.
9. The agent returns insufficient evidence instead of hallucinating.
10. Confidence reflects the available evidence.

### Known limitations

- The investigation loop uses deterministic decision functions for testing.
  A live LLM run requires a provider API key and is non-deterministic.
- Flue does not expose a public `maxSteps`/`maxTurns` option; the 5-iteration
  limit is enforced by the programmatic loop, not by Flue's runtime.
- `search_docs` treats `.md`, `.markdown`, and `.txt` as documentation. Other
  text formats (`.rst`, `.org`) are not yet included.
- Evidence excerpts are truncated to 500 characters; very long file reads may
  lose detail in the evidence collector.
- The confidence heuristic is rule-based, not semantic; it does not assess
  whether the evidence actually answers the question.

### Learning notes

1. Combining documentation and code evidence produces more grounded answers
   than either source alone — docs explain intent, code confirms implementation.
2. A bounded investigation loop with duplicate-call blocking and early stopping
   prevents wasted tool calls while ensuring sufficient evidence collection.
3. Structured citations and confidence levels make the agent's answers
   auditable — users can verify every claim against the cited file.

## Project structure

```text
flowly/
├── agents/
│   ├── repo-assistant.ts       # general inspection agent
│   └── pr-reviewer.ts          # PR review agent (never auto-approves)
├── github/
│   ├── adapter.ts              # trusted review publisher
│   ├── client.ts               # thin GitHub REST client
│   └── events/                 # event router: config, router, dedupe, logger
├── review/
│   ├── diff.ts                 # unified-diff parser
│   ├── filters.ts              # skip lockfiles / generated / vendored
│   ├── limits.ts               # file-aware review limits
│   ├── pr-data.ts              # git + GitHub PR data source
│   ├── review-state.ts         # persistent review state
│   ├── review-state-store.ts   # state via filtered PR comment
│   ├── review-tools.ts         # review-specific tool factories
│   └── schema.ts               # ReviewResult Valibot schema
├── scripts/
│   ├── flue-eval.ts            # eval benchmark CLI (npm run eval)
│   ├── review-pr.ts            # CI entrypoint (npm run review-pr)
│   └── route-event.ts          # event router CLI (npm run route-event)
├── investigation/
│   ├── answer.ts
│   ├── call-tracker.ts
│   ├── evidence.ts
│   ├── loop.ts
│   └── types.ts
├── index/
│   └── repository-indexer.ts   # lazy TF-IDF index backing `retrieve`
├── planner/
│   ├── plan-run.ts             # plan lifecycle + programmatic executor + replan
│   ├── plan-store.ts
│   ├── planner.ts              # create_plan tool
│   ├── reflection.ts           # reflect_plan tool
│   └── types.ts
├── reliability/
│   ├── errors.ts
│   ├── failure-injection.ts
│   ├── fallback.ts
│   ├── fallback-tool.ts           # search→read fallback composition seam
│   ├── observability.ts
│   ├── resilient-tool.ts       # retry + timeout + validation wrapper
│   ├── retry.ts
│   └── validation.ts
├── tools/
│   ├── contracts.ts            # tool names + shared limits
│   ├── inspection-registry.ts  # ordered composition of the five tools
│   ├── list-files.ts
│   ├── read-file.ts
│   ├── repository-search.ts    # bounded literal search
│   ├── repository.ts           # RepositoryReader + StepBudget
│   ├── result-stats.ts         # shared tool-result counting helper
│   ├── retrieve.ts             # semantic retrieval over the index
│   ├── search-code.ts
│   ├── search-docs.ts
│   ├── search-utils.ts
│   └── search.ts               # scope-parameterized search seam
├── skills/
│   └── analyzing-repositories/
│       └── SKILL.md
├── tests/
│   ├── doc-aware.test.ts
│   ├── eval-scenarios.test.ts
│   ├── fallback-tool.test.ts
│   ├── helpers.ts
│   ├── planner.test.ts
│   ├── reliability.test.ts
│   ├── repository.test.ts
│   └── tools.test.ts
├── demo/
│   ├── capstone-demo.sh
│   ├── capstone-demo.ts        # index → retrieve → cite → evaluate
│   ├── doc-aware-demo.sh
│   ├── doc-aware-demo.ts
│   └── reliability-demo.sh
├── eval/
│   ├── README.md
│   ├── bench/                  # ORI-Eval-inspired benchmark framework
│   ├── benchmarks/sample.json  # bundled 7-scenario suite
│   ├── capstone-eval.ts        # Day 30 capstone evaluation
│   ├── run-capstone-eval.sh
│   ├── run-eval.sh
│   └── fixtures/sample-repo/   # bundled evaluation fixture
├── docs/
│   ├── adr/                    # architecture decision records (0001–0004)
│   └── index.html              # landing page (hand-maintained)
├── .planning/
│   └── codebase/               # codemap: STACK, ARCHITECTURE, CONCERNS, …
├── sandbox.ts
├── app.ts                      # Flue 2 route map
├── flue.config.ts
├── vite.config.ts              # Flue 2 Vite build integration
└── README.md
```

## Development

Run the local checks (`typecheck`, `test`, `build`, in that order):

```bash
npm run check
```

- `npm run typecheck` — `tsc`
- `npm test` — `tsx --test tests/*.test.ts` (Node's built-in test runner)
- `npm run build` — `vite build` (emits `dist/`, gitignored)

## Learning notes

This agent loop is not a hard-coded sequence. Flue sends the question, tools,
instructions, and skill metadata to the model. The model observes the question,
chooses a tool and its arguments, receives the result, reflects on whether it
has enough evidence, and either acts again or returns an answer. The harness
validates typed tool input and records each result in the session context.

The important safety controls live outside the model: a narrow capability set,
path confinement, bounded output, a finite inspection budget, and a cooperative
submission deadline.

## Resources

- [Flue quick start](https://flueframework.com/docs/getting-started/quickstart/)
- [Flue tools](https://flueframework.com/docs/guide/tools/)
- [ReAct paper](https://arxiv.org/abs/2210.03629)
- [OpenAI agents overview](https://platform.openai.com/docs/guides/agents)

## License

MIT
