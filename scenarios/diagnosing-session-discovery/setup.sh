#!/usr/bin/env bash
set -euo pipefail

bun "$QUORUM_REPO_ROOT/src/cli/session-discovery-fixtures.ts" install "$QUORUM_SCENARIO_DIR/history/$QUORUM_CODING_AGENT"
setup-helpers run create_cost_clean_repo
