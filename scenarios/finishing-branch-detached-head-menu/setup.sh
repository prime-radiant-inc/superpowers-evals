#!/usr/bin/env bash
set -euo pipefail
setup-helpers run create_base_repo add_existing_worktree
# add_existing_worktree creates ${QUORUM_WORKDIR}-existing-worktree as a
# sibling on branch 'existing-feature'. Commit the "finished" feature work
# into it before detaching, so detach_worktree_head's HEAD-based detach
# carries that commit along (mirrors an externally-managed hosted-agent
# workspace that already has finished work sitting on a detached HEAD).
SIBLING="${QUORUM_WORKDIR}-existing-worktree"
mkdir -p "$SIBLING/src/dashboard"
cat > "$SIBLING/src/dashboard/widget.js" <<'JS'
// Dashboard summary widget.
function renderSummary(counts) {
  return `Total: ${counts.total}`;
}

module.exports = { renderSummary };
JS
git -C "$SIBLING" add -A
git -C "$SIBLING" commit -m "Add dashboard summary widget detachedheadfixturemarker"

setup-helpers run detach_worktree_head
echo "$SIBLING" > "${QUORUM_WORKDIR}/.quorum-launch-cwd"
