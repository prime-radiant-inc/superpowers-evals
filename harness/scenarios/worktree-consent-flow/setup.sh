#!/usr/bin/env bash
set -euo pipefail
uv run python -c "
import os, pathlib
from setup_helpers.base import create_base_repo
wd = pathlib.Path(os.environ['DRILL_WORKDIR'])
template = pathlib.Path(os.environ['HARNESS_REPO_ROOT']) / 'fixtures' / 'template-repo'
create_base_repo(wd, template)
"

# Fixture invariants (drill setup.assertions parity).
git -C "$DRILL_WORKDIR" rev-parse --is-inside-work-tree >/dev/null
test "$(git -C "$DRILL_WORKDIR" branch --show-current)" = "main"
