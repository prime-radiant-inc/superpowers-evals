#!/usr/bin/env bash
set -euo pipefail
setup-helpers run create_base_repo add_existing_worktree record_head
# Launch the Coding-Agent inside the existing worktree. pre()/post()
# still run from the primary workdir (the main checkout).
echo "${QUORUM_WORKDIR}-existing-worktree" > "${QUORUM_WORKDIR}/.quorum-launch-cwd"
