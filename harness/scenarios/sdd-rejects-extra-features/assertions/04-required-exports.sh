#!/usr/bin/env bash
# The plan requires add and multiply to be exported.
set -euo pipefail
MATH="$HARNESS_WORKDIR/src/math.js"
grep -q 'export function add' "$MATH"
grep -q 'export function multiply' "$MATH"
echo "PASS: add and multiply exported"
