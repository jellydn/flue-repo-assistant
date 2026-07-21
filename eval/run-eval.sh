#!/usr/bin/env bash
# Run the five Day-16 evaluation scenarios against the bundled fixture repo.
#
# Each scenario prints its prompt and expected tool pattern, then invokes the
# flue-repo-assistant agent with REPOSITORY_PATH pointed at the fixture and
# REPO_ASSISTANT_DEBUG=true so the actual tool sequence is logged to stderr
# (one safe line per tool call: tool name, sanitized input, status, budget).
#
# Usage:
#   eval/run-eval.sh                 # uses .env / defaults
#   REPO_ASSISTANT_MODEL=... eval/run-eval.sh
#
# Requires a provider API key (e.g. OPENROUTER_API_KEY) in the environment.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
FIXTURE="${SCRIPT_DIR}/fixtures/sample-repo"

cd "${REPO_ROOT}"

run_scenario() {
  local label="$1"
  local prompt="$2"
  local expected="$3"
  echo
  echo "============================================================"
  echo "Scenario ${label}"
  echo "Prompt:    ${prompt}"
  echo "Expected:  ${expected}"
  echo "------------------------------------------------------------"
  REPOSITORY_PATH="${FIXTURE}" \
  REPO_ASSISTANT_DEBUG=true \
  REPO_ASSISTANT_MAX_STEPS=8 \
  npm start --silent -- --input "$(printf '{"message":%s}' "$(node -e "process.stdout.write(JSON.stringify(process.argv[1]))" "${prompt}")")" \
    2>&1 || true
  echo "============================================================"
}

run_scenario "A: direct read" \
  "Read src/config.ts and explain how the application port is configured." \
  "read_file"

run_scenario "B: search then read" \
  "Find where user authentication is implemented and explain the flow." \
  "search_code -> read_file"

run_scenario "C: structure discovery" \
  "Give me a high-level overview of this repository." \
  "list_files -> selected read_file calls"

run_scenario "D: negative search" \
  "Where is payment processing implemented?" \
  "search_code -> read_file; report no evidence, do not invent"

run_scenario "E: no unnecessary tool" \
  "What is the difference between listing files and searching code?" \
  "answer directly, no tool call"

echo
echo "Done. Inspect the [repo-assistant] log lines above for the observed tool sequence."
