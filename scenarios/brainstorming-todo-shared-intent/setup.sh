#!/usr/bin/env bash
set -euo pipefail
setup-helpers run init_repo_from_fixtures
bun "$QUORUM_REPO_ROOT/src/cli/brainstorming-evidence.ts" install "$QUORUM_WORKDIR"
