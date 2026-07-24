# flue-repo-assistant

> A bounded, read-only repository analysis agent built with [Flue](https://flueframework.com/).

[![CI](https://github.com/jellydn/flue-repo-assistant/actions/workflows/ci.yml/badge.svg)](https://github.com/jellydn/flue-repo-assistant/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

`flue-repo-assistant` is a small, read-only agent for learning the core agent
loop: **observe → act → reflect**. It uses Flue to decide when to list files,
read source, search code, or answer with the evidence already collected.

The default target is [jellydn/oak](https://github.com/jellydn/oak), a large
Rust-focused monorepo for privacy-preserving distributed systems.

## Features

- One Flue agent
- Four typed, read-only tools (`list_files`, `read_file`, `search_code`, `search_docs`)
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
│ + LLM        │◀──────│ search_code (read-only)   │
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
git clone https://github.com/jellydn/flue-repo-assistant.git
git clone --depth 1 https://github.com/jellydn/oak.git
cd flue-repo-assistant
npm install
cp .env.example .env
```

Add your provider key to `.env`. The example configuration already points to
`../oak`, so the two repositories should be siblings:

```text
parent/
├── flue-repo-assistant/
└── oak/
```

Run one question:

```bash
npm start -- --input '{"message":"What is the architecture of oak?"}'
```

Or invoke Flue directly:

```bash
npx flue run repo-assistant \
  --input '{"message":"Find the main application entry point for the Oak Containers hello-world host."}'
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

| Variable                   | Default                       | Purpose                                    |
| -------------------------- | ----------------------------- | ------------------------------------------ |
| `REPOSITORY_PATH`          | `../oak`                      | Only repository the tools may inspect      |
| `REPO_ASSISTANT_MODEL`     | `openrouter/qwen/qwen3-coder` | Flue model specifier                       |
| `REPO_ASSISTANT_MAX_STEPS` | `8`                           | Shared list/read/search call budget (1–20) |
| `REPO_ASSISTANT_DEBUG`     | `false`                       | Log one safe line per tool call            |

To inspect another checkout:

```bash
REPOSITORY_PATH=/absolute/path/to/repo \
  npm start -- --input '{"message":"Explain this project's architecture."}'
```

## How the bound works

Every `list_files`, `read_file`, or `search_code` call consumes one shared
inspection step. Tool results include `used` and `remaining`; after the limit,
all three tools reject further calls and the instructions require the agent to
answer from collected evidence. Each tool result carries an `inspection`
object of the shape `{ used, remaining, limit }` so the model can see whether
it may continue; errors are wrapped with the same snapshot. The agent also
configures a 120-second
submission deadline and allows only the initial execution attempt. Flue checks
the deadline cooperatively at turn boundaries; it does not preempt an in-flight
model request or custom tool, so elapsed runtime can exceed two minutes.

Flue 1.0 beta does **not** currently expose a public `maxSteps` or `maxTurns`
agent option. This project therefore bounds repository inspection calls—not
internal model turns—and documents that distinction rather than relying on a
nonexistent setting.

## Read-only guarantees

The agent's only application-data capabilities are three custom tools. They use
Node's read-only filesystem APIs and expose no shell, write, Git, or network
operation. A restricted in-memory sandbox removes Flue's default model-facing
filesystem and shell tools.

Flue still appends its framework-owned `activate_skill` and `task` tools. This
project has no declared subagent profiles and explicitly instructs the agent not
to delegate. An implicit task would inherit the same three tool instances and
shared budget; it cannot reset the inspection limit or access the host checkout
through the sandbox.

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

## Day 16: Tools for agents

This section documents the Day 16 learning focus: **file tools, search tools,
API/tool contracts, correct tool selection, and feeding tool results back into
the agent loop.**

### When to select each tool

| Tool | Select when |
| ---- | ----------- |
| `list_files` | The repository structure or a file path is unknown. |
| `search_code` | You are looking for a symbol, phrase, configuration, or implementation whose path is unknown. |
| `read_file` | An exact file path is already known and surrounding context is needed. |

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
either calls the next tool or answers. `search_code` results name candidate
files and line numbers; the model then calls `read_file` on the strongest
candidate. `inspection.remaining` tells the model whether it can keep
inspecting. When the budget is exhausted, every tool rejects further calls with
an error that repeats the snapshot, and the agent answers from collected
evidence.

### Evaluation scenarios

A tiny fixture repository and runner live in [`eval/`](./eval/README.md). The
five scenarios:

| Scenario | Prompt | Expected tool pattern |
| -------- | ------ | --------------------- |
| A: direct read | Read `src/config.ts` and explain how the port is configured. | `read_file` |
| B: search then read | Find where user authentication is implemented and explain the flow. | `search_code` → `read_file` |
| C: structure discovery | Give me a high-level overview of this repository. | `list_files` → selected `read_file` calls |
| D: negative search | Where is payment processing implemented? | `search_code` → `read_file`; report no evidence, do not invent |
| E: no unnecessary tool | What is the difference between listing files and searching code? | Answer directly, no tool call |

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

| Tool | Consumes budget? | Purpose |
| ---- | ---------------- | ------- |
| `create_plan` | No | Declare 3–5 steps before executing |
| `replan` | No | Revise the plan when a step returns no results |
| `reflect_plan` | No | State whether steps could be simplified or merged |

The three inspection tools (`list_files`, `read_file`, `search_code`) still
consume the shared budget as before. Planning tools are meta-tools that
structure the agent's reasoning without inspecting the repository.

### Programmatic planner and executor

The `planner/` module also provides deterministic functions for testing:

- `createPlan(question)` — rule-based plan generation (maps question patterns
  to tool sequences)
- `executePlan(plan, tools, budget, debug)` — runs each step against the
  matching tool
- `shouldReplan(results)` / `replan(plan, results)` — detects empty results
  and produces a revised plan
- `reflectOnPlan(plan, results, couldSimplify, note)` — counts statuses and
  records the reflection

These let tests run without a provider key while proving the same contracts
the model uses.

### Evaluation scenarios

The Day 16 evaluation scenarios still apply, now with a planning step first:

| Scenario | Plan | Execution |
| -------- | ---- | --------- |
| A: direct read | `create_plan` → [read_file, answer] | `read_file` |
| B: search then read | `create_plan` → [search_code, read_file, answer] | `search_code` → `read_file` |
| C: structure discovery | `create_plan` → [list_files, read_file, answer] | `list_files` → `read_file` |
| D: negative search | `create_plan` → [search_code, answer] → `replan` | `search_code` (empty) → `replan` → `search_code` → `read_file` |
| E: conceptual | `create_plan` → [answer] | no tool call |

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

| Aspect | Value | Configurable via |
| ------ | ----- | ---------------- |
| Max attempts | 3 | `REPO_ASSISTANT_MAX_ATTEMPTS` |
| Initial backoff | 500 ms | `REPO_ASSISTANT_INITIAL_DELAY_MS` |
| Max backoff | 5 s | `REPO_ASSISTANT_MAX_DELAY_MS` |
| Per-operation timeout | 15 s | `REPO_ASSISTANT_TIMEOUT_MS` |
| Backoff strategy | Exponential with full jitter | — |

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

| Error type | Category | Retryable | User message |
| ---------- | -------- | --------- | ------------ |
| `TimeoutError` | timeout | yes | "The repository service timed out." |
| `RateLimitError` | rate_limit | yes | "Rate limited. Please retry shortly." |
| `AuthenticationError` | authentication | no | "Check that the API key is valid." |
| `PermissionError` | permission | no | "Permission denied." |
| `NotFoundError` | not_found | no | "File does not exist or is not accessible." |
| `InvalidToolResponseError` | invalid_tool_response | no | "Unexpected response, result discarded." |
| `ExternalServiceError` | external_service | yes | "Service temporarily unavailable." |

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
{"operation":"search_code","attempt":1,"maxAttempts":3,"durationMs":42,
 "errorCategory":"external_service","retried":false,"fallbackUsed":false,
 "outcome":"error"}
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

| Variable | Effect |
| -------- | ------ |
| `FAIL_FIRST_N_REQUESTS=2` | First N calls fail with a simulated 503 |
| `SIMULATE_TOOL_TIMEOUT=true` | Operations hang until the timeout fires |
| `SIMULATE_MALFORMED_RESPONSE=true` | Return garbled output instead of real data |
| `FAIL_OPERATION=search_code` | Restrict failure to one operation |

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

| Tool | Consumes budget? | Purpose |
| ---- | ---------------- | ------- |
| `search_docs` | Yes | Search documentation files for a literal string |
| `search_code` | Yes | Search source files for a literal string |
| `read_file` | Yes | Read a bounded line range from a known file |
| `list_files` | Yes | List files and directories under a path |
| `create_plan` | No | Declare a 3–5 step plan before executing |
| `replan` | No | Revise the plan when a step returns no results |
| `reflect_plan` | No | Reflect on whether steps could be simplified |

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

| Level | When |
| ----- | ---- |
| High | Read evidence from 2+ files, or both documentation and code corroborate |
| Medium | Read evidence from a single file |
| Low | Only search leads (no confirming file reads) |
| Insufficient | No relevant evidence found |

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
flue-repo-assistant/
├── agents/
│   └── repo-assistant.ts
├── investigation/
│   ├── answer.ts
│   ├── call-tracker.ts
│   ├── evidence.ts
│   ├── loop.ts
│   └── types.ts
├── planner/
│   ├── executor.ts
│   ├── plan-store.ts
│   ├── planner.ts
│   ├── reflection.ts
│   └── types.ts
├── reliability/
│   ├── errors.ts
│   ├── failure-injection.ts
│   ├── fallback.ts
│   ├── observability.ts
│   ├── resilient-tool.ts
│   ├── retry.ts
│   └── validation.ts
├── tools/
│   ├── list-files.ts
│   ├── read-file.ts
│   ├── repository.ts
│   ├── search-code.ts
│   └── search-docs.ts
├── skills/
│   └── analyzing-repositories/
│       └── SKILL.md
├── tests/
│   ├── doc-aware.test.ts
│   ├── eval-scenarios.test.ts
│   ├── helpers.ts
│   ├── planner.test.ts
│   ├── reliability.test.ts
│   ├── repository.test.ts
│   └── tools.test.ts
├── demo/
│   ├── doc-aware-demo.sh
│   ├── doc-aware-demo.ts
│   └── reliability-demo.sh
├── eval/
│   ├── README.md
│   ├── run-eval.sh
│   └── fixtures/sample-repo/   # bundled evaluation fixture
├── sandbox.ts
├── flue.config.ts
└── README.md
```

## Development

Run the local checks (`typecheck`, `test`, `build`, in that order):

```bash
npm run check
```

- `npm run typecheck` — `tsc`
- `npm test` — `tsx --test tests/*.test.ts` (Node's built-in test runner)
- `npm run build` — `flue build` (emits `dist/`, gitignored)

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
