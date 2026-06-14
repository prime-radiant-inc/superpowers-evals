#!/usr/bin/env bash
set -euo pipefail
setup-helpers run create_base_repo add_existing_worktree
# add_existing_worktree creates ${QUORUM_WORKDIR}-existing-worktree as a
# sibling; point the runner at it via the launch-cwd sentinel.
echo "${QUORUM_WORKDIR}-existing-worktree" > "${QUORUM_WORKDIR}/.quorum-launch-cwd"
