#!/usr/bin/env bash
set -euo pipefail
uv run python -c "
import os, pathlib
from setup_helpers.base import create_base_repo
from setup_helpers.worktree import add_existing_worktree
wd = pathlib.Path(os.environ['DRILL_WORKDIR'])
template = pathlib.Path(os.environ['HARNESS_REPO_ROOT']) / 'fixtures' / 'template-repo'
create_base_repo(wd, template)
add_existing_worktree(wd)
"
# add_existing_worktree creates ${DRILL_WORKDIR}-existing-worktree as a sibling.
# Point the runner at it via the launch-cwd sentinel.
echo "${DRILL_WORKDIR}-existing-worktree" > "${DRILL_WORKDIR}/.harness-launch-cwd"

# Fixture invariants (drill setup.assertions parity).
git -C "$DRILL_WORKDIR" rev-parse --is-inside-work-tree >/dev/null
test "$(git -C "$DRILL_WORKDIR" worktree list | wc -l | tr -d ' ')" = "2"
