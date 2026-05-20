#!/usr/bin/env bash
# The plan asks for Playwright e2e coverage. --no-install: the e2e
# browsers must already be present from plan execution, not pulled now.
set -euo pipefail
cd "$HARNESS_WORKDIR"
exec npx --no-install playwright test
