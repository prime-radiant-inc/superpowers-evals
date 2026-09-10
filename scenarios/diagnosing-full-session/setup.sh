#!/usr/bin/env bash
set -euo pipefail

setup-helpers run create_cost_clean_repo
bun "$QUORUM_REPO_ROOT/src/cli/diagnosis-fixtures.ts" install "$QUORUM_SCENARIO_DIR/history/$QUORUM_CODING_AGENT/manifest.json" "$QUORUM_SCENARIO_DIR/history/$QUORUM_CODING_AGENT"
git add -A
if ! git diff --cached --quiet; then
  git commit -m "fixture: add historical diagnosis artifacts"
fi
