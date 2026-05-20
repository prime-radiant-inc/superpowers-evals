#!/usr/bin/env bash
# The plan asks for a passing `npm test`.
set -euo pipefail
cd "$HARNESS_WORKDIR"
exec npm test
