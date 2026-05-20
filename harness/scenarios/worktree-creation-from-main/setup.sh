#!/usr/bin/env bash
set -euo pipefail
uv run python -c "
import os, pathlib
from setup_helpers.base import create_base_repo
wd = pathlib.Path(os.environ['HARNESS_WORKDIR'])
template = pathlib.Path(os.environ['HARNESS_REPO_ROOT']) / 'fixtures' / 'template-repo'
create_base_repo(wd, template)
"

# Fixture invariants (drill setup.assertions parity).
git -C "$HARNESS_WORKDIR" rev-parse --is-inside-work-tree >/dev/null
test "$(git -C "$HARNESS_WORKDIR" branch --show-current)" = "main"
test "$(git -C "$HARNESS_WORKDIR" worktree list | wc -l | tr -d ' ')" = "1"
