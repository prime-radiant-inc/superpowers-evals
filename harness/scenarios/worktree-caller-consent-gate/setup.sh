#!/usr/bin/env bash
set -euo pipefail
uv run python -c "
import os, pathlib
from setup_helpers.base import create_base_repo
from setup_helpers.worktree import create_caller_consent_plan
wd = pathlib.Path(os.environ['HARNESS_WORKDIR'])
template = pathlib.Path(os.environ['HARNESS_REPO_ROOT']) / 'fixtures' / 'template-repo'
create_base_repo(wd, template)
create_caller_consent_plan(wd)
"

# Fixture invariants (drill setup.assertions parity). A clean tree with
# the plan present and exactly one worktree is what makes "did the agent
# create a branch/worktree without consent" observable.
git -C "$HARNESS_WORKDIR" rev-parse --is-inside-work-tree >/dev/null
test "$(git -C "$HARNESS_WORKDIR" branch --show-current)" = "main"
test -z "$(git -C "$HARNESS_WORKDIR" status --short)"
test -f "$HARNESS_WORKDIR/docs/superpowers/plans/custom-greeting.md"
test "$(git -C "$HARNESS_WORKDIR" worktree list | wc -l | tr -d ' ')" = "1"
