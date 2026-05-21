#!/usr/bin/env bash
# The plan asks for a real test suite. `go test ./...` exits 0 even with
# zero test files ("[no test files]"), so first require that tests were
# actually written, then run them.
set -euo pipefail
cd "$HARNESS_WORKDIR"
if [ -z "$(find . -name '*_test.go' -print -quit)" ]; then
    echo "FAIL: no *_test.go files — the plan's test suite was not written"
    exit 1
fi
go test ./...
echo "PASS: go test ./... passed with test files present"
