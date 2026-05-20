#!/usr/bin/env bash
set -euo pipefail
exec uv run python -c "
import os, pathlib
from setup_helpers.base import create_base_repo
from setup_helpers.worktree import symlink_superpowers
wd = pathlib.Path(os.environ['HARNESS_WORKDIR'])
template = pathlib.Path(os.environ['HARNESS_REPO_ROOT']) / 'fixtures' / 'template-repo'
create_base_repo(wd, template)
symlink_superpowers(wd, os.environ['SUPERPOWERS_ROOT'])
"
