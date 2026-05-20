#!/usr/bin/env bash
# The plan asks for a passing `go test ./...` at the end.
set -euo pipefail
cd "$HARNESS_WORKDIR"
exec go test ./...
