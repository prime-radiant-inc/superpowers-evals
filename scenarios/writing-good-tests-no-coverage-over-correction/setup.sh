#!/usr/bin/env bash
set -euo pipefail
# Seeds cart-service from scenarios/<name>/fixtures/: package.json, README.md,
# and src/cart.js with NO quantity validation and NO pre-existing test. The
# agent adds the over-limit check AND ships a real test for it.
setup-helpers run init_repo_from_fixtures
