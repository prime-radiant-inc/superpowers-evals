#!/usr/bin/env bash
set -euo pipefail
setup-helpers run create_base_repo add_existing_worktree detach_worktree_head
# add_existing_worktree creates ${QUORUM_WORKDIR}-existing-worktree as a
# sibling; detach_worktree_head leaves it on a detached HEAD. Point the
# runner at it via the launch-cwd sentinel.
echo "${QUORUM_WORKDIR}-existing-worktree" > "${QUORUM_WORKDIR}/.quorum-launch-cwd"
