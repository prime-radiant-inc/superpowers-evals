#!/usr/bin/env bash
set -euo pipefail
setup-helpers run create_base_repo

# Inject the "no git worktrees" preference into the ambient instructions file
# THIS agent honors. Must suppress using-git-worktrees. Control = the existing
# worktree-creation-from-main scenario (no preference → worktree created).
inject-user-preference "Do not use git worktrees on this project. Work directly in the main checkout — do not create, add, or switch to a separate worktree or workspace."
