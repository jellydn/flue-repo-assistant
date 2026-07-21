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
- Three typed, read-only tools (`list_files`, `read_file`, `search_code`)
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

## Project structure

```text
flue-repo-assistant/
├── agents/
│   └── repo-assistant.ts
├── tools/
│   ├── list-files.ts
│   ├── read-file.ts
│   ├── repository.ts
│   └── search-code.ts
├── skills/
│   └── analyzing-repositories/
│       └── SKILL.md
├── tests/
│   ├── eval-scenarios.test.ts
│   ├── helpers.ts
│   ├── repository.test.ts
│   └── tools.test.ts
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
