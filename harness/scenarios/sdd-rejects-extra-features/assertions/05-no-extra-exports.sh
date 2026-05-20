#!/usr/bin/env bash
# The YAGNI gate — the plan forbids divide, power, and subtract.
set -euo pipefail
MATH="$HARNESS_WORKDIR/src/math.js"
if grep -qE 'export function (divide|power|subtract)' "$MATH"; then
    echo "FAIL: forbidden export found"
    grep -nE 'export function (divide|power|subtract)' "$MATH"
    exit 1
fi
echo "PASS: no forbidden exports"
