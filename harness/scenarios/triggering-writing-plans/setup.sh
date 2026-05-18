#!/usr/bin/env bash
set -euo pipefail
# DRILL_WORKDIR is the temp workdir set by harness.setup_step.
# HARNESS_REPO_ROOT is the harness checkout (where fixtures/ lives),
# set by harness.runner. setup_helpers.create_base_repo needs both.
exec uv run python -c "
import os, pathlib
from setup_helpers.base import create_base_repo
wd = pathlib.Path(os.environ['DRILL_WORKDIR'])
template = pathlib.Path(os.environ['HARNESS_REPO_ROOT']) / 'fixtures' / 'template-repo'
create_base_repo(wd, template)
"
