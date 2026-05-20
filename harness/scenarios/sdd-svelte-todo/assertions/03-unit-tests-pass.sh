#!/usr/bin/env bash
# The plan asks for a passing `npm test` (unit tests).
set -euo pipefail
cd "$HARNESS_WORKDIR"
exec npm test
