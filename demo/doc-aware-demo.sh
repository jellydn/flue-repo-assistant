#!/usr/bin/env bash
# Day 21 demo: doc-aware repository agent.
#
# Runs a deterministic investigation loop (no LLM required) against the
# bundled fixture repository. Shows how the agent combines search_docs,
# search_code, and read_file to produce grounded answers with citations.
#
# Usage:
#   demo/doc-aware-demo.sh              # all scenarios
#   demo/doc-aware-demo.sh auth         # only auth-related scenarios
#   demo/doc-aware-demo.sh payment      # only the negative-search scenario

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${REPO_ROOT}"
exec npx tsx demo/doc-aware-demo.ts "$@"
