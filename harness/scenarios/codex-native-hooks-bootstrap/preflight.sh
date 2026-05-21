#!/usr/bin/env bash
# Fixture invariants — a plain repo with NO legacy .agents superpowers
# symlink. Bootstrapping must come from the native plugin hook (seeded
# into the per-run CODEX_HOME by the runner), not the symlink.
set -euo pipefail
git -C "$HARNESS_WORKDIR" rev-parse --is-inside-work-tree >/dev/null
test "$(git -C "$HARNESS_WORKDIR" branch --show-current)" = "main"
test ! -e "$HARNESS_WORKDIR/.agents/skills/superpowers"
