#!/usr/bin/env bash
set -euo pipefail
# HARNESS_WORKDIR is the temp workdir set by harness.setup_step.
# HARNESS_REPO_ROOT is the harness checkout (where fixtures/ lives),
# set by harness.runner. setup_helpers.create_base_repo needs both.
uv run python -c "
import os, pathlib
from setup_helpers.base import create_base_repo
wd = pathlib.Path(os.environ['HARNESS_WORKDIR'])
template = pathlib.Path(os.environ['HARNESS_REPO_ROOT']) / 'fixtures' / 'template-repo'
create_base_repo(wd, template)
"

# Fixture invariants: bail if the helper didn't leave us in the expected
# state. Drill enforced these via setup.assertions; setup.sh's non-zero
# exit is the harness-native equivalent (harness/setup_step.py aborts
# the run with the captured stderr).
git -C "$HARNESS_WORKDIR" rev-parse --is-inside-work-tree >/dev/null
test "$(git -C "$HARNESS_WORKDIR" branch --show-current)" = "main"
