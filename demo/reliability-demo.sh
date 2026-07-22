#!/usr/bin/env bash
# Day 18 reliability demo: injects failures to show retry, timeout, and
# fallback behaviour.
#
# Usage:
#   demo/reliability-demo.sh          # run all scenarios
#   demo/reliability-demo.sh 1        # run only scenario 1
#
# Requires a provider API key (e.g. OPENROUTER_API_KEY) in the environment
# for live LLM runs. Without a key, the deterministic tests in
#   tests/reliability.test.ts
# demonstrate the same behaviour.
#
# Scenarios:
#   1. Transient failure recovery (FAIL_FIRST_N_REQUESTS=2)
#   2. Timeout simulation (SIMULATE_TOOL_TIMEOUT=true)
#   3. Malformed response (SIMULATE_MALFORMED_RESPONSE=true)
#   4. No failure (baseline)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
FIXTURE="${REPO_ROOT}/eval/fixtures/sample-repo"

cd "${REPO_ROOT}"

run_scenario() {
  local id="$1"
  local label="$2"
  shift 2
  echo
  echo "============================================================"
  echo "Demo scenario ${id}: ${label}"
  echo "------------------------------------------------------------"
  REPOSITORY_PATH="${FIXTURE}" \
  REPO_ASSISTANT_DEBUG=true \
  REPO_ASSISTANT_MAX_STEPS=8 \
  REPO_ASSISTANT_MAX_ATTEMPTS=3 \
  REPO_ASSISTANT_TIMEOUT_MS=3000 \
  "$@" \
  npm start --silent -- --input '{"message":"Read src/config.ts and explain how the port is configured."}' \
    2>&1 || true
  echo "============================================================"
}

SCENARIO="${1:-all}"

if [[ "${SCENARIO}" == "all" || "${SCENARIO}" == "1" ]]; then
  run_scenario 1 "Recover from transient failure" \
    FAIL_FIRST_N_REQUESTS=2
fi

if [[ "${SCENARIO}" == "all" || "${SCENARIO}" == "2" ]]; then
  run_scenario 2 "Timeout (tool hangs, retry fires)" \
    SIMULATE_TOOL_TIMEOUT=true \
    FAIL_OPERATION=search_code \
    REPO_ASSISTANT_TIMEOUT_MS=1000
fi

if [[ "${SCENARIO}" == "all" || "${SCENARIO}" == "3" ]]; then
  run_scenario 3 "Malformed response (validation rejects)" \
    SIMULATE_MALFORMED_RESPONSE=true \
    FAIL_OPERATION=search_code
fi

if [[ "${SCENARIO}" == "all" || "${SCENARIO}" == "4" ]]; then
  run_scenario 4 "Baseline (no injected failures)"
fi

echo
echo "Done. Inspect the [repo-assistant:reliability] log lines for retry"
echo "attempt counts, durations, error categories, and outcomes."
