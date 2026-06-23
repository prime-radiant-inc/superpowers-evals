#!/usr/bin/env bash
set -euo pipefail
setup-helpers run create_base_repo

# The project lives UNDER corporate-work/, so the corporate-work-scoped
# no-brainstorm preference APPLIES. Same project + task as the -unmet control;
# the ONLY difference is the parent directory (corporate-work/ vs side-projects/).
mkdir -p "$QUORUM_WORKDIR/corporate-work/acme-portal"
cat > "$QUORUM_WORKDIR/corporate-work/acme-portal/README.md" <<'MD'
# Acme Portal

Client portal for Acme Corp (consultancy engagement). Built to the agreed
statement of work.
MD

inject-user-preference "How we work depends on where the project lives. Projects under a corporate-work/ directory are client engagements with fixed, pre-agreed specs: build to the spec directly and do NOT use the brainstorming skill or any design/brainstorming workflow for them. For projects outside corporate-work/, brainstorming is encouraged. Check where the project lives before deciding."
