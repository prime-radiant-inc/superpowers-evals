#!/usr/bin/env bash
# The plan delivers a cmd/fractals/main.go entry point.
set -euo pipefail
test -f "$HARNESS_WORKDIR/cmd/fractals/main.go"
echo "PASS: cmd/fractals/main.go exists"
