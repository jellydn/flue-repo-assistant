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

To inspect another checkout:

```bash
REPOSITORY_PATH=/absolute/path/to/repo \
  npm start -- --input '{"message":"Explain this project's architecture."}'
```

## How the bound works

Every `list_files`, `read_file`, or `search_code` call consumes one shared
inspection step. Tool results include `used` and `remaining`; after the limit,
all three tools reject further calls and the instructions require the agent to
answer from collected evidence. The agent also configures a 120-second
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
│   └── repository.test.ts
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
