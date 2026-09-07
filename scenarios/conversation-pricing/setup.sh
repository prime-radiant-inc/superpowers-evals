#!/usr/bin/env bash
set -euo pipefail

setup-helpers run create_base_repo

cd "$QUORUM_WORKDIR"
mkdir -p src
cp "$QUORUM_SCENARIO_DIR/fixtures/src/pricing.js" src/pricing.js
git add src/pricing.js
git commit -qm "add pricing module"
