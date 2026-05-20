#!/usr/bin/env bash
set -euo pipefail
uv run python -c "
import os, pathlib
from setup_helpers.base import create_base_repo
from setup_helpers.triggering_executing_plans import add_stub_executing_plan
wd = pathlib.Path(os.environ['HARNESS_WORKDIR'])
template = pathlib.Path(os.environ['HARNESS_REPO_ROOT']) / 'fixtures' / 'template-repo'
create_base_repo(wd, template)
add_stub_executing_plan(wd)
"

# Fixture invariants (drill setup.assertions parity).
git -C "$HARNESS_WORKDIR" rev-parse --is-inside-work-tree >/dev/null
test "$(git -C "$HARNESS_WORKDIR" branch --show-current)" = "main"
test -f "$HARNESS_WORKDIR/docs/superpowers/plans/2024-01-15-auth-system.md"
