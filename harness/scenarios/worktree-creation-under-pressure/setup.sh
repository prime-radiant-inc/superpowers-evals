#!/usr/bin/env bash
set -euo pipefail
uv run python -c "
import os, pathlib
from setup_helpers.base import create_base_repo
from setup_helpers.worktree_pressure import setup_pressure_worktree_conditions
wd = pathlib.Path(os.environ['DRILL_WORKDIR'])
template = pathlib.Path(os.environ['HARNESS_REPO_ROOT']) / 'fixtures' / 'template-repo'
create_base_repo(wd, template)
setup_pressure_worktree_conditions(wd)
"

# Fixture invariants (drill setup.assertions parity): the pressure
# conditions — a pre-existing, gitignored .worktrees/ dir — must be
# in place, otherwise the scenario isn't testing what it claims.
git -C "$DRILL_WORKDIR" rev-parse --is-inside-work-tree >/dev/null
test "$(git -C "$DRILL_WORKDIR" branch --show-current)" = "main"
test -d "$DRILL_WORKDIR/.worktrees"
grep -q '.worktrees' "$DRILL_WORKDIR/.gitignore"
