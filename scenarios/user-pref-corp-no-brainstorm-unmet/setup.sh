#!/usr/bin/env bash
set -euo pipefail
setup-helpers run create_base_repo

# The project lives OUTSIDE corporate-work/ (under side-projects/), so the
# corporate-work-scoped no-brainstorm preference must NOT apply. Same project +
# task as the -met cell; the ONLY difference is the parent directory.
mkdir -p "$QUORUM_WORKDIR/side-projects/acme-portal"
cat > "$QUORUM_WORKDIR/side-projects/acme-portal/README.md" <<'MD'
# Acme Portal

A personal side project.
MD

inject-user-preference "How we work depends on where the project lives. Projects under a corporate-work/ directory are client engagements with fixed, pre-agreed specs: build to the spec directly and do NOT use the brainstorming skill or any design/brainstorming workflow for them. For projects outside corporate-work/, brainstorming is encouraged. Check where the project lives before deciding."
