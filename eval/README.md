# Day 16 evaluation: Tools for agents

This directory contains a small, deterministic fixture repository and a runner
for the five Day-16 evaluation scenarios. The scenarios exercise **tool
selection**: picking the right tool, combining tools, skipping tools when
context is enough, consuming structured results, and handling negative results
without fabricating features.

## Fixture repository

`fixtures/sample-repo/` contains:

| File | Role |
| ---- | ---- |
| `src/index.ts` | Application entry point (calls `start` and `login`) |
| `src/config.ts` | Configuration module (port via `process.env.PORT ?? 3000`) |
| `src/auth.ts` | Authentication module (calls `user-service`) |
| `src/services/user-service.ts` | Service calling another module (`issueToken`) |
| `src/utils/notes.md` | Unrelated file with misleading keywords (`payment`, `billing`) |
| `node_modules/ignored.js` | Dependency noise that must be skipped |

It is intentionally tiny so the tool sequence—not the answer depth—is the
thing under observation.

## Running the scenarios

```bash
# from the project root, with a provider key exported (e.g. OPENROUTER_API_KEY)
./eval/run-eval.sh
```

The script points `REPOSITORY_PATH` at the fixture and enables
`REPO_ASSISTANT_DEBUG=true`. Each tool call logs one safe line to stderr:

```
[repo-assistant] read_file success input={"path":"src/config.ts",...} count=4 used=1 remaining=7/8
```

The `[repo-assistant] <tool> <status>` prefixes are the **observed tool
sequence** for that scenario.

## Scenarios

| Scenario | Prompt | Expected tool pattern |
| -------- | ------ | --------------------- |
| A: direct read | Read `src/config.ts` and explain how the application port is configured. | `read_file` |
| B: search then read | Find where user authentication is implemented and explain the flow. | `search_code` → `read_file` (extra reads allowed to trace the flow) |
| C: structure discovery | Give me a high-level overview of this repository. | `list_files` → selected `read_file` calls |
| D: negative search | Where is payment processing implemented? | `search_code` → `read_file`; report no evidence, do not invent a payment subsystem |
| E: no unnecessary tool | What is the difference between listing files and searching code? | Answer directly, no tool call |

## Deterministic vs. live observation

Flue's model calls cannot be inspected deterministically without a live
provider key, and model choices are non-deterministic. This evaluation
therefore has two layers:

1. **Deterministic simulation** — `tests/eval-scenarios.test.ts` drives each
   scenario's expected tool sequence directly against the tool contracts and
   asserts the structured results and budget behavior. Run with `npm test`.
2. **Live model observation** — `run-eval.sh` runs the real agent against the
   fixture and prints the observed `[repo-assistant]` tool-call lines. Record
   the observed sequence in the table above during a live run.

We do not fake automated LLM assertions. The deterministic test proves the
tool contracts support each pattern; the live run shows what the model
actually chose.

## Observed sequences

The sequences below were produced by driving the tool contracts directly
against the on-disk fixture with `REPO_ASSISTANT_DEBUG=true` (the same code path
the agent uses). They are the **expected** sequences a correct model should
produce; a live LLM run with `./run-eval.sh` should match them up to extra
read calls allowed by the budget.

```
--- Scenario A ---
[repo-assistant] read_file success input={"path":"src/config.ts","startLine":1} count=6 used=1 remaining=7/8

--- Scenario B ---
[repo-assistant] search_code success input={"query":"login","path":".","caseSensitive":false} count=3 used=2 remaining=6/8
[repo-assistant] read_file success input={"path":"src/auth.ts","startLine":1} count=7 used=3 remaining=5/8

--- Scenario C ---
[repo-assistant] list_files success input={"path":".","depth":3} count=8 used=4 remaining=4/8

--- Scenario D ---
[repo-assistant] search_code success input={"query":"payment","path":".","caseSensitive":false} count=1 used=5 remaining=3/8
# the single match is src/utils/notes.md (misleading keywords, no implementation)

--- Scenario E: no tool call ---
budget used: 0 remaining: 8
```

A live model-driven run was not executed here because this environment has no
provider API key. Run `./run-eval.sh` with a key to record the model's actual
choices; compare them against the sequences above.

## Day 17: Planning vs Execution

The agent now follows a **plan → execute → reflect** workflow. The eval
scenarios above are still valid, but the observed debug output will include
`create_plan` before the first inspection tool and `reflect_plan` at the end:

```
[repo-assistant] create_plan success input={"question":"...","stepCount":3} count=3 used=0 remaining=8/8
[repo-assistant] search_code success ... used=1 remaining=7/8
[repo-assistant] read_file success ... used=2 remaining=6/8
[repo-assistant] reflect_plan success ... used=2 remaining=6/8
```

If a search returns no results, a `replan` line appears:

```
[repo-assistant] replan success input={"reason":"...","stepCount":2} count=2 used=N remaining=M/8
```

The planning tools (`create_plan`, `replan`, `reflect_plan`) do NOT consume the
inspection budget—they structure the agent's reasoning without inspecting the
repository.
