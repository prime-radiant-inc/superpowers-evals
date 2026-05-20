#!/usr/bin/env bash
# Standard Svelte project artifacts: a package.json and either a
# svelte.config.js or a vite.config.ts.
set -euo pipefail
test -f "$HARNESS_WORKDIR/package.json"
test -f "$HARNESS_WORKDIR/svelte.config.js" \
  || test -f "$HARNESS_WORKDIR/vite.config.ts"
echo "PASS: package.json + svelte/vite config present"
